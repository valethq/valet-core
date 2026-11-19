import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BootOptions,
  type PluginRecord,
  type ValetConfig,
  type ValetKernel,
  boot,
  createHttpRegistry,
  createScopeRegistry,
  createWsRegistry,
  discoverPlugins,
  resolvePlugins,
  validateManifest,
} from "@valethq/core";
import { EventHookError, type CancelledResult, type Logger, type PluginManifest } from "@valethq/sdk";

declare module "@valethq/sdk" {
  interface ValetScopes {
    "fix-scope": { ping(): string };
    "fix-other": { ping(): string };
  }
}

const FIXTURES = join(import.meta.dir, "fixtures", "plugins");
const WORKSPACE = join(import.meta.dir, "..", "..");

const kernels: ValetKernel[] = [];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(ready: () => boolean, ms = 1000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await sleep(15);
  }
}

function clearTimer(): void {
  const timer = (globalThis as { __valet_fix_timer?: ReturnType<typeof setInterval> }).__valet_fix_timer;
  if (timer !== undefined) clearInterval(timer);
}

afterEach(async () => {
  clearTimer();
  while (kernels.length > 0) await kernels.pop()?.shutdown();
});

function tempHome(config: Record<string, unknown>): string {
  const home = mkdtempSync(join(tmpdir(), "valet-fix-"));
  writeFileSync(join(home, "config.json"), JSON.stringify(config));
  return home;
}

async function start(scenarios: string[], extra: BootOptions = {}): Promise<ValetKernel> {
  const pluginPaths = scenarios.map((scenario) => join(FIXTURES, scenario));
  const home = tempHome({ pluginPaths });
  const kernel = await boot({ valetHome: home, dbPath: ":memory:", out: () => {}, ...extra });
  kernels.push(kernel);
  return kernel;
}

function notCancelled<T>(value: T | CancelledResult): T {
  if ((value as CancelledResult).cancelled === true) throw new Error("store action cancelled");
  return value as T;
}

const log: Logger = { debug() {}, info() {}, warn() {}, error() {} };

function config(pluginPaths: string[]): ValetConfig {
  return { server: { host: "127.0.0.1", port: 0, allowedOrigins: [] }, pluginPaths, plugins: {}, scopes: {} };
}

function pending(id: string, extra: Partial<PluginManifest> = {}): PluginRecord {
  return {
    id,
    dir: id,
    state: "pending",
    manifest: { schema: 1, id, name: id, version: "0.1.0", valet: "^0.1.0", main: "./index.ts", ...extra },
  };
}

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: 1,
    id: "valet-example",
    name: "Example",
    version: "0.1.0",
    valet: "^0.1.0",
    main: "./index.ts",
    ...over,
  };
}

describe("activation timeout", () => {
  test("a timed-out activate is aborted and cannot register hooks after dispose", async () => {
    const kernel = await start(["fixes-timeout"], { activationTimeoutMs: 40 });
    await waitFor(
      () => (globalThis as { __valet_fix_timeout?: { done: boolean } }).__valet_fix_timeout?.done === true,
    );
    const state = (globalThis as { __valet_fix_timeout?: { aborted: boolean; lateActive: boolean } })
      .__valet_fix_timeout;
    expect(state?.aborted).toBe(true);
    expect(state?.lateActive).toBe(false);
    expect(kernel.bus.listenerCount("core.ready")).toBe(0);
    const plugins = new Map(kernel.plugins().map((plugin) => [plugin.id, plugin]));
    expect(plugins.get("fx-timeout")?.state).toBe("failed");
    expect(plugins.get("fx-timeout")?.error).toContain("timed out");
    expect(plugins.get("fx-z-ok")?.state).toBe("active");
    expect((globalThis as { __valet_fix_zok?: boolean }).__valet_fix_zok).toBe(true);
  });
});

describe("import timeout", () => {
  test("a hanging plugin import times out and boot continues", async () => {
    const kernel = await start(["fixes-import"], { activationTimeoutMs: 80 });
    const plugins = new Map(kernel.plugins().map((plugin) => [plugin.id, plugin]));
    expect(plugins.get("fx-hang-import")?.state).toBe("failed");
    expect(plugins.get("fx-hang-import")?.error).toContain("import");
    expect(plugins.get("fx-hang-import")?.error).toContain("timed out");
    expect(plugins.get("fx-aaa-ok")?.state).toBe("active");
    expect((globalThis as { __valet_fix_import_ok?: boolean }).__valet_fix_import_ok).toBe(true);
    expect((globalThis as { __valet_fix_import_bad?: boolean }).__valet_fix_import_bad).toBeUndefined();
  });
});

