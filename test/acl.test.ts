import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerFrame } from "@valethq/sdk";
import { boot, type ControlServer, createControlServer, type ValetKernel } from "@valethq/core";

const FIXTURES = join(import.meta.dir, "fixtures");
const AUTH = { authorization: "Bearer tok" };
const JSON_POST = { ...AUTH, "content-type": "application/json" };

interface Env {
  kernel: ValetKernel;
  control: ControlServer;
  base: string;
  home: string;
}
const running: Env[] = [];

async function up(auth: Record<string, unknown>, fixtures = ["auth", "acl"]): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), "valet-acl-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      pluginPaths: fixtures.map((f) => join(FIXTURES, f)),
      plugins: { "valet-fixture-auth": { config: { token: "tok", ...auth } } },
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

const get = (env: Env, path: string, headers: Record<string, string> = AUTH) =>
  fetch(`${env.base}${path}`, { headers });
const post = (env: Env, path: string, body: unknown) =>
  fetch(`${env.base}${path}`, { method: "POST", headers: JSON_POST, body: JSON.stringify(body) });
const patch = (env: Env, path: string, body: unknown) =>
  fetch(`${env.base}${path}`, { method: "PATCH", headers: JSON_POST, body: JSON.stringify(body) });

async function project(env: Env): Promise<string> {
  const store = env.kernel.store.forCaller({ plugin: "core" });
  const p = await store.projects.create({
    name: "p",
    workspaceDir: mkdtempSync(join(tmpdir(), "valet-ws-")),
  });
  return (p as { id: string }).id;
}

function ws(env: Env): Promise<{ sock: WebSocket; frames: ServerFrame[] }> {
  const sock = new WebSocket(`${env.base.replace(/^http/, "ws")}/ws`, { headers: AUTH });
  const frames: ServerFrame[] = [];
  sock.addEventListener("message", (e) => frames.push(JSON.parse(String(e.data)) as ServerFrame));
  return new Promise((resolve, reject) => {
    sock.addEventListener("open", () => resolve({ sock, frames }), { once: true });
    sock.addEventListener("error", () => reject(new Error("ws failed")), { once: true });
  });
}

async function frame(frames: ServerFrame[], pred: (f: ServerFrame) => boolean): Promise<ServerFrame> {
  const end = Date.now() + 2000;
  for (;;) {
    const found = frames.find(pred);
    if (found) return found;
    if (Date.now() > end) throw new Error("frame timeout");
    await Bun.sleep(10);
  }
}

