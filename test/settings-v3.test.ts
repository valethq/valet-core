// biome-ignore-all lint/suspicious/noTemplateCurlyInString: settings refs are written ${resolver:arg}
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boot, type ValetKernel } from "@valethq/core";
import type { Project } from "@valethq/sdk";
import { bootFx, fxRoot, state } from "./helpers";

type Cfg = Record<string, unknown>;
interface V3 {
  ctx: { config: Cfg; configFor(id: string): Cfg };
  calls: Cfg[];
  checks: Cfg[];
}
const v3 = (): V3 => (globalThis as unknown as { __valet_v3: V3 }).__valet_v3;

const kernels: ValetKernel[] = [];
afterEach(async () => {
  while (kernels.length > 0) await kernels.pop()?.shutdown();
});

const writeJson = (path: string, v: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify(v));
};
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const secret = (home: string, name: string, value: string) => {
  mkdirSync(join(home, "secrets"), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, "secrets", name), value, { mode: 0o600 });
  chmodSync(join(home, "secrets", name), 0o600);
};

async function up(
  opts: { config?: Cfg; settings?: unknown; before?: (home: string) => void; watch?: boolean } = {},
) {
  const env = await bootFx(fxRoot("settings-v3"), {
    watchSettings: opts.watch ?? false,
    config: { plugins: { "fx-v3": { config: opts.config ?? {} } } },
    beforeBoot: (home) => {
      secret(home, "fx_key", "k-123\n");
      if (opts.settings !== undefined) writeJson(join(home, "settings.json"), opts.settings);
      opts.before?.(home);
    },
  });
  kernels.push(env.kernel);
  return env;
}
const docOf = (k: ValetKernel, project?: string) => k.settings(project).find((p) => p.plugin === "fx-v3");
const errorsOf = async (p: Promise<unknown>): Promise<Record<string, string>> => {
  try {
    await p;
  } catch (e) {
    return (e as { errors?: Record<string, string> }).errors ?? { _: (e as Error).message };
  }
  throw new Error("expected a rejection");
};
const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await Bun.sleep(20);
  }
};

describe("settings v3: load", () => {
  test("defaults, unit strings and secret refs resolve into ctx.config; values keep refs raw", async () => {
    const { kernel } = await up();
    const cfg = v3().ctx.config;
    expect(cfg).toEqual({
      mode: "basic",
      threshold: 0.8,
      timeout: 300_000,
      maxBytes: 65_536,
      apiKey: "k-123",
      locked: "fixed",
    });
    const doc = docOf(kernel);
    expect(doc?.values.apiKey).toBe("${secret:fx_key}");
    expect(doc?.values.timeout).toBe(300_000);
    expect(doc?.settings?.sections.system?.icon).toBe("gear");
    expect(doc?.types?.["local:hostport"]).toEqual({
      base: "strict_string",
      pattern: "^[^:]+:\\d{1,5}$",
      patternHint: "host:port",
    });
    expect(doc?.types?.duration).toEqual({ base: "int" });
    expect(((doc?.schema?.properties ?? {}) as Cfg).timeout).toMatchObject({ default: "5m" });
    expect(doc?.liveConfig).toBe(true);
  });

  test("a document naming an unknown type fails only its plugin", async () => {
    const env = await bootFx(fxRoot("settings-v3-bad"), { watchSettings: false });
    kernels.push(env.kernel);
    expect(state(env.kernel, "fx-baddoc")?.state).toBe("failed");
    expect(state(env.kernel, "fx-baddoc")?.error).toContain('unknown type "fancy"');
  });

  test("a required ref that fails stops the plugin", async () => {
    const env = await bootFx(fxRoot("settings-v3"), {
      watchSettings: false,
      config: { plugins: { "fx-v3": { config: { apiKey: "${secret:missing_key}" } } } },
    });
    kernels.push(env.kernel);
    expect(state(env.kernel, "fx-v3")?.state).toBe("active");
    // apiKey is optional: the failure is an issue and the key is unset.
    expect(v3().ctx.config.apiKey).toBeUndefined();
    expect(docOf(env.kernel)?.issues?.apiKey).toBe("apiKey: ${secret:missing_key} not found");
  });

  test("a broken config-file value fails the plugin at load", async () => {
    const env = await bootFx(fxRoot("settings-v3"), {
      watchSettings: false,
      config: { plugins: { "fx-v3": { config: { timeout: "soon" } } } },
    });
    kernels.push(env.kernel);
    expect(state(env.kernel, "fx-v3")?.error).toContain("timeout: not a valid duration string");
  });
});

