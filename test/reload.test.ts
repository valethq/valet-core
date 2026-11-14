import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ControlServer, createControlServer, type ValetKernel } from "@valethq/core";
import { bootFx, fxRoot, state } from "./helpers";

interface Live {
  ctx: { config: { n?: number } };
  calls: [{ n?: number; fail?: boolean }, { n?: number }][];
}
const live = (): Live => (globalThis as unknown as { __valet_live: Live }).__valet_live;

const kernels: ValetKernel[] = [];
afterEach(async () => {
  while (kernels.length > 0) await kernels.pop()?.shutdown();
  delete (globalThis as unknown as { __valet_live?: Live }).__valet_live;
});

async function up(config: Record<string, unknown> = {}): Promise<{ kernel: ValetKernel; home: string }> {
  const env = await bootFx(fxRoot("reload"), { config });
  kernels.push(env.kernel);
  return env;
}

const writeConfig = (home: string, config: Record<string, unknown>) =>
  writeFileSync(join(home, "config.json"), JSON.stringify({ pluginPaths: [fxRoot("reload")], ...config }));

describe("config reload", () => {
  test("applies a changed block live and tells the listener old and new", async () => {
    const { kernel, home } = await up({ plugins: { "fx-live": { config: { n: 1 } } } });
    expect(live().ctx.config).toEqual({ n: 1 });
    writeConfig(home, { plugins: { "fx-live": { config: { n: 2 } } } });
    const result = await kernel.reload();
    expect(result).toEqual({ ok: true, changed: ["fx-live"], restartRequired: [], errors: [] });
    expect(live().ctx.config).toEqual({ n: 2 });
    expect(live().calls).toEqual([[{ n: 2 }, { n: 1 }]]);
    expect(state(kernel, "fx-live")?.restartRequired).toBeUndefined();
  });

  test("an unchanged config reloads as a no-op", async () => {
    const { kernel } = await up({ plugins: { "fx-live": { config: { n: 1 } } } });
    const result = await kernel.reload();
    expect(result).toEqual({ ok: true, changed: [], restartRequired: [], errors: [] });
    expect(live().calls).toEqual([]);
  });

  test("a block that fails its configSchema rejects the whole reload", async () => {
    const { kernel, home } = await up({ plugins: { "fx-live": { config: { n: 1 } } } });
    writeConfig(home, {
      server: { allowedOrigins: ["http://x"] },
      plugins: { "fx-live": { config: { n: "two" } } },
    });
    const result = await kernel.reload();
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain('plugin "fx-live"');
    expect(live().ctx.config).toEqual({ n: 1 });
    expect(live().calls).toEqual([]);
    expect(kernel.config.server.allowedOrigins).toEqual([]);
  });

  test("an unparseable file is rejected and the old config stays", async () => {
    const { kernel, home } = await up({ plugins: { "fx-live": { config: { n: 1 } } } });
    writeFileSync(join(home, "config.toml"), "[server\n");
    const result = await kernel.reload();
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("TOML");
    expect(live().ctx.config).toEqual({ n: 1 });
  });

  test("config.toml is picked up on reload", async () => {
    const { kernel, home } = await up();
    // Windows paths contain backslashes, which a TOML basic string reads as escapes.
    const root = fxRoot("reload").replaceAll("\\", "/");
    writeFileSync(
      join(home, "config.toml"),
      `pluginPaths = ["${root}"]\n[plugins.fx-live.config]\nn = 7\n`,
    );
    const result = await kernel.reload();
    expect(result.changed).toEqual(["fx-live"]);
    expect(live().ctx.config).toEqual({ n: 7 });
  });

  test("a listener that throws means restart required and the old config is restored", async () => {
    const { kernel, home } = await up({ plugins: { "fx-live": { config: { n: 1 } } } });
    writeConfig(home, { plugins: { "fx-live": { config: { n: 2, fail: true } } } });
    const result = await kernel.reload();
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual([]);
    expect(result.restartRequired).toEqual([{ plugin: "fx-live", reason: "cannot apply live" }]);
    expect(live().ctx.config).toEqual({ n: 1 });
    expect(state(kernel, "fx-live")?.restartRequired).toBe("cannot apply live");
  });

  test("a plugin with no listener is reported as restart-required", async () => {
    const { kernel, home } = await up();
    writeConfig(home, { plugins: { "fx-static": { config: { a: 1 } } } });
    const result = await kernel.reload();
    expect(result.restartRequired).toEqual([
      { plugin: "fx-static", reason: "plugin does not support live config changes" },
    ]);
    expect(state(kernel, "fx-static")?.restartRequired).toBeDefined();
  });

  test("allowedOrigins apply live; server port, pluginPaths, scopes and enabled flags need a restart", async () => {
    const { kernel, home } = await up();
    writeConfig(home, {
      server: { port: 9999, allowedOrigins: ["http://a"] },
      scopes: { "x@1": "y" },
      plugins: { "fx-static": { enabled: false } },
    });
    const result = await kernel.reload();
    expect(result.restartRequired.map((r) => r.reason).sort()).toEqual(
      ["plugins.fx-static.enabled", "scopes", "server host/port"].sort(),
    );
    expect(kernel.config.server.allowedOrigins).toEqual(["http://a"]);
    expect(kernel.config.server.port).toBe(7417);
  });

  test("emits core.config.changed", async () => {
    const seen: unknown[] = [];
    const home = (await up({ plugins: { "fx-live": { config: { n: 1 } } } })).home;
    const kernel = kernels[0] as ValetKernel;
    kernel.bus.forPlugin("core").onSignal("core.config.changed", (p) => seen.push(p));
    writeConfig(home, { plugins: { "fx-live": { config: { n: 2 } } } });
    await kernel.reload();
    expect(seen).toEqual([{ changed: ["fx-live"], restartRequired: [] }]);
  });
});

describe("POST /api/core/config/reload", () => {
  let control: ControlServer | undefined;
  afterEach(() => control?.stop());

  test("requires auth, reloads, and answers 400 for a rejected config", async () => {
    const paths = [join(import.meta.dir, "fixtures", "auth"), fxRoot("reload")];
    const authBlock = { "valet-fixture-auth": { config: { token: "tok", role: "owner" } } };
    const configWith = (n: unknown) => ({
      pluginPaths: paths,
      plugins: { ...authBlock, "fx-live": { config: { n } } },
    });
    const env = await bootFx(fxRoot("reload"), { config: configWith(1) });
    kernels.push(env.kernel);
    control = createControlServer(env.kernel, { host: "127.0.0.1", port: 0 });
    control.start();
    const url = `${control.baseUrl()}/api/core/config/reload`;
    expect((await fetch(url, { method: "POST" })).status).toBe(401);

    const auth = { authorization: "Bearer tok" };
    writeConfig(env.home, configWith(3));
    const ok = await fetch(url, { method: "POST", headers: auth });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { changed: string[] }).changed).toEqual(["fx-live"]);

    writeConfig(env.home, configWith("x"));
    const bad = await fetch(url, { method: "POST", headers: auth });
    expect(bad.status).toBe(400);
    expect(live().ctx.config).toEqual({ n: 3 });
  });
});
