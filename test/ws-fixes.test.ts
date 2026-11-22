import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type ControlServer, createControlServer, type ValetKernel } from "@valethq/core";
import type { ServerFrame } from "@valethq/sdk";

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
const sockets: WebSocket[] = [];

async function up(opts: { ringSize?: number } = {}): Promise<Env> {
  const home = mkdtempSync(join(tmpdir(), "valet-ws-fix-"));
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      server: { allowedOrigins: [] },
      pluginPaths: [join(FIXTURES, "auth")],
      plugins: {
        "valet-fixture-auth": {
          config: { token: "tok", externalId: "owner", displayName: "Owner", role: "owner" },
        },
      },
    }),
  );
  const kernel = await boot({
    valetHome: home,
    dbPath: ":memory:",
    out: () => {},
    ...(opts.ringSize === undefined ? {} : { ringSize: opts.ringSize }),
  });
  const control = createControlServer(kernel, { host: "127.0.0.1", port: 0 });
  control.start();
  const env = { kernel, control, base: control.baseUrl(), home };
  running.push(env);
  return env;
}

afterAll(async () => {
  for (const ws of sockets) ws.close();
  for (const env of running.splice(0)) {
    env.control.stop();
    await env.kernel.shutdown();
    rmSync(env.home, { recursive: true, force: true });
  }
});

const post = (base: string, path: string, body: unknown) =>
  fetch(`${base}${path}`, { method: "POST", headers: JSON_POST, body: JSON.stringify(body) });

async function createProject(base: string): Promise<{ id: string }> {
  const workspaceDir = mkdtempSync(join(tmpdir(), "valet-ws-dir-"));
  const res = await post(base, "/api/core/projects", { name: "p", workspaceDir });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

async function createSession(base: string, projectId: string, title = "t"): Promise<{ id: string }> {
  const res = await post(base, "/api/core/sessions", { projectId, title });
  expect(res.status).toBe(201);
  return (await res.json()) as { id: string };
}

function wsConnect(base: string): Promise<WebSocket> {
  const url = `${base.replace(/^http/, "ws")}/ws`;
  const ws = new WebSocket(url, { headers: AUTH });
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve(ws), { once: true });
    ws.addEventListener("error", () => reject(new Error("ws connect failed")), { once: true });
    ws.addEventListener("close", () => reject(new Error("ws closed before open")), { once: true });
  });
}

interface Collector {
  frames: ServerFrame[];
}

function collect(ws: WebSocket): Collector {
  const frames: ServerFrame[] = [];
  ws.addEventListener("message", (e) => {
    frames.push(JSON.parse(String(e.data)) as ServerFrame);
  });
  return { frames };
}

const send = (ws: WebSocket, frame: unknown): void => ws.send(JSON.stringify(frame));

async function waitFrame(
  c: Collector,
  from: number,
  pred: (f: ServerFrame) => boolean,
  ms = 3000,
): Promise<ServerFrame> {
  const end = Date.now() + ms;
  for (;;) {
    const found = c.frames.slice(from).find(pred);
    if (found !== undefined) return found;
    if (Date.now() > end) throw new Error("frame timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Ping after queued frames so the pong means every earlier frame on this socket has been handled. */
async function barrier(ws: WebSocket, c: Collector): Promise<number> {
  const from = c.frames.length;
  send(ws, { type: "ping" });
  await waitFrame(c, from, (f) => f.type === "pong");
  return from;
}

async function eventsAfter(ws: WebSocket, c: Collector, run: () => Promise<void>): Promise<ServerFrame[]> {
  const from = c.frames.length;
  await run();
  send(ws, { type: "ping" });
  await waitFrame(c, from, (f) => f.type === "pong");
  return c.frames.slice(from);
}

function eventNamed(
  frames: ServerFrame[],
  name: string,
): Extract<ServerFrame, { type: "event" }> | undefined {
  const found = frames.find((f) => f.type === "event" && f.name === name);
  return found?.type === "event" ? found : undefined;
}

/** Holds control.request admission for one topic so a test can publish or unsub mid-await. */
function holdTopic(
  env: Env,
  topic: string,
): { entered: Promise<void>; release: () => void; stop: () => void } {
  let resolveEntered: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    resolveEntered = resolve;
  });
  let resolveGate: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    resolveGate = resolve;
  });
  let open = true;
  const release = (): void => {
    if (!open) return;
    open = false;
    resolveGate?.();
  };
  const sub = env.kernel.bus.forPlugin("ws-fixes").before("control.request", async (e) => {
    if (e.payload.kind !== "ws.sub" || e.payload.path !== topic) return;
    resolveEntered?.();
    await gate;
  });
  return {
    entered,
    release,
    stop() {
      release();
      sub.disconnect();
    },
  };
}

