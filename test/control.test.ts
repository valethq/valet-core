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

async function up(opts: {
  fixtures?: string[];
  plugins?: Record<string, unknown>;
  allowedOrigins?: string[];
  ringSize?: number;
}): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), "valet-ctl-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      server: { allowedOrigins: opts.allowedOrigins ?? [] },
      pluginPaths: (opts.fixtures ?? []).map((f) => join(FIXTURES, f)),
      plugins: opts.plugins ?? {},
    }),
  );
  const kernel = await boot({ valetHome: home, dbPath: ":memory:", out: () => {} });
  const control = createControlServer(kernel, {
    host: "127.0.0.1",
    port: 0,
    ...(opts.ringSize === undefined ? {} : { ringSize: opts.ringSize }),
  });
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

async function createProject(base: string): Promise<{ id: string }> {
  const res = await post(base, "/api/core/projects", { name: "p", workspaceDir: "/tmp/w" });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function createSession(base: string, projectId: string): Promise<{ id: string }> {
  const res = await post(base, "/api/core/sessions", { projectId, title: "t" });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

// ---- ws client helpers ------------------------------------------------------

function wsConnect(base: string, headers?: Record<string, string>): Promise<WebSocket> {
  const url = `${base.replace(/^http/, "ws")}/ws`;
  const ws = new WebSocket(url, headers === undefined ? undefined : { headers });
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
    ws.addEventListener("close", () => reject(new Error("ws closed before open")), { once: true });
  });
}

interface Collector {
  frames: ServerFrame[];
  next(pred: (f: ServerFrame) => boolean, ms?: number): Promise<ServerFrame>;
}

function collect(ws: WebSocket): Collector {
  const frames: ServerFrame[] = [];
  const waiters: { pred: (f: ServerFrame) => boolean; res: (f: ServerFrame) => void }[] = [];
  ws.addEventListener("message", (e) => {
    const frame = JSON.parse(String(e.data)) as ServerFrame;
    frames.push(frame);
    for (const w of [...waiters]) {
      if (w.pred(frame)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.res(frame);
      }
    }
  });
  return {
    frames,
    next(pred, ms = 3000) {
      const existing = frames.find(pred);
      if (existing) return Promise.resolve(existing);
      return Promise.race([
        new Promise<ServerFrame>((res) => waiters.push({ pred, res })),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("frame timeout")), ms)),
      ]);
    },
  };
}

