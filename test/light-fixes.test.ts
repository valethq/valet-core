import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  boot,
  createControlServer,
  createSecrets,
  validateJsonSchema,
  type ControlServer,
  type ValetKernel,
} from "@valethq/core";
import type { Logger } from "@valethq/sdk";

const FIXTURES = join(import.meta.dir, "fixtures");
const AUTH = { authorization: "Bearer tok" };
const JSON_POST = { ...AUTH, "content-type": "application/json" };
const CLI = join(import.meta.dir, "../packages/core/src/cli.ts");
const DISABLED_PLUGINS = join(FIXTURES, "plugins", "disabled");

interface Env {
  kernel: ValetKernel;
  control: ControlServer;
  base: string;
  home: string;
}

const running: Env[] = [];

async function up(opts: {
  fixtures?: string[];
  plugins?: Record<string, unknown>;
  settings?: unknown;
}): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), "valet-light-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      server: { allowedOrigins: [] },
      pluginPaths: (opts.fixtures ?? []).map((f) => join(FIXTURES, f)),
      plugins: opts.plugins ?? {},
    }),
  );
  if (opts.settings !== undefined) {
    writeFileSync(join(home, "settings.json"), JSON.stringify(opts.settings));
  }
  const kernel = await boot({ valetHome: home, dbPath: ":memory:", out: () => {} });
  const control = createControlServer(kernel, { host: "127.0.0.1", port: 0 });
  control.start();
  const env = { kernel, control, base: control.baseUrl(), home };
  running.push(env);
  return env;
}

afterEach(async () => {
  for (const env of running.splice(0)) {
    env.control.stop();
    await env.kernel.shutdown();
    rmSync(env.home, { recursive: true, force: true });
  }
});

const post = (base: string, path: string, body: unknown, headers: Record<string, string> = JSON_POST) =>
  fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) });

const silentLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

describe("light fixes", () => {
  test("createSecrets().get rejects invalid secret names", async () => {
    const home = mkdtempSync(join(tmpdir(), "valet-secrets-name-"));
    mkdirSync(join(home, "secrets"), { recursive: true });
    writeFileSync(join(home, "config.json"), "{}", { mode: 0o600 });
    const secrets = createSecrets(home, silentLog);
    try {
      await expect(secrets.get("../config.json")).rejects.toThrow('invalid secret name "../config.json"');
      await expect(secrets.require("..")).rejects.toThrow('invalid secret name ".."');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("POST /sessions/:id/messages ignores body authorPrincipalId when authenticated", async () => {
    const env = await up({
      fixtures: ["auth"],
      plugins: {
        "valet-fixture-auth": {
          config: { token: "tok", externalId: "owner", displayName: "Owner", role: "owner" },
        },
      },
    });
    const project = await post(env.base, "/api/core/projects", {
      name: "p",
      workspaceDir: mkdtempSync(join(tmpdir(), "valet-ws-")),
    });
    expect(project.status).toBe(201);
    const session = await post(env.base, "/api/core/sessions", {
      projectId: ((await project.json()) as { id: string }).id,
    });
    expect(session.status).toBe(201);
    const msg = await post(
      env.base,
      `/api/core/sessions/${((await session.json()) as { id: string }).id}/messages`,
      {
        role: "user",
        parts: [{ type: "text", text: "hi" }],
        authorPrincipalId: "forged-principal",
      },
    );
    expect(msg.status).toBe(201);
    const body = (await msg.json()) as { message: { authorPrincipalId: string | null } };
    expect(body.message.authorPrincipalId).not.toBe("forged-principal");
    expect(body.message.authorPrincipalId).not.toBeNull();
  });

  test("GET session and message lists reject bad limit and before query params", async () => {
    const env = await up({
      fixtures: ["auth"],
      plugins: { "valet-fixture-auth": { config: { token: "tok" } } },
    });
    for (const qs of ["?limit=foo", "?limit=-1", "?limit=0", "?before=not-a-number"]) {
      const res = await fetch(`${env.base}/api/core/sessions${qs}`, { headers: AUTH });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    }
    const projectRes = await post(env.base, "/api/core/projects", {
      name: "p",
      workspaceDir: mkdtempSync(join(tmpdir(), "valet-ws-")),
    });
    const sessionRes = await post(env.base, "/api/core/sessions", {
      projectId: ((await projectRes.json()) as { id: string }).id,
    });
    const sid = ((await sessionRes.json()) as { id: string }).id;
    for (const qs of ["?limit=foo", "?beforeSeq=NaN"]) {
      const res = await fetch(`${env.base}/api/core/sessions/${sid}/messages${qs}`, { headers: AUTH });
      expect(res.status).toBe(400);
    }
  });

  test("validateJsonSchema enforces numeric exclusiveMinimum and exclusiveMaximum", () => {
    const schema = { type: "number", exclusiveMinimum: 0 };
    expect(validateJsonSchema(0, schema)).toEqual(["config: must be greater than 0"]);
    expect(validateJsonSchema(-1, schema)).toEqual(["config: must be greater than 0"]);
    expect(validateJsonSchema(0.1, schema)).toEqual([]);

    const bounded = { type: "number", minimum: 1, exclusiveMinimum: true };
    expect(validateJsonSchema(1, bounded)).toEqual(["config: must be greater than 1"]);
    expect(validateJsonSchema(2, bounded)).toEqual([]);
  });

  test("valet doctor layers settings.json over config for plugin resolution", async () => {
    const home = mkdtempSync(join(tmpdir(), "valet-doctor-"));
    try {
      writeFileSync(
        join(home, "config.json"),
        JSON.stringify({ server: { allowedOrigins: [] }, pluginPaths: [DISABLED_PLUGINS], plugins: {} }),
      );
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({ plugins: { "valet-disabled": { enabled: false } } }),
      );
      const proc = Bun.spawn(["bun", CLI, "doctor", "--home", home], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      expect(stdout).toContain("disabled valet-disabled");
      expect(stdout).not.toMatch(/ok\s+valet-disabled/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
