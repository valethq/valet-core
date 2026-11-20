import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type ControlServer,
  createControlServer,
  patchOverlay,
  type ValetKernel,
  withEnabled,
} from "@valethq/core";
import { bootFx, fxRoot, FX } from "./helpers";

interface SetState {
  ctx: { config: Record<string, unknown> };
  calls: Record<string, unknown>[];
}
const live = (): SetState => (globalThis as unknown as { __valet_set: SetState }).__valet_set;

const kernels: ValetKernel[] = [];
const servers: ControlServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) s.stop();
  while (kernels.length > 0) await kernels.pop()?.shutdown();
});

async function up(config: Record<string, unknown> = {}, settings?: unknown) {
  const env = await bootFx(fxRoot("settings"), {
    config,
    ...(settings === undefined ? {} : { beforeBoot: (home: string) => writeSettings(home, settings) }),
  });
  kernels.push(env.kernel);
  return env;
}

const writeSettings = (home: string, s: unknown) =>
  writeFileSync(join(home, "settings.json"), JSON.stringify(s));
const readSettings = (home: string) => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const doc = (k: ValetKernel, id: string) => k.settings().find((p) => p.plugin === id);

describe("settings layering", () => {
  test("schema defaults fill ctx.config, the file beats them, settings.json beats the file", async () => {
    const { kernel } = await up(
      { plugins: { "fx-set": { config: { mode: "b", label: "file" } } } },
      { plugins: { "fx-set": { config: { label: "ui" } } } },
    );
    expect(live().ctx.config).toEqual({ mode: "b", level: 3, label: "ui" });
    expect(doc(kernel, "fx-set")?.sources).toEqual({ mode: "file", level: "default", label: "settings" });
    expect(doc(kernel, "fx-set")?.layers).toEqual({
      file: { mode: "b", label: "file" },
      user: { label: "ui" },
    });
    expect(doc(kernel, "fx-set")?.liveConfig).toBe(true);
    expect(doc(kernel, "fx-cold")?.liveConfig).toBe(false);
  });

  test("pure helpers", () => {
    const overlay = patchOverlay(
      { plugins: { p: { config: { a: 1, b: 2 } } } },
      "p",
      { config: { a: null } },
      undefined,
    );
    expect(overlay).toEqual({ plugins: { p: { config: { b: 2 } } } });
    expect(patchOverlay(overlay, "p", { config: { b: null }, enabled: true }, undefined)).toEqual({
      plugins: {},
    });
    const file = {
      server: { host: "h", port: 1, allowedOrigins: [] },
      pluginPaths: [],
      scopes: {},
      plugins: { p: { config: { a: 1 } } },
    };
    expect(withEnabled(file, { plugins: { p: { enabled: false, config: { b: 2 } } } }).plugins.p).toEqual({
      enabled: false,
      config: { a: 1 },
    });
  });
});

describe("updateSettings", () => {
  test("validates, applies live, writes settings.json and reports sources", async () => {
    const { kernel, home } = await up();
    const res = await kernel.updateSettings("fx-set", { config: { level: 5, label: "x" } });
    expect(res.values).toEqual({ mode: "a", level: 5, label: "x" });
    expect(res.restartRequired).toBeUndefined();
    expect(live().ctx.config).toEqual({ mode: "a", level: 5, label: "x" });
    expect(live().calls).toHaveLength(1);
    expect(readSettings(home)).toEqual({ plugins: { "fx-set": { config: { level: 5, label: "x" } } } });
    const reset = await kernel.updateSettings("fx-set", { config: { label: null } });
    expect(reset.sources.label).toBeUndefined();
    expect(live().ctx.config).toEqual({ mode: "a", level: 5 });
  });

  test("a value outside the schema is refused and nothing is saved", async () => {
    const { kernel, home } = await up();
    await expect(kernel.updateSettings("fx-set", { config: { level: 9 } })).rejects.toThrow("at most 5");
    await expect(kernel.updateSettings("fx-set", { config: { nope: 1 } })).rejects.toThrow("unexpected");
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(live().ctx.config.level).toBe(3);
  });

  test("a throwing listener keeps the save; the plugin keeps its applied config", async () => {
    const { kernel, home } = await up();
    const res = await kernel.updateSettings("fx-set", { config: { reject: true } });
    expect(res.restartRequired).toBe("refused by plugin");
    expect(res.values.reject).toBe(true);
    expect(readSettings(home).plugins["fx-set"].config).toEqual({ reject: true });
    expect(live().ctx.config.reject).toBeUndefined();
    const fixed = await kernel.updateSettings("fx-set", { config: { reject: null } });
    expect(fixed.restartRequired).toBeUndefined();
  });

  test("onConfigCheck vetoes the save before anything is written", async () => {
    const { kernel, home } = await up();
    await expect(kernel.updateSettings("fx-set", { config: { veto: true } })).rejects.toThrow(
      "vetoed by plugin",
    );
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(live().ctx.config.veto).toBeUndefined();
  });

  test("{ enabled: false } skips config validation", async () => {
    const { kernel } = await up();
    expect((await kernel.updateSettings("fx-set", { enabled: false })).enabled).toBe(false);
  });

  test("a plugin with no listener saves and asks for a restart", async () => {
    const { kernel } = await up();
    const res = await kernel.updateSettings("fx-cold", { config: { n: 2 } });
    expect(res.values).toEqual({ n: 2 });
    expect(res.restartRequired).toBe("plugin does not support live config changes");
  });

  test("enabling and disabling is saved for the next start", async () => {
    const { kernel, home } = await up();
    expect((await kernel.updateSettings("fx-cold", { enabled: false })).restartRequired).toBe(
      "disabled; stops on restart",
    );
    expect(readSettings(home).plugins["fx-cold"]).toEqual({ enabled: false });
    const back = await kernel.updateSettings("fx-cold", { enabled: true });
    expect(back.restartRequired).toBeUndefined();
    expect(back.enabled).toBe(true);
    expect(readSettings(home)).toEqual({ plugins: {} });
  });

  test("unknown plugins are refused", async () => {
    const { kernel } = await up();
    await expect(kernel.updateSettings("nope", { config: {} })).rejects.toThrow("unknown plugin");
  });

  test("reload picks up a hand-edited settings.json", async () => {
    const { kernel, home } = await up();
    writeSettings(home, { plugins: { "fx-set": { config: { mode: "b" } } } });
    const result = await kernel.reload();
    expect(result.changed).toEqual(["fx-set"]);
    expect(live().ctx.config.mode).toBe("b");
  });
});