async function waitUntil(pred: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error("waitUntil timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const send = (ws: WebSocket, frame: unknown): void => ws.send(JSON.stringify(frame));

// ---- tests ------------------------------------------------------------------

describe("zero plugins", () => {
  test("/ works, every non-public route fails closed, /ws refused", async () => {
    const env = await up({});

    const res = await fetch(`${env.base}/`);
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { name: string; version: string; plugins: unknown[] };
    expect(doc.name).toBe("valet");
    expect(typeof doc.version).toBe("string");
    expect(Array.isArray(doc.plugins)).toBe(true);
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");

    for (const path of [
      "/api/core/projects",
      "/api/core/sessions",
      "/api/core/plugins",
      "/plugins/valet-x/y",
      "/nope",
    ]) {
      const r = await fetch(`${env.base}${path}`);
      expect(r.status).toBe(401);
      expect(r.headers.get("content-security-policy")).toBe("default-src 'none'");
    }

    const wsRefused = await fetch(`${env.base}/ws`, {
      headers: {
        connection: "upgrade",
        upgrade: "websocket",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    expect(wsRefused.status).toBe(401);
    await expect(wsConnect(env.base)).rejects.toThrow();
  });
});

describe("identity + core REST", () => {
  test("authenticated requests pass; store actions carry the core caller and actor", async () => {
    const env = await up({
      fixtures: ["auth", "observe"],
      plugins: {
        "valet-fixture-auth": {
          config: { token: "tok", externalId: "owner", displayName: "Owner", role: "owner" },
        },
      },
    });

    expect((await fetch(`${env.base}/api/core/projects`)).status).toBe(401);
    const list = await fetch(`${env.base}/api/core/projects`, { headers: AUTH });
    expect(list.status).toBe(200);
    expect(list.headers.get("content-security-policy")).toBe("default-src 'none'");

    const project = await createProject(env.base);
    const session = await createSession(env.base, project.id);

    const msg = await post(env.base, `/api/core/sessions/${session.id}/messages`, {
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    expect(msg.status).toBe(201);
    const created = (await msg.json()) as { message: { authorPrincipalId: string | null; seq: number } };
    expect(created.message.authorPrincipalId).not.toBeNull();
    const listed = await fetch(`${env.base}/api/core/sessions/${session.id}/messages`, { headers: AUTH });
    expect(((await listed.json()) as unknown[]).length).toBe(1);

    const run = env.kernel.store.forCaller({ plugin: "core" }).runs.create({
      sessionId: session.id,
      role: "owner",
    });
    const cancel = await post(env.base, `/api/core/runs/${run.id}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect(env.kernel.store.forCaller({ plugin: "core" }).runs.get(run.id)?.status).toBe("cancelled");

    // Anonymous observer route: the recorded callers are the assertion.
    const seen = (await (await fetch(`${env.base}/plugins/valet-fixture-observe/seen`)).json()) as {
      name: string;
      caller: { plugin: string; actor?: { principalId: string; role: string }; authenticatedBy?: string };
      payload: { path?: string };
    }[];

    const sessionCreate = seen.find((s) => s.name === "session.create");
    expect(sessionCreate?.caller.plugin).toBe("core");
    expect(sessionCreate?.caller.actor?.role).toBe("owner");
    expect(sessionCreate?.caller.actor?.principalId ?? null).toBe(created.message.authorPrincipalId);
    expect(sessionCreate?.caller.authenticatedBy).toBe("valet-fixture-auth");

    const controlRequest = seen.find(
      (s) => s.name === "control.request" && s.payload.path === "/api/core/sessions",
    );
    expect(controlRequest?.caller.plugin).toBe("core");
    expect(controlRequest?.caller.authenticatedBy).toBe("valet-fixture-auth");
  });

  test("policy plugin denying control.request -> 403 with by", async () => {
    const env = await up({
      fixtures: ["auth", "deny"],
      plugins: {
        "valet-fixture-auth": { config: { token: "tok", role: "trusted" } },
        "valet-fixture-deny": { config: { deny: [{ kind: "http", path: "/api/core/projects" }] } },
      },
    });
    const res = await fetch(`${env.base}/api/core/projects`, { headers: AUTH });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; by: string; message: string } };
    expect(body.error.code).toBe("denied");
    expect(body.error.by).toBe("valet-fixture-deny");
    // Other paths still pass.
    expect((await fetch(`${env.base}/api/core/sessions`, { headers: AUTH })).status).toBe(200);
  });

  test("identity provider throwing ServiceDeniedError -> 403 immediately", async () => {
    const env = await up({
      fixtures: ["auth"],
      plugins: { "valet-fixture-auth": { config: { deny: true } } },
    });
    const res = await fetch(`${env.base}/api/core/projects`, { headers: AUTH });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("denied");
  });
});

describe("session delete", () => {
  test("DELETE removes the session, its messages and runs; children are orphaned; second delete 404s", async () => {
    const env = await up({
      fixtures: ["auth"],
      plugins: {
        "valet-fixture-auth": {
          config: { token: "tok", externalId: "owner", displayName: "Owner", role: "owner" },
        },
      },
    });
    const project = await createProject(env.base);
    const parent = await createSession(env.base, project.id);
    const child = (await (
      await post(
        env.base,
        "/api/core/sessions",
        { projectId: project.id, parentSessionId: parent.id },
        JSON_POST,
      )
    ).json()) as { id: string };
    await post(env.base, `/api/core/sessions/${parent.id}/messages`, {
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const run = env.kernel.store.forPlugin("valet-test").runs.create({ sessionId: parent.id, role: "owner" });

    const del = await fetch(`${env.base}/api/core/sessions/${parent.id}`, {
      method: "DELETE",
      headers: AUTH,
    });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { id: string }).id).toBe(parent.id);
    expect((await fetch(`${env.base}/api/core/sessions/${parent.id}`, { headers: AUTH })).status).toBe(404);
    expect((await fetch(`${env.base}/api/core/runs/${run.id}`, { headers: AUTH })).status).toBe(404);
    const orphan = (await (
      await fetch(`${env.base}/api/core/sessions/${child.id}`, { headers: AUTH })
    ).json()) as {
      parentSessionId: string | null;
    };
    expect(orphan.parentSessionId).toBeNull();
    expect(
      (await fetch(`${env.base}/api/core/sessions/${parent.id}`, { method: "DELETE", headers: AUTH })).status,
    ).toBe(404);
  });
});

describe("plugin routes", () => {
  test(":param routes, public webhook anonymous, text/html -> 500, CSP", async () => {
    const env = await up({
      fixtures: ["auth", "routes"],
      plugins: { "valet-fixture-auth": { config: { token: "tok" } } },
    });

    const echo = await fetch(`${env.base}/plugins/valet-fixture-routes/echo/hi`, { headers: AUTH });
    expect(echo.status).toBe(200);
    const body = (await echo.json()) as { word: string; principal: string | null };
    expect(body.word).toBe("hi");
    expect(body.principal).not.toBeNull();

    // Non-public plugin route still fails closed without identity.
    expect((await fetch(`${env.base}/plugins/valet-fixture-routes/echo/hi`)).status).toBe(401);

    // public: true is reachable anonymously (webhook semantics).
    const hook = await fetch(`${env.base}/plugins/valet-fixture-routes/hook`, {
      method: "POST",
      body: "raw",
    });
    expect(hook.status).toBe(200);
    expect(((await hook.json()) as { ok: boolean }).ok).toBe(true);

    // A plugin route answering text/html is replaced with a 500 JSON error.
    const page = await fetch(`${env.base}/plugins/valet-fixture-routes/page`, { headers: AUTH });
    expect(page.status).toBe(500);
    expect(((await page.json()) as { error: { code: string } }).error.code).toBe("html_not_allowed");
    expect(page.headers.get("content-security-policy")).toBe("default-src 'none'");
  });
});

describe("CORS", () => {
  test("allowed origin gets credentialed CORS; disallowed refused 403; preflight", async () => {
    const env = await up({ allowedOrigins: ["https://ui.example"] });

    const ok = await fetch(`${env.base}/`, { headers: { origin: "https://ui.example" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://ui.example");
    expect(ok.headers.get("access-control-allow-credentials")).toBe("true");

    const bad = await fetch(`${env.base}/`, { headers: { origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();

    const preflight = await fetch(`${env.base}/api/core/projects`, {
      method: "OPTIONS",
      headers: {
        origin: "https://ui.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://ui.example");
    expect(preflight.headers.get("access-control-allow-credentials")).toBe("true");

    const badPreflight = await fetch(`${env.base}/api/core/projects`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    });
    expect(badPreflight.status).toBe(403);
  });
});

describe("websocket", () => {
  test("sub/publish/seq, since replay, ping, call routing, plugin publish", async () => {
    const env = await up({
      fixtures: ["auth", "routes"],
      plugins: { "valet-fixture-auth": { config: { token: "tok", role: "trusted" } } },
    });

    await expect(wsConnect(env.base)).rejects.toThrow();
    const ws = await wsConnect(env.base, AUTH);
    const c = collect(ws);

    send(ws, { type: "ping" });
    expect((await c.next((f) => f.type === "pong")).type).toBe("pong");

    const project = await createProject(env.base);
    const topic = `sessions:${project.id}`;
    send(ws, { type: "sub", topics: [topic] });

    const session = await createSession(env.base, project.id);
    const ev1 = await c.next((f) => f.type === "event" && f.topic === topic);
    expect(ev1.type).toBe("event");
    if (ev1.type !== "event") return;
    expect(ev1.seq).toBe(1);
    expect(ev1.name).toBe("session.create");

    // session:<id> topic picks up message events.
    send(ws, { type: "sub", topics: [`session:${session.id}`] });
    await post(env.base, `/api/core/sessions/${session.id}/messages`, {
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const mev = await c.next((f) => f.type === "event" && f.topic === `session:${session.id}`);
    expect(mev.type).toBe("event");
    if (mev.type === "event") expect(mev.name).toBe("message.create");

    await createSession(env.base, project.id);
    await waitUntil(() => c.frames.filter((f) => f.type === "event" && f.topic === topic).length === 2);

    // since: replay frames after seq 1.
    send(ws, { type: "sub", topics: [topic], since: { [topic]: 1 } });
    await waitUntil(
      () => c.frames.filter((f) => f.type === "event" && f.topic === topic && f.seq === 2).length === 2,
    );

    // call routing: ok, denied handler, unknown method.
    send(ws, { type: "call", id: "a", method: "fx.ping", params: { x: 1 } });
    const ra = await c.next((f) => f.type === "result" && f.id === "a");
    expect(ra.type).toBe("result");
    if (ra.type === "result" && ra.ok) expect((ra.data as { pong: { x: number } }).pong.x).toBe(1);
    else expect.unreachable();

    send(ws, { type: "call", id: "b", method: "fx.fail" });
    const rb = await c.next((f) => f.type === "result" && f.id === "b");
    if (rb.type === "result" && !rb.ok) expect(rb.error.code).toBe("denied");
    else expect.unreachable();

    send(ws, { type: "call", id: "d", method: "nope.x" });
    const rd = await c.next((f) => f.type === "result" && f.id === "d");
    if (rd.type === "result" && !rd.ok) expect(rd.error.code).toBe("unknown_method");
    else expect.unreachable();

    // Plugin publish through ctx.ws reaches subscribers.
    send(ws, { type: "sub", topics: ["fx:news"] });
    send(ws, { type: "call", id: "e", method: "fx.shout", params: { m: "yo" } });
    const news = await c.next((f) => f.type === "event" && f.topic === "fx:news");
    if (news.type === "event") expect(news.data).toEqual({ m: "yo" });
    else expect.unreachable();

    ws.close();
  });

  test("denied sub reports code denied; denied call reports code denied", async () => {
    const env = await up({
      fixtures: ["auth", "deny", "routes"],
      plugins: {
        "valet-fixture-auth": { config: { token: "tok" } },
        "valet-fixture-deny": {
          config: {
            deny: [
              { kind: "ws.sub", path: "fx:secret" },
              { kind: "ws.call", path: "fx.ping" },
            ],
          },
        },
      },
    });
    const ws = await wsConnect(env.base, AUTH);
    const c = collect(ws);

    send(ws, { type: "sub", topics: ["fx:secret"] });
    const denied = await c.next((f) => f.type === "result" && f.id === "fx:secret");
    if (denied.type === "result" && !denied.ok) expect(denied.error.code).toBe("denied");
    else expect.unreachable();

    send(ws, { type: "call", id: "x", method: "fx.ping" });
    const deniedCall = await c.next((f) => f.type === "result" && f.id === "x");
    if (deniedCall.type === "result" && !deniedCall.ok) expect(deniedCall.error.code).toBe("denied");
    else expect.unreachable();

    ws.close();
  });

  test("gap when the requested seq fell out of the ring buffer", async () => {
    const env = await up({
      fixtures: ["auth"],
      plugins: { "valet-fixture-auth": { config: { token: "tok", role: "trusted" } } },
      ringSize: 2,
    });
    const project = await createProject(env.base);
    const topic = `sessions:${project.id}`;
    for (let i = 0; i < 4; i++) await createSession(env.base, project.id);

    const ws = await wsConnect(env.base, AUTH);
    const c = collect(ws);
    send(ws, { type: "sub", topics: [topic], since: { [topic]: 1 } });
    const gap = await c.next((f) => f.type === "gap");
    if (gap.type === "gap") expect(gap.topic).toBe(topic);
    else expect.unreachable();

    // A since that is still buffered replays instead of gapping.
    send(ws, { type: "sub", topics: [topic], since: { [topic]: 3 } });
    await c.next((f) => f.type === "event" && f.topic === topic && f.seq === 4);

    ws.close();
  });
});

describe("revocation and idempotent send", () => {
  const authEnv = () =>
    up({
      fixtures: ["auth"],
      plugins: { "valet-fixture-auth": { config: { token: "tok", externalId: "owner", role: "owner" } } },
    });
  const closeOf = (ws: WebSocket) =>
    new Promise<number>((res) => ws.addEventListener("close", (e) => res(e.code), { once: true }));

  test("identity.changed closes sockets whose credential stopped identifying (4401)", async () => {
    const env = await authEnv();
    const ws = await wsConnect(env.base, AUTH);
    const closed = closeOf(ws);
    const res = await fetch(`${env.base}/plugins/valet-fixture-auth/revoke`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(await closed).toBe(4401);
  });

  test("identity.changed leaves still-identified sockets open", async () => {
    const env = await authEnv();
    const ws = await wsConnect(env.base, AUTH);
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
    });
    await env.kernel.bus.emitAs({ plugin: "identity" }, "identity.changed", {});
    await new Promise((r) => setTimeout(r, 500));
    expect(closed).toBe(false);
    const c = collect(ws);
    send(ws, { type: "ping" });
    await c.next((f) => f.type === "pong");
    ws.close();
  });

  test("duplicate clientMessageId returns the first message and creates one", async () => {
    const env = await authEnv();
    const project = await createProject(env.base);
    const session = await createSession(env.base, project.id);
    const body = {
      role: "user",
      parts: [{ type: "text", text: "hi" }],
      clientMessageId: "c-1",
    };
    const path = `/api/core/sessions/${session.id}/messages`;
    const first = await post(env.base, path, body);
    expect(first.status).toBe(201);
    const a = (await first.json()) as { message: { id: string; meta: Record<string, unknown> } };
    expect(a.message.meta.clientMessageId).toBe("c-1");
    const second = await post(env.base, path, body);
    expect(second.status).toBe(200);
    expect(((await second.json()) as typeof a).message.id).toBe(a.message.id);
    const list = (await (await fetch(`${env.base}${path}`, { headers: AUTH })).json()) as unknown[];
    expect(list).toHaveLength(1);
    expect((await post(env.base, path, { ...body, clientMessageId: "x".repeat(101) })).status).toBe(400);
  });
});
