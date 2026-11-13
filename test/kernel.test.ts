import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BootOptions, type ValetKernel, boot } from "@valethq/core";
import type { CancelledResult } from "@valethq/sdk";

const FIXTURES = join(import.meta.dir, "fixtures", "plugins");

interface Globals {
  __valet_order?: string[];
  __valet_disposed?: string[];
  __valet_deactivated?: string[];
  __valet_aborted?: boolean;
  __valet_emit?: Record<string, string>;
  __valet_stamp?: [string, string][];
  __valet_scope_caller?: string;
  __valet_whoami?: string;
}
const globals = (): Globals => globalThis as unknown as Globals;

function resetGlobals(): void {
  const g = globals();
  for (const key of Object.keys(g)) {
    if (key.startsWith("__valet_")) delete g[key as keyof Globals];
  }
}

function tempHome(config?: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "valet-home-"));
  if (config !== undefined) writeFileSync(join(home, "config.json"), JSON.stringify(config));
  return home;
}

function bootScenario(
  scenario: string | string[],
  opts: { config?: Record<string, unknown>; boot?: BootOptions } = {},
): Promise<ValetKernel> {
  const pluginPaths = (Array.isArray(scenario) ? scenario : [scenario]).map((s) => join(FIXTURES, s));
  const home = tempHome({ pluginPaths, ...(opts.config ?? {}) });
  return boot({ valetHome: home, out: () => {}, ...(opts.boot ?? {}) });
}

const kernels: ValetKernel[] = [];
async function track(kernel: Promise<ValetKernel>): Promise<ValetKernel> {
  const k = await kernel;
  kernels.push(k);
  return k;
}

afterEach(async () => {
  while (kernels.length > 0) await kernels.pop()?.shutdown();
});

const byId = (kernel: ValetKernel) => new Map(kernel.plugins().map((p) => [p.id, p]));

function notCancelled<T>(value: T | CancelledResult): T {
  if ((value as CancelledResult).cancelled === true) throw new Error("store action cancelled");
  return value as T;
}

