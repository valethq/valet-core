import { describe, expect, test } from "bun:test";
import { type Caller, EventHookError, type HookOptions, type Logger, ServiceDeniedError } from "@valethq/sdk";
import { createCoreBus, type HookErrorReport } from "../src/bus";

declare module "@valethq/sdk" {
  interface ValetEvents {
    "test.message": { text: string };
    "test.count": number;
    "test.frozen": { outer: { inner: number } };
    "test.slow": { ms: number };
    "test.deep": { n: number };
    "test.parent": { n: number };
    "test.guarded": { n: number };
    "ui.inner": { n: number };
    "exec.output": { chunk: string };
  }
  interface ValetSignals {
    "test.tick": { n: number };
    "exec.tick": { n: number };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function captureLog(): { logger: Logger; warnings: string[]; errors: string[] } {
  const warnings: string[] = [];
  const errors: string[] = [];
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: (msg) => {
      warnings.push(msg);
    },
    error: (msg) => {
      errors.push(msg);
    },
  };
  return { logger, warnings, errors };
}

// ---------------------------------------------------------------------------
// Ported from reference/test/event-bus.test.ts (7.1 semantics)
// ---------------------------------------------------------------------------

describe("reference semantics", () => {
  test("runs before hooks by priority and lets them replace the payload", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    const calls: string[] = [];

    test_.before(
      "test.message",
      (event) => {
        calls.push("low");
        event.payload = { text: `${event.payload.text}!` };
      },
      { priority: 1 },
    );
    test_.before(
      "test.message",
      (event) => {
        calls.push("high");
        event.payload = { text: event.payload.text.trim() };
      },
      { priority: 10 },
    );

    const result = await test_.emit("test.message", { text: " hello " });

    expect(calls).toEqual(["high", "low"]);
    expect(result).toEqual({ payload: { text: "hello!" }, cancelled: false });
  });

  test("stops remaining before hooks when cancelled but always runs after hooks", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    const calls: string[] = [];

    test_.before("test.count", (event) => {
      calls.push("cancel");
      event.cancel("nope");
    });
    test_.before(
      "test.count",
      () => {
        calls.push("skipped");
      },
      { priority: -1 },
    );
    test_.after("test.count", (event) => {
      expect(event.cancelled).toBe(true);
      calls.push("after");
    });

    const result = await test_.emit("test.count", 42);

    expect(calls).toEqual(["cancel", "after"]);
    expect(result).toEqual({ payload: 42, cancelled: true, cancelReason: "nope" });
  });

  test("supports once hooks and disconnectable subscriptions", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    let onceCalls = 0;
    let regularCalls = 0;

    test_.before(
      "test.count",
      () => {
        onceCalls += 1;
      },
      { once: true },
    );
    const subscription = test_.before("test.count", () => {
      regularCalls += 1;
    });

    await test_.emit("test.count", 1);
    subscription.disconnect();
    await test_.emit("test.count", 2);

    expect(onceCalls).toBe(1);
    expect(regularCalls).toBe(1);
    expect(subscription.active).toBe(false);
    expect(bus.listenerCount("test.count")).toBe(0);
  });

  test("wraps failures with event, phase, and plugin context", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    bus.forPlugin("valet-memory").before("test.message", () => {
      throw new Error("database is down");
    });

    try {
      await test_.emit("test.message", { text: "hi" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EventHookError);
      const hookError = error as EventHookError;
      expect(hookError.eventName).toBe("test.message");
      expect(hookError.phase).toBe("before");
      expect(hookError.plugin).toBe("valet-memory");
      expect((hookError.cause as Error).message).toBe("database is down");
    }
  });
});

// ---------------------------------------------------------------------------
// 7.2 changes from the prototype
// ---------------------------------------------------------------------------