describe("core permissions in dispatch", () => {
  test("a guest is refused core writes, sees a filtered (empty) list, and reaches only guest permissions", async () => {
    const env = await up({ role: "guest" });
    await project(env);
    const list = await get(env, "/api/core/projects");
    expect(list.status).toBe(200);
    expect(await list.json()).toEqual([]);
    const created = await post(env, "/api/core/projects", {
      workspaceDir: mkdtempSync(join(tmpdir(), "w-")),
    });
    expect(created.status).toBe(403);
    expect(((await created.json()) as { error: { by: string } }).error.by).toBe("core");
    expect((await get(env, "/api/core/plugins")).status).toBe(403);
    expect((await get(env, "/plugins/valet-fixture-acl/open")).status).toBe(200);
    expect((await get(env, "/plugins/valet-fixture-acl/implicit")).status).toBe(403);
    expect((await get(env, "/plugins/valet-fixture-acl/items/1")).status).toBe(403);
  });

  test("an owner gets everything, but sensitive administration needs a verified login", async () => {
    const env = await up({ role: "owner", verified: false });
    expect((await get(env, "/api/core/plugins")).status).toBe(200);
    expect((await get(env, "/plugins/valet-fixture-acl/implicit")).status).toBe(200);
    expect((await get(env, "/plugins/valet-fixture-acl/items/7")).status).toBe(200);
    const settings = await patch(env, "/api/core/settings/valet-fixture-acl", { config: {} });
    expect(settings.status).toBe(403);
    expect(JSON.stringify(await settings.json())).toContain("verified login");
    expect((await post(env, "/api/core/config/reload", {})).status).toBe(403);

    const verified = await up({ role: "owner" });
    expect((await post(verified, "/api/core/config/reload", {})).status).toBe(200);
  });

  test("a capped credential reaches only its patterns", async () => {
    const env = await up({ role: "owner", cap: ["core:project.read", "fxacl:*"] });
    const id = await project(env);
    expect((await get(env, `/api/core/projects/${id}`)).status).toBe(200);
    expect((await get(env, "/plugins/valet-fixture-acl/items/1")).status).toBe(200);
    expect((await get(env, "/api/core/sessions")).status).toBe(200);
    expect(await (await get(env, "/api/core/sessions")).json()).toEqual([]);
    expect((await post(env, "/api/core/sessions", { projectId: id })).status).toBe(403);
    const decision = (await (await get(env, "/plugins/valet-fixture-acl/can/core:plugin.read")).json()) as {
      allow: boolean;
      reason: string;
    };
    expect(decision.allow).toBe(false);
    expect(decision.reason).toContain("not allowed");
  });

  test("can() in a plugin: undeclared permissions are denied; caller evidence is core-stamped", async () => {
    const env = await up({ role: "owner" });
    const nope = (await (await get(env, "/plugins/valet-fixture-acl/can/fxacl:nope")).json()) as {
      allow: boolean;
    };
    expect(nope.allow).toBe(false);
    const ok = (await (await get(env, "/plugins/valet-fixture-acl/can/core:secret.read")).json()) as {
      allow: boolean;
    };
    expect(ok.allow).toBe(true);
  });

  test("ctx.control.dispatch identifies the request itself; a plugin cannot mint evidence", async () => {
    const env = await up({ role: "owner" });
    const anon = (await (await get(env, "/plugins/valet-fixture-acl/relay", {})).json()) as {
      status: number;
    };
    expect(anon.status).toBe(401);
    const authed = (await (await get(env, "/plugins/valet-fixture-acl/relay")).json()) as { status: number };
    expect(authed.status).toBe(200);
  });

  test("setRole guards the last owner over REST (409)", async () => {
    const env = await up({ role: "owner" });
    const me = env.kernel.store
      .forCaller({ plugin: "core" })
      .principals.resolveIdentity("fixture", "fixture-user");
    const res = await post(env, `/api/core/principals/${me.id}/role`, { role: "guest" });
    expect(res.status).toBe(409);
  });

  test("link challenges are minted only for yourself and are single use", async () => {
    const env = await up({ role: "owner" });
    const store = env.kernel.store.forCaller({ plugin: "core" });
    const me = store.principals.resolveIdentity("fixture", "fixture-user");
    const other = store.principals.resolveIdentity("discord", "999");
    expect((await post(env, `/api/core/principals/${other.id}/link-challenge`, {})).status).toBe(403);
    const minted = await post(env, "/api/core/principals/me/link-challenge", {});
    expect(minted.status).toBe(201);
    const { code } = (await minted.json()) as { code: string };
    const platform = env.kernel.store.forPlugin("valet-discord");
    await platform.principals.link(me.id, "discord", "123", { code });
    expect(store.principals.identities(me.id)).toContainEqual({ platform: "discord", externalId: "123" });
    await expect(platform.principals.link(me.id, "discord", "456", { code })).rejects.toThrow("invalid");
  });

  test("namespace conflicts between plugin acls fail the second plugin", async () => {
    const env = await up({ role: "owner" }, ["auth", "acl-dup"]);
    const states = Object.fromEntries(env.kernel.plugins().map((p) => [p.id, p]));
    expect(states["valet-fixture-dup-a"]?.state).toBe("active");
    expect(states["valet-fixture-dup-b"]?.state).toBe("failed");
    expect(states["valet-fixture-dup-b"]?.error).toContain("dupns");
  });
});

describe("topics and calls", () => {
  test("core topics need core:session.read; declared topics and calls use their permission", async () => {
    const env = await up({ role: "guest" });
    const { sock, frames } = await ws(env);
    try {
      sock.send(JSON.stringify({ type: "sub", topics: ["session:ses_x", "fxacl:feed:1"] }));
      const denied = await frame(frames, (f) => f.type === "result" && f.id === "session:ses_x");
      expect(denied.type === "result" && !denied.ok && denied.error.code).toBe("denied");
      await fetch(`${env.base}/plugins/valet-fixture-acl/publish`, { method: "POST", body: '{"n":1}' });
      const tick = await frame(frames, (f) => f.type === "event" && f.topic === "fxacl:feed:1");
      expect(tick.type === "event" && tick.data).toEqual({ n: 1 });
      sock.send(JSON.stringify({ type: "call", id: "a", method: "fxacl.secret" }));
      sock.send(JSON.stringify({ type: "call", id: "b", method: "fxacl.hello" }));
      const a = await frame(frames, (f) => f.type === "result" && f.id === "a");
      const b = await frame(frames, (f) => f.type === "result" && f.id === "b");
      expect(a.type === "result" && !a.ok && a.error.code).toBe("denied");
      expect(b.type === "result" && b.ok && b.data).toEqual({ hello: true });
    } finally {
      sock.close();
    }
  });

  test("a demotion drops subscriptions the principal no longer holds", async () => {
    const env = await up({ role: "owner" });
    const store = env.kernel.store.forCaller({ plugin: "core" });
    const pid = await project(env);
    const { sock, frames } = await ws(env);
    try {
      sock.send(JSON.stringify({ type: "sub", topics: [`sessions:${pid}`] }));
      sock.send(JSON.stringify({ type: "ping" }));
      await frame(frames, (f) => f.type === "pong");
      const me = store.principals.resolveIdentity("fixture", "fixture-user");
      const other = store.principals.resolveIdentity("fixture", "other");
      await store.principals.setRole(other.id, "owner");
      await store.principals.setRole(me.id, "trusted");
      const dropped = await frame(frames, (f) => f.type === "result" && f.id === `sessions:${pid}`);
      expect(dropped.type === "result" && !dropped.ok && dropped.error.code).toBe("denied");
    } finally {
      sock.close();
    }
  });
});