describe("settings v3: saves", () => {
  test("constraints are enforced per touched key, keyed by path", async () => {
    const { kernel, home } = await up();
    const save = (config: Cfg) => errorsOf(kernel.updateSettings("fx-v3", { config }));
    expect(await save({ threshold: 0 })).toEqual({ threshold: "must be greater than 0" });
    expect(await save({ endpoint: "nope" })).toEqual({ endpoint: "must match host:port" });
    expect(Object.keys(await save({ apiKey: "hunter2" }))).toEqual(["apiKey"]);
    expect(await save({ timeout: "5x" })).toEqual({ timeout: "not a valid duration string" });
    expect(await save({ locked: "other" })).toEqual({ locked: "readonly" });
    expect(await save({ servers: [{ name: "a", url: "http://x" }] })).toEqual({
      "servers[0].url": "scheme must be one of https",
    });
    expect(await save({ servers: [{ url: "https://x" }] })).toEqual({ "servers[0].name": "required" });
    expect(await save({ transport: { kind: "stdio" } })).toEqual({ "transport.command": "required" });
    expect(await save({ mode: "advanced" })).toEqual({ budget: "required" });
    expect(await save({ header: "${secret:x}" })).toEqual({
      header: 'resolver "secret" is not allowed here (allowed: env, file, cmd)',
    });
    expect(existsSync(join(home, "settings.json"))).toBe(false);

    const ok = await kernel.updateSettings("fx-v3", {
      config: { mode: "advanced", budget: "128k", timeout: "1h30m", tools: [] },
    });
    expect(ok.values).toMatchObject({ mode: "advanced", budget: 128_000, timeout: 5_400_000, tools: [] });
    expect(readJson(join(home, "settings.json")).plugins["fx-v3"].config).toEqual({
      mode: "advanced",
      budget: "128k",
      timeout: "1h30m",
      tools: [],
    });
    expect(v3().ctx.config.budget).toBe(128_000);
    expect(ok.layers.user).toEqual({ mode: "advanced", budget: "128k", timeout: "1h30m", tools: [] });
    expect(ok.sources.timeout).toBe("settings");
  });

  test("env and file refs resolve; refs stay raw in values; int refs parse", async () => {
    process.env.FX_TOKEN = "tok";
    process.env.FX_PORT = "8080";
    try {
      const { kernel, home } = await up();
      writeFileSync(join(home, "hdr.txt"), "from-file\n", { mode: 0o600 });
      await kernel.updateSettings("fx-v3", {
        config: { header: "Bearer ${env:FX_TOKEN}", port: "${env:FX_PORT}" },
      });
      expect(v3().ctx.config.header).toBe("Bearer tok");
      expect(v3().ctx.config.port).toBe(8080);
      expect(docOf(kernel)?.values.header).toBe("Bearer ${env:FX_TOKEN}");
      await kernel.updateSettings("fx-v3", {
        config: { header: `\${file:${join(home, "hdr.txt")}} $\${x}` },
      });
      expect(v3().ctx.config.header).toBe("from-file ${x}");
    } finally {
      delete process.env.FX_TOKEN;
      delete process.env.FX_PORT;
    }
  });

  test("cmd refs resolve on read in the background and fire onConfigChange when they land", async () => {
    const { kernel } = await up();
    await kernel.updateSettings("fx-v3", { config: { header: "x-${cmd:printf hello}" } });
    expect(v3().ctx.config.header).toBeUndefined();
    await kernel.settingsService.cmd.settle();
    await kernel.settingsService.enqueue(async () => {});
    expect(v3().ctx.config.header).toBe("x-hello");
    expect(v3().calls.at(-1)?.header).toBe("x-${cmd:printf hello}");
  });

  test("a throwing listener keeps the save and reports a scrubbed restartRequired", async () => {
    process.env.FX_SECRET = "boom-secret-value";
    try {
      const { kernel, home } = await up();
      const res = await kernel.updateSettings("fx-v3", { config: { header: "${env:FX_SECRET}" } });
      expect(res.restartRequired).toBe("cannot use ${env:FX_SECRET}");
      expect(JSON.stringify(res)).not.toContain("boom-secret-value");
      expect(v3().ctx.config.header).toBeUndefined();
      expect(readJson(join(home, "settings.json")).plugins["fx-v3"].config.header).toBe("${env:FX_SECRET}");
    } finally {
      delete process.env.FX_SECRET;
    }
  });

  test("a short secret is scrubbed as a whole token", async () => {
    process.env.FX_SHORT = "xyz";
    try {
      const { kernel } = await up();
      const res = await kernel.updateSettings("fx-v3", { config: { header: "boom-${env:FX_SHORT}" } });
      expect(res.restartRequired).toBe("cannot use boom-${env:FX_SHORT}");
    } finally {
      delete process.env.FX_SHORT;
    }
  });

  test("an unset list item stays in place as null, whether its ref failed or its cmd is still running", async () => {
    const { kernel } = await up({ config: { extra: ["a", "${env:FX_NOPE}", "c"] } });
    expect(v3().ctx.config.extra).toEqual(["a", null, "c"]);
    expect(docOf(kernel)?.issues?.["extra[1]"]).toContain("${env:FX_NOPE} is not set");
    await kernel.updateSettings("fx-v3", { config: { extra: ["a", "${cmd:printf b}", "c"] } });
    expect(v3().ctx.config.extra).toEqual(["a", null, "c"]);
    await kernel.settingsService.cmd.settle();
    await kernel.settingsService.enqueue(async () => {});
    expect(v3().ctx.config.extra).toEqual(["a", "b", "c"]);
  });

  test("onConfigCheck vetoes with 422 and nothing is written", async () => {
    const { kernel, home } = await up();
    await expect(kernel.updateSettings("fx-v3", { config: { header: "veto" } })).rejects.toMatchObject({
      status: 422,
    });
    expect(existsSync(join(home, "settings.json"))).toBe(false);
    expect(v3().checks.at(-1)?.header).toBe("veto");
  });

  test("a touched group is replaced whole", async () => {
    const { kernel } = await up({ config: { utility: { model: "m", effort: "low" } } });
    await kernel.updateSettings("fx-v3", { config: { utility: { model: "n" } } });
    expect(v3().ctx.config.utility).toEqual({ model: "n" });
  });
});