describe("1. caller stamping and subscription tracking", () => {
  test("stamps caller.plugin from the emitting plugin's view", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    let seen: Caller | undefined;
    bus.forPlugin("valet-ui").before("test.message", (e) => {
      seen = e.caller;
    });

    await test_.emit("test.message", { text: "x" });

    expect(seen?.plugin).toBe("valet-test");
  });

  test("disposeAll disconnects hooks, signal listeners and restrictions", async () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");
    const test_ = bus.forPlugin("valet-test");
    let hooked = 0;
    let signaled = 0;
    exec.before("test.message", () => {
      hooked += 1;
    });
    exec.onSignal("test.tick", () => {
      signaled += 1;
    });
    exec.restrict(() => false);

    exec.disposeAll();

    await test_.emit("test.message", { text: "x" });
    test_.signal("test.tick", { n: 1 });
    expect(hooked).toBe(0);
    expect(signaled).toBe(0);
    expect(bus.listenerCount("test.message")).toBe(0);
    // The restriction is gone, so a previously refused plugin can subscribe now.
    expect(() => bus.forPlugin("valet-spy").before("exec.output", () => {})).not.toThrow();
  });
});

describe("2. after-hook failures are isolated", () => {
  test("a failing after hook is reported and logged; emit resolves and later hooks run", async () => {
    const { logger, errors } = captureLog();
    const reports: HookErrorReport[] = [];
    const bus = createCoreBus({ logger, onHookError: (r) => reports.push(r) });
    const test_ = bus.forPlugin("valet-test");
    let secondRan = false;

    bus.forPlugin("valet-ui").after("test.message", () => {
      throw new Error("ui broke");
    });
    bus.forPlugin("valet-stats").after("test.message", () => {
      secondRan = true;
    });

    const result = await test_.emit("test.message", { text: "x" });

    expect(result.cancelled).toBe(false);
    expect(secondRan).toBe(true);
    expect(reports).toHaveLength(1);
    const report = reports[0];
    expect(report).toMatchObject({
      eventName: "test.message",
      phase: "after",
      plugin: "valet-ui",
    });
    expect(report?.error).toBeInstanceOf(EventHookError);
    expect(errors).toHaveLength(1);
  });

  test("a before-hook failure still rejects emit and the action does not happen", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    let afterRan = false;
    test_.before("test.count", () => {
      throw new Error("policy bug");
    });
    test_.after("test.count", () => {
      afterRan = true;
    });

    await expect(test_.emit("test.count", 1)).rejects.toBeInstanceOf(EventHookError);
    expect(afterRan).toBe(false);
  });
});

describe("3. one hook snapshot per emit", () => {
  test("a hook registered during the before phase does not run in that emit's after phase", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    const calls: string[] = [];
    let registered = false;

    test_.before("test.count", () => {
      if (registered) return;
      registered = true;
      test_.after("test.count", () => {
        calls.push("late-after");
      });
    });

    await test_.emit("test.count", 1);
    expect(calls).toEqual([]);

    await test_.emit("test.count", 2);
    expect(calls).toEqual(["late-after"]);
  });
});

describe("4. typed before/after registration", () => {
  test("before gets a mutable BeforeEvent, after gets an immutable AfterEvent, and there is no on()", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    const phases: string[] = [];

    test_.before("test.count", (e) => {
      phases.push(e.phase);
      expect(typeof e.cancel).toBe("function");
      expect(typeof e.deny).toBe("function");
    });
    test_.after("test.count", (e) => {
      phases.push(e.phase);
      expect("cancel" in e).toBe(false);
      expect("deny" in e).toBe(false);
    });

    await test_.emit("test.count", 1);

    expect(phases).toEqual(["before", "after"]);
    expect("on" in test_).toBe(false);
    expect("emitAs" in test_).toBe(false);
    expect("signalAs" in test_).toBe(false);
  });
});