describe("shutdown signal", () => {
  test("shutdown aborts ctx.signal before deactivate and drops late hooks", async () => {
    const kernel = await start(["fixes-shutdown"], { deactivationTimeoutMs: 1500 });
    const started = performance.now();
    await kernel.shutdown();
    expect(performance.now() - started).toBeLessThan(500);
    const state = (
      globalThis as { __valet_fix_shutdown?: { aborted: boolean; lateActive: boolean; lateDone: boolean } }
    ).__valet_fix_shutdown;
    expect(state?.aborted).toBe(true);
    await waitFor(() => state?.lateDone === true);
    expect(state?.lateActive).toBe(false);
    expect(kernel.bus.listenerCount("core.ready")).toBe(0);
  });
});

describe("boot failure cleanup", () => {
  test("a throwing core.ready before hook deactivates plugins before boot rejects", async () => {
    (globalThis as { __valet_fix_stop?: string[] }).__valet_fix_stop = [];
    (globalThis as { __valet_fix_ticks?: number }).__valet_fix_ticks = 0;
    let caught: unknown;
    try {
      await start(["fixes-live", "fixes-ready"]);
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EventHookError);
    expect((caught as EventHookError).eventName).toBe("core.ready");
    expect(((caught as EventHookError).cause as Error).message).toBe("ready blew up");
    expect((globalThis as { __valet_fix_stop?: string[] }).__valet_fix_stop).toEqual([
      "fx-ready:true",
      "fx-live:true",
    ]);
    expect((globalThis as { __valet_fix_aborted?: boolean }).__valet_fix_aborted).toBe(true);
    expect((globalThis as { __valet_fix_disposed?: boolean }).__valet_fix_disposed).toBe(true);
    const ticks = (globalThis as { __valet_fix_ticks?: number }).__valet_fix_ticks ?? 0;
    await sleep(60);
    expect((globalThis as { __valet_fix_ticks?: number }).__valet_fix_ticks).toBe(ticks);
  });

  test("a throwing run.interrupted before hook deactivates plugins before boot rejects", async () => {
    const home = tempHome({ pluginPaths: [] });
    const first = await boot({ valetHome: home, out: () => {} });
    kernels.push(first);
    const store = first.store.forPlugin("valet-test");
    const project = notCancelled(await store.projects.create({ name: "p", workspaceDir: "/tmp/ws" }));
    const session = notCancelled(await store.sessions.create({ projectId: project.id }));
    const run = store.runs.create({ sessionId: session.id, role: "owner" });
    store.runs.update(run.id, { status: "running" });
    await first.shutdown();

    writeFileSync(join(home, "config.json"), JSON.stringify({ pluginPaths: [join(FIXTURES, "fixes-live")] }));
    (globalThis as { __valet_fix_stop?: string[] }).__valet_fix_stop = [];
    (globalThis as { __valet_fix_ticks?: number }).__valet_fix_ticks = 0;
    let caught: unknown;
    try {
      await boot({
        valetHome: home,
        out: () => {},
        tapBus(bus) {
          bus.forPlugin("valet-probe").before("run.interrupted", () => {
            throw new Error("interrupted blew up");
          });
        },
      });
      expect.unreachable();
    } catch (error) {
      caught = error;
    }
    expect((caught as EventHookError).eventName).toBe("run.interrupted");
    expect(((caught as EventHookError).cause as Error).message).toBe("interrupted blew up");
    expect((globalThis as { __valet_fix_stop?: string[] }).__valet_fix_stop).toEqual(["fx-live:true"]);
    expect((globalThis as { __valet_fix_disposed?: boolean }).__valet_fix_disposed).toBe(true);
    const ticks = (globalThis as { __valet_fix_ticks?: number }).__valet_fix_ticks ?? 0;
    await sleep(60);
    expect((globalThis as { __valet_fix_ticks?: number }).__valet_fix_ticks).toBe(ticks);
  });
});