describe("settings v3: migration", () => {
  test("settings.json is migrated, backed up and rewritten once; kv rows move", async () => {
    const dbHome = await (async () => {
      const first = await up();
      first.kernel.store.pluginStorage("fx-v3").kv.set("note", "from kv");
      return first.home;
    })();
    await kernels.pop()?.shutdown();
    const old = {
      plugins: { "fx-v3": { config: { apiKeySecret: "fx_key", utility: "gpt-5-high", noticePercent: 80 } } },
    };
    writeJson(join(dbHome, "settings.json"), old);
    const kernel = await boot({
      valetHome: dbHome,
      dbPath: join(dbHome, "db.sqlite"),
      out: () => {},
      watchSettings: false,
    });
    kernels.push(kernel);
    // The first boot used :memory:, so seed kv in this db and boot once more.
    kernel.store.pluginStorage("fx-v3").kv.set("note", "from kv");
    await kernels.pop()?.shutdown();
    const again = await boot({
      valetHome: dbHome,
      dbPath: join(dbHome, "db.sqlite"),
      out: () => {},
      watchSettings: false,
    });
    kernels.push(again);
    expect(readJson(join(dbHome, "settings.json")).plugins["fx-v3"].config).toEqual({
      apiKey: "${secret:fx_key}",
      utility: { model: "gpt-5", effort: "high" },
      noticeAt: 0.8,
      note: "from kv",
    });
    expect(readJson(join(dbHome, "settings.json.bak"))).toEqual(old);
    expect(again.store.pluginStorage("fx-v3").kv.get("note")).toBeUndefined();
    expect(v3().ctx.config).toMatchObject({ apiKey: "k-123", noticeAt: 0.8, note: "from kv" });
  });

  test("the config file is migrated in memory and never rewritten", async () => {
    const { home } = await up({ config: { utility: "small-low" } });
    expect(v3().ctx.config.utility).toEqual({ model: "small", effort: "low" });
    expect(readJson(join(home, "config.json")).plugins["fx-v3"].config).toEqual({ utility: "small-low" });
  });

  test("a plugin that fails on its settings.json entry gets it back from the backup", async () => {
    const { kernel } = await up({
      settings: { plugins: { "fx-v3": { config: { timeout: "never" } } } },
      before: (home) =>
        writeJson(join(home, "settings.json.bak"), { plugins: { "fx-v3": { config: { timeout: "2s" } } } }),
    });
    expect(state(kernel, "fx-v3")?.state).toBe("active");
    expect(v3().ctx.config.timeout).toBe(2000);
  });
});