describe("5. hook budget", () => {
  test("a hook slower than the warn budget logs a warning", async () => {
    const { logger, warnings } = captureLog();
    const bus = createCoreBus({ logger, slowHookWarnMs: 10 });
    const test_ = bus.forPlugin("valet-test");
    test_.before("test.count", () => sleep(40));

    await test_.emit("test.count", 1);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("test.count");
  });

  test("a before hook over its time limit fails emit with cause timeout", async () => {
    const bus = createCoreBus({ hookTimeLimitMs: { "test.slow": 30 } });
    const test_ = bus.forPlugin("valet-test");
    test_.before("test.slow", () => sleep(150));

    try {
      await test_.emit("test.slow", { ms: 0 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EventHookError);
      expect((error as EventHookError).cause).toBe("timeout");
    }
  });

  test("the time limit is per event; other events keep the default", async () => {
    const { logger } = captureLog();
    const bus = createCoreBus({ logger, hookTimeLimitMs: { "test.slow": 30 }, slowHookWarnMs: 60_000 });
    const test_ = bus.forPlugin("valet-test");
    test_.before("test.count", () => sleep(60));

    const result = await test_.emit("test.count", 1);
    expect(result.cancelled).toBe(false);
  });

  test('"*" sets a global limit', async () => {
    const bus = createCoreBus({ hookTimeLimitMs: { "*": 30 } });
    const test_ = bus.forPlugin("valet-test");
    test_.before("test.count", () => sleep(60));

    await expect(test_.emit("test.count", 1)).rejects.toBeInstanceOf(EventHookError);
  });
});

describe("6. re-entrant emits", () => {
  test("caller.cause records the event whose hook caused the emit", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    const ui = bus.forPlugin("valet-ui");
    let seen: Caller | undefined;

    test_.after("ui.inner", (e) => {
      seen = e.caller;
    });
    ui.before("test.parent", async () => {
      await ui.emit("ui.inner", { n: 1 });
    });

    await test_.emit("test.parent", { n: 0 });

    expect(seen?.plugin).toBe("valet-ui");
    expect(seen?.cause).toEqual({ event: "test.parent", plugin: "valet-ui" });
  });

  test("emit chains deeper than the depth limit reject with cause depth", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    let emits = 0;
    test_.before("test.deep", async () => {
      emits += 1;
      await test_.emit("test.deep", { n: 0 });
    });

    try {
      await test_.emit("test.deep", { n: 0 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EventHookError);
      expect((error as EventHookError).cause).toBe("depth");
    }
    expect(emits).toBe(8);
  });

  test("the depth limit is configurable", async () => {
    const bus = createCoreBus({ maxDepth: 3 });
    const test_ = bus.forPlugin("valet-test");
    let emits = 0;
    test_.before("test.deep", async () => {
      emits += 1;
      await test_.emit("test.deep", { n: 0 });
    });

    await expect(test_.emit("test.deep", { n: 0 })).rejects.toBeInstanceOf(EventHookError);
    expect(emits).toBe(3);
  });
});

describe("7. signals are synchronous and fire-and-forget", () => {
  test("onSignal handlers run synchronously with the stamped caller", () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");
    let payload: { n: number } | undefined;
    let caller: Caller | undefined;

    exec.onSignal("exec.tick", (p, c) => {
      payload = p;
      caller = c;
    });
    exec.signal("exec.tick", { n: 7 });

    expect(payload).toEqual({ n: 7 });
    expect(caller?.plugin).toBe("valet-exec");
  });

  test("a sync throw is logged, not thrown, and later listeners still run", () => {
    const { logger, errors } = captureLog();
    const bus = createCoreBus({ logger });
    const exec = bus.forPlugin("valet-exec");
    let second = false;

    exec.onSignal("exec.tick", () => {
      throw new Error("boom");
    });
    exec.onSignal("exec.tick", () => {
      second = true;
    });

    expect(() => exec.signal("exec.tick", { n: 1 })).not.toThrow();
    expect(second).toBe(true);
    expect(errors).toHaveLength(1);
  });

  test("an async listener is not awaited; its rejection is logged", async () => {
    const { logger, errors } = captureLog();
    const bus = createCoreBus({ logger });
    const exec = bus.forPlugin("valet-exec");
    let finished = false;

    exec.onSignal("exec.tick", async () => {
      await sleep(20);
      finished = true;
    });
    exec.onSignal("exec.tick", () => Promise.reject(new Error("async boom")));

    exec.signal("exec.tick", { n: 1 });
    expect(finished).toBe(false);

    await sleep(40);
    expect(finished).toBe(true);
    expect(errors).toHaveLength(1);
  });
});