describe("ws hub fixes", () => {
  test("re-identify writes the demoted role onto the socket and keeps it open", async () => {
    const env = await up();
    const roles: string[] = [];
    const hook = env.kernel.bus.forPlugin("ws-fixes").before("control.request", (e) => {
      if (e.payload.path !== "probe:role" && e.payload.path !== "nope.role") return;
      roles.push(`${e.payload.kind}:${e.caller.actor?.role ?? "none"}`);
    });
    const ws = await wsConnect(env.base);
    let closed = false;
    ws.addEventListener("close", () => {
      closed = true;
    });
    const c = collect(ws);

    send(ws, { type: "sub", topics: ["probe:role"] });
    send(ws, { type: "call", id: "c1", method: "nope.role" });
    const first = await waitFrame(c, 0, (f) => f.type === "result" && f.id === "c1");
    if (first.type !== "result" || first.ok) throw new Error("expected unknown_method");
    expect(first.error.code).toBe("unknown_method");
    expect(roles).toEqual(["ws.sub:owner", "ws.call:owner"]);

    const store = env.kernel.store.forCaller({ plugin: "core" });
    const principal = store.principals.resolveIdentity("fixture", "owner");
    expect(principal.role).toBe("owner");
    const other = store.principals.resolveIdentity("fixture", "second-owner");
    await store.principals.setRole(other.id, "owner");
    await store.principals.setRole(principal.id, "guest");
    expect(store.principals.get(principal.id)?.role).toBe("guest");
    await env.kernel.bus.emitAs({ plugin: "identity" }, "identity.changed", {});

    const deadline = Date.now() + 2000;
    let demoted = false;
    while (Date.now() < deadline) {
      const from = c.frames.length;
      send(ws, { type: "sub", topics: ["probe:role"] });
      send(ws, { type: "call", id: "c2", method: "nope.role" });
      const result = await waitFrame(c, from, (f) => f.type === "result" && f.id === "c2");
      if (result.type !== "result" || result.ok) throw new Error("expected unknown_method");
      // core now denies the owner-only topic itself, so only the call reaches control.request
      if (roles.at(-1) === "ws.call:guest") {
        demoted = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 40));
    }
    expect(demoted).toBe(true);
    expect(closed).toBe(false);
    hook.disconnect();
    ws.close();
  });

  test("unsub during admit is applied, so the topic does not stay subscribed", async () => {
    const env = await up();
    const topic = "probe:race";
    const other = "probe:other";
    const held = holdTopic(env, topic);
    const ws = await wsConnect(env.base);
    const c = collect(ws);
    try {
      send(ws, { type: "sub", topics: [topic] });
      await held.entered;
      send(ws, { type: "unsub", topics: [topic] });
      send(ws, { type: "sub", topics: [other] });
      send(ws, { type: "ping" });
      held.release();
      await waitFrame(c, 0, (f) => f.type === "pong");
      env.control.publish(topic, "late", { n: 1 });
      env.control.publish(other, "ok", { n: 1 });
      await waitFrame(c, 0, (f) => f.type === "event" && f.topic === other);
      expect(c.frames.filter((f) => f.type === "event" && f.topic === topic)).toEqual([]);
      expect(c.frames.filter((f) => f.type === "event" && f.topic === other)).toHaveLength(1);
    } finally {
      held.stop();
      ws.close();
    }
  });

  test("sub without since replays frames published during admit, not earlier ones", async () => {
    const env = await up();
    const topic = "probe:live";
    const held = holdTopic(env, topic);
    const ws = await wsConnect(env.base);
    const c = collect(ws);
    try {
      env.control.publish(topic, "early", { n: 0 });
      send(ws, { type: "sub", topics: [topic] });
      await held.entered;
      env.control.publish(topic, "mid", { n: 1 });
      held.release();
      await waitFrame(c, 0, (f) => f.type === "event" && f.topic === topic && f.name === "mid");
      env.control.publish(topic, "late", { n: 2 });
      await waitFrame(c, 0, (f) => f.type === "event" && f.topic === topic && f.name === "late");
      const names = c.frames
        .filter((f) => f.type === "event" && f.topic === topic)
        .map((f) => (f.type === "event" ? f.name : ""));
      expect(names).toEqual(["mid", "late"]);
    } finally {
      held.stop();
      ws.close();
    }
  });

  test("since ahead of latest is a gap, and since at the buffer edge replays", async () => {
    const env = await up({ ringSize: 2 });
    const seqTopic = "probe:seq";
    const edgeTopic = "probe:edge";
    for (let i = 1; i <= 4; i++) env.control.publish(seqTopic, "tick", { i });
    for (let i = 1; i <= 2; i++) env.control.publish(edgeTopic, "tick", { i });

    const ws = await wsConnect(env.base);
    const c = collect(ws);
    try {
      send(ws, { type: "sub", topics: [seqTopic], since: { [seqTopic]: 2 } });
      await waitFrame(c, 0, (f) => f.type === "event" && f.topic === seqTopic && f.seq === 3);
      await waitFrame(c, 0, (f) => f.type === "event" && f.topic === seqTopic && f.seq === 4);
      expect(c.frames.some((f) => f.type === "gap")).toBe(false);
      const seqs = c.frames
        .filter((f) => f.type === "event" && f.topic === seqTopic)
        .map((f) => (f.type === "event" ? f.seq : 0));
      expect(seqs).toEqual([3, 4]);

      const caughtUp = c.frames.length;
      send(ws, { type: "sub", topics: [seqTopic], since: { [seqTopic]: 4 } });
      await barrier(ws, c);
      expect(c.frames.slice(caughtUp).filter((f) => f.type === "event" || f.type === "gap")).toEqual([]);

      send(ws, { type: "sub", topics: [edgeTopic], since: { [edgeTopic]: 0 } });
      await waitFrame(c, caughtUp, (f) => f.type === "event" && f.topic === edgeTopic && f.seq === 1);
      await waitFrame(c, caughtUp, (f) => f.type === "event" && f.topic === edgeTopic && f.seq === 2);
      expect(c.frames.filter((f) => f.type === "gap")).toEqual([]);

      send(ws, { type: "sub", topics: [seqTopic], since: { [seqTopic]: 1 } });
      const behind = await waitFrame(c, 0, (f) => f.type === "gap" && f.topic === seqTopic);
      expect(behind.type).toBe("gap");

      const beforeAhead = c.frames.length;
      send(ws, { type: "sub", topics: [seqTopic], since: { [seqTopic]: 100 } });
      const ahead = await waitFrame(c, beforeAhead, (f) => f.type === "gap" && f.topic === seqTopic);
      expect(ahead.type).toBe("gap");
      expect(c.frames.slice(beforeAhead).filter((f) => f.type === "event")).toEqual([]);

      send(ws, { type: "sub", topics: ["probe:empty"], since: { "probe:empty": 9 } });
      const reset = await waitFrame(c, beforeAhead, (f) => f.type === "gap" && f.topic === "probe:empty");
      expect(reset.type).toBe("gap");
    } finally {
      ws.close();
    }
  });

  test("session.delete and session.update publish the payload project id", async () => {
    const env = await up();
    const project = await createProject(env.base);
    const session = await createSession(env.base, project.id);
    const topic = `sessions:${project.id}`;
    const ws = await wsConnect(env.base);
    const c = collect(ws);
    send(ws, { type: "sub", topics: [topic] });
    await barrier(ws, c);

    const updated = await eventsAfter(ws, c, async () => {
      const res = await fetch(`${env.base}/api/core/sessions/${session.id}`, {
        method: "PATCH",
        headers: JSON_POST,
        body: JSON.stringify({ title: "renamed" }),
      });
      expect(res.status).toBe(200);
    });
    expect(eventNamed(updated, "session.update")?.data).toMatchObject({
      session: { id: session.id, projectId: project.id, title: "renamed" },
    });

    const deleted = await eventsAfter(ws, c, async () => {
      const res = await fetch(`${env.base}/api/core/sessions/${session.id}`, {
        method: "DELETE",
        headers: AUTH,
      });
      expect(res.status).toBe(200);
    });
    expect(eventNamed(deleted, "session.delete")?.data).toMatchObject({
      session: { id: session.id, projectId: project.id },
    });
    expect(env.kernel.store.forCaller({ plugin: "core" }).sessions.get(session.id)).toBeUndefined();
    ws.close();
  });

  test("cancelled session and message actions are not published", async () => {
    const env = await up();
    const project = await createProject(env.base);
    const topic = `sessions:${project.id}`;
    const ws = await wsConnect(env.base);
    const c = collect(ws);
    send(ws, { type: "sub", topics: [topic] });
    await barrier(ws, c);
    const store = env.kernel.store.forCaller({ plugin: "core" });

    const blockCreate = env.kernel.bus.forPlugin("ws-fixes").before("session.create", (e) => {
      e.cancel("fixture cancel");
    });
    const blockedCreate = await eventsAfter(ws, c, async () => {
      const res = await post(env.base, "/api/core/sessions", { projectId: project.id, title: "nope" });
      expect(res.status).toBe(409);
    });
    expect(eventNamed(blockedCreate, "session.create")).toBeUndefined();
    blockCreate.disconnect();

    let sessionId = "";
    const created = await eventsAfter(ws, c, async () => {
      const session = await createSession(env.base, project.id, "ok");
      sessionId = session.id;
    });
    expect(eventNamed(created, "session.create")?.data).toMatchObject({
      session: { id: sessionId, projectId: project.id },
    });

    send(ws, { type: "sub", topics: [`session:${sessionId}`] });
    await barrier(ws, c);

    const blockUpdate = env.kernel.bus.forPlugin("ws-fixes").before("session.update", (e) => {
      e.cancel("fixture cancel");
    });
    const blockedUpdate = await eventsAfter(ws, c, async () => {
      const res = await fetch(`${env.base}/api/core/sessions/${sessionId}`, {
        method: "PATCH",
        headers: JSON_POST,
        body: JSON.stringify({ title: "blocked" }),
      });
      expect(res.status).toBe(409);
    });
    expect(eventNamed(blockedUpdate, "session.update")).toBeUndefined();
    blockUpdate.disconnect();
    const updated = await eventsAfter(ws, c, async () => {
      const res = await fetch(`${env.base}/api/core/sessions/${sessionId}`, {
        method: "PATCH",
        headers: JSON_POST,
        body: JSON.stringify({ title: "applied" }),
      });
      expect(res.status).toBe(200);
    });
    expect(eventNamed(updated, "session.update")).toBeDefined();

    const blockMessage = env.kernel.bus.forPlugin("ws-fixes").before("message.create", (e) => {
      e.cancel("fixture cancel");
    });
    const blockedMessage = await eventsAfter(ws, c, async () => {
      const res = await post(env.base, `/api/core/sessions/${sessionId}/messages`, {
        role: "user",
        parts: [{ type: "text", text: "/stop" }],
      });
      expect(res.status).toBe(409);
    });
    expect(eventNamed(blockedMessage, "message.create")).toBeUndefined();
    blockMessage.disconnect();

    let messageId = "";
    const posted = await eventsAfter(ws, c, async () => {
      const res = await post(env.base, `/api/core/sessions/${sessionId}/messages`, {
        role: "user",
        parts: [{ type: "text", text: "hi" }],
      });
      expect(res.status).toBe(201);
      messageId = ((await res.json()) as { message: { id: string } }).message.id;
    });
    expect(eventNamed(posted, "message.create")).toBeDefined();

    const blockComplete = env.kernel.bus.forPlugin("ws-fixes").before("message.complete", (e) => {
      e.cancel("fixture cancel");
    });
    const blockedComplete = await eventsAfter(ws, c, async () => {
      const res = await post(env.base, `/api/core/messages/${messageId}/complete`, { status: "error" });
      expect(res.status).toBe(200);
    });
    expect(eventNamed(blockedComplete, "message.complete")).toBeUndefined();
    expect(store.messages.list(sessionId)[0]?.message.status).toBe("complete");
    blockComplete.disconnect();
    const completed = await eventsAfter(ws, c, async () => {
      const res = await post(env.base, `/api/core/messages/${messageId}/complete`, { status: "error" });
      expect(res.status).toBe(200);
    });
    expect(eventNamed(completed, "message.complete")).toBeDefined();
    expect(store.messages.list(sessionId)[0]?.message.status).toBe("error");

    const blockDelete = env.kernel.bus.forPlugin("ws-fixes").before("session.delete", (e) => {
      e.cancel("fixture cancel");
    });
    const blockedDelete = await eventsAfter(ws, c, async () => {
      const res = await fetch(`${env.base}/api/core/sessions/${sessionId}`, {
        method: "DELETE",
        headers: AUTH,
      });
      expect(res.status).toBe(409);
    });
    expect(eventNamed(blockedDelete, "session.delete")).toBeUndefined();
    expect(store.sessions.get(sessionId)).toBeDefined();
    blockDelete.disconnect();
    const deleted = await eventsAfter(ws, c, async () => {
      const res = await fetch(`${env.base}/api/core/sessions/${sessionId}`, {
        method: "DELETE",
        headers: AUTH,
      });
      expect(res.status).toBe(200);
    });
    expect(eventNamed(deleted, "session.delete")?.data).toMatchObject({
      session: { id: sessionId, projectId: project.id },
    });
    ws.close();
  });
});