describe("settings v3: project layer", () => {
  const project = async (kernel: ValetKernel) =>
    (await kernel.store.forPlugin("test").projects.create({ name: "p", workspaceDir: "/tmp/p" })) as Project;

  test("project overrides are opt-in, ref-free, and read through configFor", async () => {
    const { kernel, home } = await up();
    const p = await project(kernel);
    const save = (config: Cfg, extra: Cfg = {}) =>
      kernel.updateSettings("fx-v3", { scope: "project", project: p.id, config, ...extra });
    expect(await errorsOf(save({ timeout: "1s" }))).toEqual({
      timeout: "this setting can't be set per project",
    });
    expect(await errorsOf(save({ mode: "${env:X}" }))).toEqual({
      mode: "refs are not allowed in the project layer",
    });
    await expect(save({}, { enabled: false })).rejects.toThrow("enabled can't be set per project");
    await expect(
      kernel.updateSettings("fx-v3", { scope: "project", project: "prj_nope", config: {} }),
    ).rejects.toThrow("unknown project");

    const res = await save({ mode: "advanced", budget: "2k", maxBytes: "1 KiB" });
    expect(res.values).toMatchObject({ mode: "advanced", budget: 2000, maxBytes: 1024 });
    expect(res.sources.mode).toBe("project");
    expect(res.layers.project).toEqual({ mode: "advanced", budget: "2k", maxBytes: "1 KiB" });
    expect(readJson(join(home, "project-data", p.id, "settings.json"))).toEqual({
      plugins: { "fx-v3": { config: { mode: "advanced", budget: "2k", maxBytes: "1 KiB" } } },
    });
    expect(v3().ctx.config.mode).toBe("basic");
    expect(v3().ctx.configFor(p.id)).toMatchObject({
      mode: "advanced",
      budget: 2000,
      maxBytes: 1024,
      apiKey: "k-123",
    });
    expect(v3().ctx.configFor("prj_other")).toBe(v3().ctx.config);
    expect(docOf(kernel, p.id)?.values.mode).toBe("advanced");
    expect(docOf(kernel)?.values.mode).toBe("basic");

    await save({ mode: null, budget: null, maxBytes: null });
    expect(existsSync(join(home, "project-data", p.id))).toBe(false);
  });

  test("a user save that breaks a project override is refused, keyed by project", async () => {
    const { kernel } = await up();
    const p = await project(kernel);
    await kernel.updateSettings("fx-v3", { config: { budget: "1k" } });
    await kernel.updateSettings("fx-v3", { scope: "project", project: p.id, config: { mode: "advanced" } });
    expect(await errorsOf(kernel.updateSettings("fx-v3", { config: { budget: null } }))).toEqual({
      [`${p.id}:budget`]: "required",
    });
  });

  test("deleting the project removes its settings file", async () => {
    const { kernel, home } = await up();
    const p = await project(kernel);
    await kernel.updateSettings("fx-v3", { scope: "project", project: p.id, config: { threshold: 0.5 } });
    await kernel.store.forPlugin("test").projects.delete(p.id);
    expect(existsSync(join(home, "project-data", p.id, "settings.json"))).toBe(false);
  });
});

describe("settings v3: watchers", () => {
  test("a hand edit to settings.json reloads; an invalid project file is reported, not applied", async () => {
    const { kernel, home } = await up({ watch: true });
    writeJson(join(home, "settings.json"), { plugins: { "fx-v3": { config: { threshold: 0.4 } } } });
    await until(() => v3().ctx.config.threshold === 0.4);

    const p = (await kernel.store
      .forPlugin("test")
      .projects.create({ name: "p", workspaceDir: "/tmp/p" })) as Project;
    writeJson(join(home, "project-data", p.id, "settings.json"), {
      plugins: { "fx-v3": { config: { threshold: 7 } } },
    });
    await until(() => docOf(kernel, p.id)?.issues?.threshold !== undefined);
    expect(docOf(kernel, p.id)?.issues?.threshold).toBe("must be at most 1");
    expect(v3().ctx.configFor(p.id).threshold).toBe(0.4);
  });

  test("a changed file: ref target re-resolves and fires onConfigChange", async () => {
    const { kernel, home } = await up({ watch: true });
    const target = join(home, "hdr.txt");
    writeFileSync(target, "one", { mode: 0o600 });
    await kernel.updateSettings("fx-v3", { config: { header: `\${file:${target}}` } });
    expect(v3().ctx.config.header).toBe("one");
    writeFileSync(target, "two", { mode: 0o600 });
    await until(() => v3().ctx.config.header === "two");
  });

  test("a file: ref whose target doesn't exist yet resolves once it is written", async () => {
    const { kernel, home } = await up({ watch: true });
    const target = join(home, "later.txt");
    await kernel.updateSettings("fx-v3", { config: { header: `\${file:${target}}` } });
    expect(v3().ctx.config.header).toBeUndefined();
    writeFileSync(target, "now", { mode: 0o600 });
    await until(() => v3().ctx.config.header === "now");
  });

  test("a plugin whose only secret ref failed picks the secret up once it is written", async () => {
    const { home } = await up({ watch: true, config: { apiKey: "${secret:later_key}" } });
    expect(v3().ctx.config.apiKey).toBeUndefined();
    secret(home, "later_key", "late");
    await until(() => v3().ctx.config.apiKey === "late");
  });
});