describe("8. dev mode freezes payloads", () => {
  test("payloads and nested objects are frozen for hooks and signal listeners", async () => {
    const bus = createCoreBus({ dev: true });
    const test_ = bus.forPlugin("valet-test");
    const checks: boolean[] = [];

    test_.before("test.frozen", (e) => {
      checks.push(Object.isFrozen(e.payload), Object.isFrozen(e.payload.outer));
    });
    test_.onSignal("test.tick", (p) => {
      checks.push(Object.isFrozen(p));
    });

    await test_.emit("test.frozen", { outer: { inner: 1 } });
    test_.signal("test.tick", { n: 1 });

    expect(checks).toEqual([true, true, true]);
  });

  test("in-place mutation fails; hooks must replace the payload", async () => {
    const bus = createCoreBus({ dev: true });
    const test_ = bus.forPlugin("valet-test");

    test_.before("test.frozen", (e) => {
      e.payload.outer.inner = 2;
    });
    await expect(test_.emit("test.frozen", { outer: { inner: 1 } })).rejects.toBeInstanceOf(EventHookError);
  });

  test("replacing the payload works and the replacement is frozen too", async () => {
    const bus = createCoreBus({ dev: true });
    const test_ = bus.forPlugin("valet-test");
    let seen: { outer: { inner: number } } | undefined;

    test_.before("test.frozen", (e) => {
      e.payload = { outer: { inner: 9 } };
    });
    test_.after("test.frozen", (e) => {
      seen = e.payload;
    });

    const result = await test_.emit("test.frozen", { outer: { inner: 1 } });

    expect(result.payload.outer.inner).toBe(9);
    expect(Object.isFrozen(seen?.outer)).toBe(true);
  });
});

describe("9. events carry a Caller", () => {
  test("a plugin emit gets only caller.plugin: no actor, authenticatedBy or cause", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    let seen: Caller | undefined;
    test_.before("test.count", (e) => {
      seen = e.caller;
    });

    await test_.emit("test.count", 1);

    expect(seen).toEqual({ plugin: "valet-test" });
  });

  test("emitAs passes a full caller through, for core actions", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    let seen: Caller | undefined;
    test_.before("control.request", (e) => {
      seen = e.caller;
    });

    await bus.emitAs(
      {
        plugin: "core",
        actor: { principalId: "pri_1", role: "owner" },
        authenticatedBy: "valet-auth",
      },
      "control.request",
      { kind: "http", method: "GET", path: "/api/core/plugins" },
    );

    expect(seen?.plugin).toBe("core");
    expect(seen?.actor).toEqual({ principalId: "pri_1", role: "owner" });
    expect(seen?.authenticatedBy).toBe("valet-auth");
  });
});

describe("10. deny(reason)", () => {
  test("deny cancels, attributes the denial to the hooking plugin, and after hooks see it", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    const guard = bus.forPlugin("valet-guard");
    const calls: string[] = [];
    let seenDenial: unknown;

    guard.before(
      "test.guarded",
      (e) => {
        e.deny("guests not allowed");
      },
      { priority: 10 },
    );
    test_.before(
      "test.guarded",
      () => {
        calls.push("skipped");
      },
      { priority: 0 },
    );
    test_.after("test.guarded", (e) => {
      calls.push("after");
      seenDenial = e.denied;
    });

    const result = await test_.emit("test.guarded", { n: 1 });

    expect(calls).toEqual(["after"]);
    expect(result.cancelled).toBe(true);
    expect(result.cancelReason).toBe("guests not allowed");
    expect(result.denied).toEqual({ by: "valet-guard", reason: "guests not allowed" });
    expect(seenDenial).toEqual({ by: "valet-guard", reason: "guests not allowed" });
  });

  test("deny cannot be attributed to a different plugin than the hooker", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    bus.forPlugin("valet-real").before("test.guarded", (e) => {
      e.deny("no");
    });

    const result = await test_.emit("test.guarded", { n: 1 });

    expect(result.denied?.by).toBe("valet-real");
  });
});

