import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Principal } from "@valethq/sdk";
import { boot, type ControlServer, createControlServer, type ValetKernel } from "@valethq/core";

const FIXTURES = join(import.meta.dir, "fixtures");

interface Env {
  kernel: ValetKernel;
  control: ControlServer;
  base: string;
  home: string;
}

const running: Env[] = [];

/** Boots with the auth + observe fixtures; `role` is the principal the bearer token resolves to. */
async function up(
  opts: {
    role?: "owner" | "trusted" | "guest";
    extraFixtures?: string[];
    plugins?: Record<string, unknown>;
  } = {},
): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), "valet-authz-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      pluginPaths: ["auth", "observe", ...(opts.extraFixtures ?? [])].map((f) => join(FIXTURES, f)),
      plugins: {
        "valet-fixture-auth": {
          config: { token: "tok", externalId: "friend", displayName: "Friend", role: opts.role ?? "trusted" },
        },
        ...(opts.plugins ?? {}),
      },
    }),
  );
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

const AUTH = { authorization: "Bearer tok", "content-type": "application/json" };

const call = (base: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: AUTH,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const store = (env: Env) => env.kernel.store.forCaller({ plugin: "core" });

/** Creates a session as the caller and returns its id. */
async function session(env: Env): Promise<string> {
  const project = (await (
    await call(env.base, "POST", "/api/core/projects", { name: "p", workspaceDir: "/w" })
  ).json()) as {
    id: string;
  };
  const ses = (await (
    await call(env.base, "POST", "/api/core/sessions", { projectId: project.id })
  ).json()) as {
    id: string;
  };
  return ses.id;
}

async function ownerPrincipal(env: Env): Promise<Principal> {
  const owner = store(env).principals.resolveIdentity("web", "owner", { displayName: "Owner" });
  await store(env).principals.setRole(owner.id, "owner");
  return owner;
}

describe("control-plane authorization: role gate", () => {
  test("a trusted principal cannot change a role; the owner can", async () => {
    const env = await up({ role: "trusted" });
    const owner = await ownerPrincipal(env);

    const denied = await call(env.base, "POST", `/api/core/principals/${owner.id}/role`, { role: "guest" });
    expect(denied.status).toBe(403);
    const body = (await denied.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden");
    expect(body.error.message).toContain("owner");
    // The write never happened.
    expect(store(env).principals.get(owner.id)?.role).toBe("owner");
  });

  test("a trusted principal cannot link an identity", async () => {
    const env = await up({ role: "trusted" });
    const owner = await ownerPrincipal(env);

    const denied = await call(env.base, "POST", `/api/core/principals/${owner.id}/link`, {
      platform: "web",
      externalId: "friend",
    });
    expect(denied.status).toBe(403);
  });

  test("a trusted principal cannot list plugins or reload config", async () => {
    const env = await up({ role: "trusted" });

    expect((await call(env.base, "GET", "/api/core/plugins")).status).toBe(403);
    expect((await call(env.base, "POST", "/api/core/config/reload", {})).status).toBe(403);
  });

  test("a guest reaches no core route", async () => {
    const env = await up({ role: "guest" });

    for (const [method, path] of [
      ["GET", "/api/core/projects"],
      ["GET", "/api/core/sessions"],
      ["POST", "/api/core/projects"],
      ["GET", "/api/core/plugins"],
    ] as const) {
      const res = await call(env.base, method, path, method === "POST" ? {} : undefined);
      expect(res.status).toBe(403);
    }
  });

  test("the owner role passes the gate end to end", async () => {
    const env = await up({ role: "owner" });
    const other = store(env).principals.resolveIdentity("web", "other", { displayName: "Other" });

    const role = await call(env.base, "POST", `/api/core/principals/${other.id}/role`, { role: "trusted" });
    expect(role.status).toBe(200);
    expect(store(env).principals.get(other.id)?.role).toBe("trusted");

    const link = await call(env.base, "POST", `/api/core/principals/${other.id}/link`, {
      platform: "web",
      externalId: "other-login",
    });
    expect(link.status).toBe(200);

    expect((await call(env.base, "GET", "/api/core/plugins")).status).toBe(200);
    expect((await call(env.base, "POST", "/api/core/config/reload", {})).status).toBe(200);
  });

  test("the role gate is reported before the handler runs, so a 404 path stays 404", async () => {
    const env = await up({ role: "trusted" });
    expect((await call(env.base, "GET", "/api/core/nope")).status).toBe(404);
  });
});

describe("control-plane authorization: message author", () => {
  test("a message cannot be authored as another principal", async () => {
    const env = await up({ role: "trusted" });
    const owner = await ownerPrincipal(env);
    const id = await session(env);

    const forged = await call(env.base, "POST", `/api/core/sessions/${id}/messages`, {
      role: "user",
      authorPrincipalId: owner.id,
      parts: [{ type: "text", text: "x" }],
    });
    expect(forged.status).toBe(403);
    expect(store(env).messages.list(id)).toHaveLength(0);

    // The caller's own id is accepted.
    const own = await call(env.base, "POST", `/api/core/sessions/${id}/messages`, {
      role: "user",
      authorPrincipalId: store(env).principals.resolveIdentity("fixture", "friend").id,
      parts: [{ type: "text", text: "x" }],
    });
    expect(own.status).toBe(201);
  });

  test("omitting authorPrincipalId still stamps the authenticated principal", async () => {
    const env = await up({ role: "trusted" });
    const id = await session(env);

    const res = await call(env.base, "POST", `/api/core/sessions/${id}/messages`, {
      role: "user",
      parts: [{ type: "text", text: "x" }],
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { message: { authorPrincipalId: string } };
    expect(created.message.authorPrincipalId).not.toBeNull();
    expect(created.message.authorPrincipalId).toBe(
      store(env).principals.resolveIdentity("fixture", "friend").id,
    );
  });
});

describe("role changes are observable", () => {
  test("setRole emits principal.role with the caller and both roles", async () => {
    const env = await up({ role: "owner" });
    const target = store(env).principals.resolveIdentity("web", "target", { displayName: "Target" });
    const seen: { name: string; caller: unknown; payload: unknown }[] = [];
    env.kernel.bus.forPlugin("test").after("principal.role", (e) => {
      seen.push({ name: e.name, caller: e.caller, payload: e.payload });
    });

    await store(env).principals.setRole(target.id, "trusted");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.payload).toMatchObject({ role: "trusted", previous: "guest" });
    expect(seen[0]?.caller).toMatchObject({ plugin: "core" });
  });

  test("a before hook can deny a role change", async () => {
    const env = await up({ role: "owner" });
    const target = store(env).principals.resolveIdentity("web", "target", { displayName: "Target" });
    env.kernel.bus.forPlugin("test").before("principal.role", (e) => e.deny("no promotions"));

    await expect(store(env).principals.setRole(target.id, "owner")).rejects.toThrow("no promotions");
    expect(store(env).principals.get(target.id)?.role).toBe("guest");
  });

  test("an unknown principal still throws before any event", async () => {
    const env = await up({ role: "owner" });
    let fired = false;
    env.kernel.bus.forPlugin("test").after("principal.role", () => {
      fired = true;
    });
    await expect(store(env).principals.setRole("pri_missing", "owner")).rejects.toThrow(
      'unknown principal "pri_missing"',
    );
    expect(fired).toBe(false);
  });
});

describe("identity providers fail closed", () => {
  /** Boots with only the broken provider, so nothing can stand in for it. */
  async function brokenOnly(): Promise<Env> {
    const home = mkdtempSync(join(tmpdir(), "valet-authz-"));
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({
        pluginPaths: [join(FIXTURES, "broken-auth"), join(FIXTURES, "observe")],
        plugins: { "valet-fixture-auth": { enabled: false } },
      }),
    );
    const kernel = await boot({ valetHome: home, dbPath: ":memory:", out: () => {} });
    const control = createControlServer(kernel, { host: "127.0.0.1", port: 0 });
    control.start();
    const env = { kernel, control, base: control.baseUrl(), home };
    running.push(env);
    return env;
  }

  test("a provider that throws yields 503 instead of falling through to anonymous", async () => {
    const env = await brokenOnly();
    expect(env.kernel.scopes.providers("identity").map((p) => p.plugin)).toEqual([
      "valet-fixture-broken-auth",
    ]);

    const res = await fetch(`${env.base}/api/core/projects`, { headers: AUTH });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("identity_unavailable");
    // A public route still needs identity to run (it is identified, not gated), so it is 503 too.
    expect((await fetch(`${env.base}/`)).status).toBe(503);
  });

  test("a provider throwing ServiceDeniedError still yields 403", async () => {
    const env = await up({ plugins: { "valet-fixture-auth": { config: { token: "tok", deny: true } } } });
    const res = await fetch(`${env.base}/api/core/projects`, { headers: AUTH });
    expect(res.status).toBe(403);
  });
});
