import { describe, expect, test } from "bun:test";
import { EventHookError } from "@valethq/sdk";
import { createCoreBus } from "../src/bus";
import type { HookErrorReport } from "../src/bus/types";

declare module "@valethq/sdk" {
  interface ValetEvents {
    "tool.other": { n: number };
    "session.extra": { n: number };
    "test.fixslow": { n: number };
    "exec.fix": { n: number };
  }
  interface ValetSignals {
    "exec.fix": { n: number };
    "test.fixsig": { n: number };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const toolCall = {
  runId: "run_1",
  callId: "call_1",
  name: "exec",
  input: {},
  role: "owner" as const,
};

describe("registrations after disposeAll", () => {
  test("before, after, onSignal and restrict after disposeAll do not register", async () => {
    const bus = createCoreBus();
    const view = bus.forPlugin("valet-test");
    view.disposeAll();

    const before = view.before("test.fixslow", () => {
      throw new Error("before ran");
    });
    const after = view.after("test.fixslow", () => {
      throw new Error("after ran");
    });
    let signalled = false;
    const signal = view.onSignal("test.fixsig", () => {
      signalled = true;
    });
    const restriction = view.restrict(() => false);

    expect(before.active).toBe(false);
    expect(after.active).toBe(false);
    expect(signal.active).toBe(false);
    before.disconnect();
    after.disconnect();
    signal.disconnect();
    restriction.dispose();

    await bus.emitAs({ plugin: "core" }, "test.fixslow", { n: 1 });
    bus.signalAs({ plugin: "core" }, "test.fixsig", { n: 1 });
    expect(signalled).toBe(false);
    expect(bus.listenerCount("test.fixslow")).toBe(0);
    expect(() => bus.forPlugin("valet-other").before("test.fixslow", () => {})).not.toThrow();
  });
});

describe("hook time limit", () => {
  test("an after hook over the time limit does not hang emit and is reported", async () => {
    const reports: HookErrorReport[] = [];
    const bus = createCoreBus({
      hookTimeLimitMs: { "test.fixslow": 25 },
      slowHookWarnMs: 60_000,
      onHookError: (report) => {
        reports.push(report);
      },
    });
    const view = bus.forPlugin("valet-test");
    let finished = false;
    view.after("test.fixslow", async () => {
      await sleep(80);
      finished = true;
    });

    const result = await view.emit("test.fixslow", { n: 1 });

    expect(finished).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(reports).toHaveLength(1);
    const report = reports[0] as HookErrorReport;
    expect(report.phase).toBe("after");
    expect(report.error).toBeInstanceOf(EventHookError);
    expect((report.error as EventHookError).cause).toBe("timeout");
    await sleep(80);
    expect(finished).toBe(true);
  });

  test("a before hook still fails when it exceeds the time limit", async () => {
    const bus = createCoreBus({ hookTimeLimitMs: { "test.fixslow": 25 } });
    const view = bus.forPlugin("valet-test");
    view.before("test.fixslow", () => sleep(80));

    try {
      await view.emit("test.fixslow", { n: 1 });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(EventHookError);
      expect((error as EventHookError).cause).toBe("timeout");
      expect((error as EventHookError).phase).toBe("before");
    }
  });
});

describe("reserved core namespaces", () => {
  test("a plugin whose namespace is a core prefix cannot emit or restrict it", async () => {
    const bus = createCoreBus();
    const session = bus.forPlugin("valet-session");
    const message = bus.forPlugin("valet-message");
    const part = bus.forPlugin("valet-evil", "part");

    await expect(session.emit("session.delete", {} as never)).rejects.toThrow(/outside its namespace/);
    await expect(session.emit("session.extra", { n: 1 })).rejects.toThrow(/outside its namespace/);
    expect(() => session.signal("message.delta", {} as never)).toThrow(/outside its namespace/);
    expect(() => session.restrict(() => false)).toThrow(/core namespace "session"/);
    expect(() => message.restrict(() => false)).toThrow(/core namespace "message"/);
    expect(() => part.restrict(() => true)).toThrow(/core namespace "part"/);

    expect(() => bus.forPlugin("valet-ui").before("message.create", () => {})).not.toThrow();
    await expect(session.emit("tool.call", toolCall)).resolves.toMatchObject({ cancelled: false });
    await expect(session.emit("tool.other", { n: 1 })).rejects.toThrow(/outside its namespace/);
  });

  test("a plugin still emits and restricts its own namespace", async () => {
    const bus = createCoreBus();
    const exec = bus.forPlugin("valet-exec");
    exec.restrict((subscriber) => subscriber === "valet-friend");

    await expect(exec.emit("exec.fix", { n: 1 })).resolves.toMatchObject({ cancelled: false });
    expect(() => exec.signal("exec.fix", { n: 1 })).not.toThrow();
    expect(() => bus.forPlugin("valet-friend").before("exec.fix", () => {})).not.toThrow();
    expect(() => bus.forPlugin("valet-spy").before("exec.fix", () => {})).toThrow(/refused/);
  });
});