describe("control plane", () => {
  async function serve() {
    const env = await bootFx(FX, {
      config: {
        pluginPaths: [join(FX, "..", "auth"), fxRoot("settings")],
        plugins: { "valet-fixture-auth": { config: { token: "tok", role: "owner" } } },
      },
    });
    kernels.push(env.kernel);
    const control = createControlServer(env.kernel, { host: "127.0.0.1", port: 0 });
    control.start();
    servers.push(control);
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${control.baseUrl()}/api/core${path}`, {
        method,
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return { ...env, call };
  }

  test("GET and PATCH /settings", async () => {
    const { call } = await serve();
    const all = (await (await call("GET", "/settings")).json()) as { plugin: string; provides: string[] }[];
    expect(all.find((p) => p.plugin === "fx-set")?.provides).toEqual(["tools@1"]);
    const res = await call("PATCH", "/settings/fx-set", { config: { mode: "b" } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { values: { mode: string } }).values.mode).toBe("b");
    expect((await call("PATCH", "/settings/fx-set", { config: { level: 0 } })).status).toBe(400);
    const bad = await call("PATCH", "/settings/fx-set", { config: { level: 0 } });
    expect(((await bad.json()) as { error: { errors: Record<string, string> } }).error.errors).toEqual({
      level: "must be at least 1",
    });
    expect((await call("PATCH", "/settings/fx-set", { config: { veto: true } })).status).toBe(422);
    expect((await call("PATCH", "/settings/fx-set", { scope: "team" })).status).toBe(400);
    expect((await call("PATCH", "/settings/missing", { config: {} })).status).toBe(404);
    expect((await call("PATCH", "/settings/fx-set", { config: [] })).status).toBe(400);
  });

  test("secrets are written 0600, never read back, and removed", async () => {
    const { call, home, kernel } = await serve();
    const seen: string[] = [];
    kernel.bus.forPlugin("fx-watch", "watch").onSignal("core.secrets.changed", (p) => void seen.push(p.name));
    expect((await call("PUT", "/secrets/bad name", { value: "x" })).status).toBe(400);
    expect((await call("PUT", "/secrets/api-key", { value: "  k1 \n" })).status).toBe(200);
    expect(readFileSync(join(home, "secrets", "api-key"), "utf8")).toBe("k1");
    expect(statSync(join(home, "secrets", "api-key")).mode & 0o777).toBe(0o600);
    expect(await (await call("GET", "/secrets")).json()).toEqual([{ name: "api-key", source: "file" }]);
    expect(await (await call("GET", "/secrets/api-key")).json()).toEqual({ name: "api-key", source: "file" });
    process.env.OTHER_KEY = "v";
    try {
      expect(await (await call("GET", "/secrets/other-key")).json()).toEqual({
        name: "other-key",
        source: "env",
      });
    } finally {
      delete process.env.OTHER_KEY;
    }
    expect(await (await call("DELETE", "/secrets/api-key")).json()).toEqual({
      name: "api-key",
      source: null,
    });
    expect(seen).toEqual(["api-key", "api-key"]);
  });
});