describe("11. restrict(fn)", () => {
  test("a refused subscribe throws ServiceDeniedError attributed to the namespace owner", () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");
    const friend = bus.forPlugin("valet-friend");
    const spy = bus.forPlugin("valet-spy");

    exec.restrict((subscriber) => subscriber === "valet-friend");

    expect(() => friend.before("exec.output", () => {})).not.toThrow();
    try {
      spy.before("exec.output", () => {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ServiceDeniedError);
      expect((error as ServiceDeniedError).by).toBe("valet-exec");
    }
    expect(() => spy.onSignal("exec.tick", () => {})).toThrow(ServiceDeniedError);
    // Other namespaces are unaffected.
    expect(() => spy.before("test.message", () => {})).not.toThrow();
  });

  test("restrict is checked at subscribe time; existing hooks keep running", async () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");
    const early = bus.forPlugin("valet-early");
    let ran = false;

    early.before("exec.output", () => {
      ran = true;
    });
    const restriction = exec.restrict(() => false);

    await exec.emit("exec.output", { chunk: "x" });
    expect(ran).toBe(true);

    restriction.dispose();
    expect(() => bus.forPlugin("valet-late").before("exec.output", () => {})).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Namespaces and caller forgery
// ---------------------------------------------------------------------------

describe("namespaces", () => {
  test("a plugin emits only its own namespace plus tool.call", async () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");

    await expect(exec.emit("exec.output", { chunk: "x" })).resolves.toMatchObject({
      cancelled: false,
    });
    await expect(exec.emit("test.message", { text: "x" })).rejects.toThrow(/outside its namespace/);
    await expect(exec.emit("core.ready", {})).rejects.toThrow(/outside its namespace/);
    await expect(exec.emit("session.create", {} as never)).rejects.toThrow(/outside its namespace/);
    expect(() => exec.signal("test.tick", { n: 1 })).toThrow(/outside its namespace/);
  });

  test("tool.call is the one core event a plugin may emit", async () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");
    let seen: Caller | undefined;
    bus.forPlugin("valet-policy").before("tool.call", (e) => {
      seen = e.caller;
    });

    const result = await exec.emit("tool.call", {
      runId: "run_1",
      callId: "call_1",
      name: "exec",
      input: { command: "ls" },
      role: "owner",
    });

    expect(result.cancelled).toBe(false);
    expect(seen?.plugin).toBe("valet-exec");
  });

  test("core namespaces are emitted through emitAs, which plugins cannot reach", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    let seen: Caller | undefined;
    test_.before("core.ready", (e) => {
      seen = e.caller;
    });

    await bus.emitAs({ plugin: "core" }, "core.ready", {});

    expect(seen?.plugin).toBe("core");
    expect("emitAs" in test_).toBe(false);
  });

  test("the manifest namespace overrides the derived default", async () => {
    const bus = createCoreBus();
    const weird = bus.forPlugin("valet-weird", "test");

    await expect(weird.emit("test.message", { text: "x" })).resolves.toMatchObject({
      cancelled: false,
    });
    await expect(weird.emit("exec.output", { chunk: "x" })).rejects.toThrow(/outside its namespace/);
  });
});

describe("caller forgery", () => {
  test("payload fields named caller or plugin have no effect on the stamped caller", async () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");
    let seen: Caller | undefined;
    bus.forPlugin("valet-ui").before("exec.output", (e) => {
      seen = e.caller;
    });

    const forged = {
      chunk: "x",
      caller: { plugin: "valet-evil", actor: { principalId: "pri_x", role: "owner" } },
      cause: { event: "fake", plugin: "valet-evil" },
    };
    await exec.emit("exec.output", forged);

    expect(seen).toEqual({ plugin: "valet-exec" });
  });

  test("a hook option claiming another plugin id has no effect on deny attribution", async () => {
    const bus = createCoreBus();
    const test_ = bus.forPlugin("valet-test");
    const opts = { plugin: "valet-evil" } as unknown as HookOptions;
    bus.forPlugin("valet-real").before(
      "test.guarded",
      (e) => {
        e.deny("no");
      },
      opts,
    );

    const result = await test_.emit("test.guarded", { n: 1 });

    expect(result.denied?.by).toBe("valet-real");
  });
});