describe("optional dependents of a cycle", () => {
  test("optional dependents are ordered and hard dependents of the cycle fail", () => {
    const records = [
      pending("opt-a", { dependencies: { "opt-b": "^0.1.0" }, provides: ["letters@1"] }),
      pending("opt-b", { dependencies: { "opt-a": "^0.1.0" } }),
      pending("opt-c", { optionalDependencies: { "opt-a": "^0.1.0" } }),
      pending("opt-d", { dependencies: { "opt-c": "^0.1.0" } }),
      pending("opt-e", { dependencies: { "opt-a": "^0.1.0" } }),
      pending("opt-f", { optionalRequires: ["letters@1"] }),
      pending("opt-free"),
    ];
    const order = resolvePlugins(records, config([]), log).map((rec) => rec.id);
    expect(order).toEqual(["opt-free", "opt-c", "opt-d", "opt-f"]);
    const byId = new Map(records.map((rec) => [rec.id, rec]));
    expect(byId.get("opt-a")?.state).toBe("failed");
    expect(byId.get("opt-a")?.error).toContain("cycle");
    expect(byId.get("opt-b")?.state).toBe("failed");
    expect(byId.get("opt-e")?.state).toBe("failed");
    expect(byId.get("opt-e")?.error).toContain('dependency "opt-a" failed');
    const ordered = new Set(order);
    for (const rec of records) {
      if (rec.state === "pending") expect(ordered.has(rec.id)).toBe(true);
    }
  });

  test("plugins() includes optional dependents downstream of a cycle", async () => {
    (globalThis as { __valet_fix_cycle?: string[] }).__valet_fix_cycle = [];
    const kernel = await start(["fixes-cycle"]);
    const plugins = new Map(kernel.plugins().map((plugin) => [plugin.id, plugin]));
    expect(plugins.get("fx-a")?.state).toBe("failed");
    expect(plugins.get("fx-a")?.error).toContain("cycle");
    expect(plugins.get("fx-b")?.state).toBe("failed");
    expect(plugins.get("fx-c")?.state).toBe("active");
    expect(plugins.get("fx-d")?.state).toBe("active");
    expect((globalThis as { __valet_fix_cycle?: string[] }).__valet_fix_cycle).toEqual(["fx-c", "fx-d"]);
    for (const id of ["fx-a", "fx-b", "fx-c", "fx-d"]) expect(plugins.has(id)).toBe(true);
  });
});

describe("manifest validation", () => {
  test("garbage semver ranges are rejected and real ranges are accepted", () => {
    const accepted = ["*", "x", "^0.1.0", ">=0.0.1", ">=0.1.0 <1.0.0", "~0.1.0", "0.1.0"];
    for (const range of accepted) expect(validateManifest(base({ valet: range })), range).toEqual([]);

    const dependencyRanges = [
      "*",
      "^0.1.0",
      "1.2.3 || 4.5.6",
      "1.0.0 - 2.0.0",
      "~1.2.3",
      "1.2.3-alpha.1",
      "=1.2.3",
    ];
    for (const range of dependencyRanges) {
      expect(validateManifest(base({ dependencies: { "valet-agent": range } })), range).toEqual([]);
    }

    for (const range of ["lol1", "latest", "^^1.2.3", "1.2.3.4", "workspace:*", " ", "^0.1.0 "]) {
      expect(validateManifest(base({ valet: range })).join(";"), range).toContain("semver range");
    }
    expect(validateManifest(base({ dependencies: { "valet-agent": "not-a-range-1" } })).join(";")).toContain(
      "semver range",
    );
    expect(
      validateManifest(base({ optionalDependencies: { "valet-agent": "not-a-range-1" } })).join(";"),
    ).toContain("semver range");
  });

  test("a reserved effective namespace is rejected and identity stays available", () => {
    expect(validateManifest(base({ id: "valet-session" })).join(";")).toContain("reserved");
    expect(validateManifest(base({ id: "valet-message" })).join(";")).toContain("reserved");
    expect(validateManifest(base({ events: { namespace: "session" } })).join(";")).toContain("reserved");
    expect(validateManifest(base({ events: { namespace: "tool" } })).join(";")).toContain("reserved");
    expect(validateManifest(base({ events: { namespace: "part" } })).join(";")).toContain("reserved");
    expect(validateManifest(base({ events: { namespace: "plugin" } })).join(";")).toContain("reserved");
    expect(validateManifest(base({ id: "valet-session", events: { namespace: "discord" } }))).toEqual([]);
    expect(validateManifest(base({ id: "valet-auth", events: { namespace: "identity" } }))).toEqual([]);
    expect(validateManifest(base({ id: "valet-exec", events: { namespace: "exec" } }))).toEqual([]);
  });

  test("shipped plugin manifests still validate", () => {
    const checked: string[] = [];
    for (const name of readdirSync(WORKSPACE)) {
      if (!name.startsWith("valet-")) continue;
      const manifestPath = join(WORKSPACE, name, "manifest.json");
      try {
        readFileSync(manifestPath, "utf8");
      } catch {
        continue;
      }
      const raw = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown;
      expect(validateManifest(raw), name).toEqual([]);
      checked.push(name);
    }
    expect(checked).toContain("valet-auth");
    expect(checked.length).toBeGreaterThan(5);
  });
});