describe("kernel boot", () => {
  test("boots with zero plugins: core.ready fires, store open, no error", async () => {
    let ready = false;
    const kernel = await track(
      bootScenario("empty", {
        boot: {
          tapBus: (bus) => {
            bus.forPlugin("valet-test").after("core.ready", () => {
              ready = true;
            });
          },
        },
      }),
    );
    expect(ready).toBe(true);
    expect(kernel.plugins()).toEqual([]);
    expect(kernel.store.forCaller({ plugin: "core" }).projects.list()).toEqual([]);
  });

  test("activation order is deterministic, ties broken by id", async () => {
    resetGlobals();
    const kernel = await track(bootScenario("order"));
    expect(globals().__valet_order).toEqual([
      "valet-base",
      "valet-mid-a",
      "valet-mid-b",
      "valet-aaa",
      "valet-top",
    ]);
    const plugins = kernel.plugins();
    expect(plugins.map((p) => p.id)).toEqual([
      "valet-base",
      "valet-mid-a",
      "valet-mid-b",
      "valet-aaa",
      "valet-top",
    ]);
    expect(plugins.every((p) => p.state === "active")).toBe(true);
    expect(plugins.map((p) => p.order)).toEqual([0, 1, 2, 3, 4]);
  });

  test("cycle detection marks every member failed with the cycle in the error", async () => {
    resetGlobals();
    const kernel = await track(bootScenario("cycle"));
    const plugins = byId(kernel);
    expect(plugins.get("valet-cyc-a")?.state).toBe("failed");
    expect(plugins.get("valet-cyc-b")?.state).toBe("failed");
    expect(plugins.get("valet-cyc-a")?.error).toContain("cycle");
    expect(plugins.get("valet-cyc-a")?.error).toContain("valet-cyc-a");
    expect(plugins.get("valet-cyc-a")?.error).toContain("valet-cyc-b");
    expect(plugins.get("valet-free")?.state).toBe("active");
    expect(globals().__valet_order).toEqual(["valet-free"]);
  });

  test("missing hard dep and required scope fail with cascade", async () => {
    resetGlobals();
    const kernel = await track(bootScenario("cascade"));
    const plugins = byId(kernel);
    expect(plugins.get("valet-needs-ghost")?.state).toBe("failed");
    expect(plugins.get("valet-needs-ghost")?.error).toContain('missing dependency "valet-ghost"');
    expect(plugins.get("valet-needs-needs")?.state).toBe("failed");
    expect(plugins.get("valet-needs-needs")?.error).toContain('dependency "valet-needs-ghost" failed');
    expect(plugins.get("valet-needs-noscope")?.state).toBe("failed");
    expect(plugins.get("valet-needs-noscope")?.error).toContain('required scope "ghost-scope@1"');
    expect(plugins.get("valet-ok")?.state).toBe("active");
    expect(globals().__valet_order).toEqual(["valet-ok"]);
  });

  test("activation throw and timeout cascade; optional dependents still activate", async () => {
    resetGlobals();
    const kernel = await track(bootScenario("activate", { boot: { activationTimeoutMs: 50 } }));
    const plugins = byId(kernel);
    expect(plugins.get("valet-thrower")?.state).toBe("failed");
    expect(plugins.get("valet-thrower")?.error).toContain("activation blew up");
    expect(plugins.get("valet-hanger")?.state).toBe("failed");
    expect(plugins.get("valet-hanger")?.error).toContain("timed out");
    expect(plugins.get("valet-hard-child")?.state).toBe("failed");
    expect(plugins.get("valet-hard-child")?.error).toContain('dependency "valet-thrower" failed');
    expect(plugins.get("valet-hard-hanger")?.state).toBe("failed");
    expect(plugins.get("valet-hard-hanger")?.error).toContain('dependency "valet-hanger" failed');
    expect(plugins.get("valet-soft-child")?.state).toBe("active");
    expect(plugins.get("valet-soft-hanger")?.state).toBe("active");
    expect(globals().__valet_order?.sort()).toEqual(["valet-soft-child", "valet-soft-hanger"]);
  });

  test("disposal on failure and on deactivate removes hooks, scopes, routes", async () => {
    resetGlobals();
    const kernel = await track(bootScenario("dispose"));
    const plugins = byId(kernel);
    expect(plugins.get("valet-registers")?.state).toBe("failed");
    expect(plugins.get("valet-stays")?.state).toBe("active");

    // The failed plugin's registrations are gone; the active one's remain.
    expect(kernel.bus.listenerCount("dispose.probe")).toBe(1);
    expect(kernel.scopes.providers("dispose-scope@1")).toEqual([{ key: "stays", plugin: "valet-stays" }]);
    expect(kernel.http.routes().filter((r) => r.plugin === "valet-registers")).toHaveLength(0);
    expect(kernel.http.routes().map((r) => `${r.method} ${r.plugin}${r.path}`)).toEqual([
      "GET valet-stays/stays",
    ]);
    expect([...kernel.ws.handlers().values()].map((h) => h.method)).toEqual(["stays.ping"]);
    expect(globals().__valet_disposed).toEqual(["valet-registers"]);

    await kernel.shutdown();

    expect(kernel.bus.listenerCount("dispose.probe")).toBe(0);
    expect(kernel.scopes.providers("dispose-scope@1")).toEqual([]);
    expect(kernel.http.routes()).toHaveLength(0);
    expect(kernel.ws.handlers().size).toBe(0);
    expect(globals().__valet_disposed).toEqual(["valet-registers", "valet-stays"]);
    expect(globals().__valet_deactivated).toEqual(["valet-stays"]);
    expect(globals().__valet_aborted).toBe(true);
  });

  test("namespace emit enforcement through ctx", async () => {
    const kernel = await track(bootScenario("emit"));
    expect(byId(kernel).get("valet-emitter")?.state).toBe("active");
    const out = globals().__valet_emit;
    expect(out?.own).toBe("ok");
    expect(out?.toolcall).toBe("ok");
    expect(out?.foreign).toContain("cannot emit");
    expect(out?.coreEvt).toContain("cannot emit");
  });

  test("caller.plugin is stamped through ctx.events, store and scopes", async () => {
    resetGlobals();
    const kernel = await track(bootScenario("stamp"));
    const plugins = byId(kernel);
    for (const id of ["valet-watcher", "valet-stamper", "valet-provider", "valet-consumer"]) {
      expect(plugins.get(id)?.state).toBe("active");
    }
    expect(globals().__valet_stamp).toContainEqual(["event", "valet-stamper"]);
    expect(globals().__valet_stamp).toContainEqual(["store", "valet-stamper"]);
    expect(globals().__valet_scope_caller).toBe("valet-consumer");
    expect(globals().__valet_whoami).toBe("valet-consumer");
  });

  test("disabled plugin is dropped and reported", async () => {
    resetGlobals();
    const kernel = await track(
      bootScenario("disabled", { config: { plugins: { "valet-disabled": { enabled: false } } } }),
    );
    const plugins = byId(kernel);
    expect(plugins.get("valet-disabled")?.state).toBe("disabled");
    expect(plugins.get("valet-alive")?.state).toBe("active");
    expect(globals().__valet_order).toEqual(["valet-alive"]);
  });

  test("duplicate plugin id is a boot error", async () => {
    await expect(bootScenario(["dup-a", "dup-b"])).rejects.toThrow(/duplicate plugin id "valet-dup"/);
  });

  test("config schema failure marks only that plugin failed", async () => {
    resetGlobals();
    const kernel = await track(
      bootScenario("badconfig", { config: { plugins: { "valet-needs-config": { config: { token: 42 } } } } }),
    );
    const plugins = byId(kernel);
    expect(plugins.get("valet-needs-config")?.state).toBe("failed");
    expect(plugins.get("valet-needs-config")?.error).toContain("invalid plugin config");
    expect(plugins.get("valet-sibling")?.state).toBe("active");
    expect(globals().__valet_order).toEqual(["valet-sibling"]);
  });

  test("run.interrupted is emitted after core.ready for runs left running", async () => {
    const home = tempHome({ pluginPaths: [join(FIXTURES, "empty")] });
    const first = await track(boot({ valetHome: home, out: () => {} }));
    const store = first.store.forPlugin("valet-test");
    const project = notCancelled(await store.projects.create({ name: "p", workspaceDir: "/tmp/ws" }));
    const session = notCancelled(await store.sessions.create({ projectId: project.id }));
    const run = store.runs.create({ sessionId: session.id, role: "owner" });
    store.runs.update(run.id, { status: "running" });
    await first.shutdown();

    const seen: string[] = [];
    const second = await track(
      boot({
        valetHome: home,
        out: () => {},
        tapBus: (bus) => {
          const view = bus.forPlugin("valet-test");
          view.after("core.ready", () => {
            seen.push("ready");
          });
          view.after("run.interrupted", (e) => {
            seen.push(e.payload.run.id);
          });
        },
      }),
    );
    expect(second.store.forCaller({ plugin: "core" }).runs.get(run.id)?.status).toBe("interrupted");
    expect(seen).toEqual(["ready", run.id]);
  });
});