describe("registrations after dispose", () => {
  test("http, ws and scope views drop registrations made after disposeAll", () => {
    const http = createHttpRegistry({ host: "127.0.0.1", port: 0 });
    const routes = http.forPlugin("valet-test");
    routes.route("GET", "/kept", () => new Response("ok"));
    routes.disposeAll();
    routes.route("GET", "/late", () => new Response("no"));
    expect(http.routes().map((route) => route.path)).toEqual([]);

    const ws = createWsRegistry();
    const sockets = ws.forPlugin("valet-test", "test");
    sockets.handle("test.kept", () => "ok");
    sockets.disposeAll();
    sockets.handle("test.late", () => "no");
    expect([...ws.handlers().keys()]).toEqual([]);

    const scopes = createScopeRegistry({ logger: log });
    const view = scopes.forPlugin("valet-test", ["fix-scope@1"]);
    view.define({ name: "fix-scope", version: 1, cardinality: "many" });
    view.provide("fix-scope", { ping: () => "ok" });
    let watched = 0;
    view.disposeAll();
    view.define({ name: "fix-other", version: 1, cardinality: "many" });
    view.provide("fix-scope", { ping: () => "late" }, { key: "late" });
    view.watch("fix-scope", () => {
      watched += 1;
    });
    expect(scopes.providers("fix-scope")).toEqual([]);
    expect(watched).toBe(0);

    const other = scopes.forPlugin("valet-other", ["fix-scope@1"]);
    other.provide("fix-scope", { ping: () => "other" }, { key: "other" });
    expect(watched).toBe(0);
    expect(scopes.providers("fix-scope").map((provider) => provider.plugin)).toEqual(["valet-other"]);
    expect(() =>
      scopes.forPlugin("valet-third", ["fix-other@1"]).provide("fix-other", { ping: () => "x" }),
    ).toThrow(/unknown scope/);
  });
});

describe("symlinked plugin directories", () => {
  test("discoverPlugins accepts a symlink to a directory and skips other symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "valet-link-"));
    const real = join(root, "real");
    const plugins = join(root, "plugins");
    mkdirSync(join(real, "fx-linked"), { recursive: true });
    mkdirSync(join(plugins, "fx-plain"), { recursive: true });
    const manifest = JSON.stringify({
      schema: 1,
      id: "fx-linked",
      name: "linked",
      version: "0.1.0",
      valet: "^0.1.0",
      main: "./index.ts",
    });
    writeFileSync(join(real, "fx-linked", "manifest.json"), manifest);
    writeFileSync(
      join(plugins, "fx-plain", "manifest.json"),
      manifest.replace("fx-linked", "fx-plain").replace("linked", "plain"),
    );
    symlinkSync(join(real, "fx-linked"), join(plugins, "fx-linked"));
    writeFileSync(join(root, "a-file"), "x");
    symlinkSync(join(root, "a-file"), join(plugins, "file-link"));
    symlinkSync(join(root, "missing"), join(plugins, "broken"));

    const found = discoverPlugins(config([plugins]), log).map((rec) => rec.id);
    expect(found.sort()).toEqual(["fx-linked", "fx-plain"]);
  });
});
