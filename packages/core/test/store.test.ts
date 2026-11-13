import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Caller,
  type CancelledResult,
  ServiceDeniedError,
  type Store,
  type ValetEvents,
} from "@valethq/sdk";
import { createCoreBus, type CoreBus, type HookErrorReport, openStore, type OpenedStore } from "../src/index";

type EvName = Extract<keyof ValetEvents, string>;

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function isCancelled(value: unknown): value is CancelledResult {
  return typeof value === "object" && value !== null && (value as { cancelled?: boolean }).cancelled === true;
}

let bus: CoreBus;
let store: OpenedStore;
let view: Store;
let hookErrors: HookErrorReport[];

beforeEach(async () => {
  hookErrors = [];
  bus = createCoreBus({ logger, onHookError: (r) => hookErrors.push(r) });
  const valetHome = mkdtempSync(join(tmpdir(), "valet-store-"));
  store = await openStore({ valetHome, dbPath: ":memory:", bus, logger });
  view = store.forPlugin("valet-test");
});

/** Record the caller seen by one event, on behalf of a "policy" plugin. */
function watch<N extends EvName>(name: N): { callers: Caller[]; payloads: ValetEvents[N][] } {
  const seen = { callers: [] as Caller[], payloads: [] as ValetEvents[N][] };
  bus.forPlugin("valet-watch").before(name, (e) => {
    seen.callers.push(e.caller);
    seen.payloads.push(e.payload);
  });
  return seen;
}

async function makeProject(storeView: Store = view) {
  const project = await storeView.projects.create({ name: "helper", workspaceDir: "/tmp/ws" });
  if (isCancelled(project)) throw new Error("project.create cancelled");
  return project;
}

async function makeSession(projectId: string, storeView: Store = view) {
  const session = await storeView.sessions.create({ projectId, title: "t" });
  if (isCancelled(session)) throw new Error("session.create cancelled");
  return session;
}

describe("projects", () => {
  test("create, get, list and update", async () => {
    const project = await makeProject();
    expect(project.id).toStartWith("prj_");
    expect(view.projects.get(project.id)?.name).toBe("helper");
    expect(view.projects.list()).toHaveLength(1);

    const updated = await view.projects.update(project.id, { name: "renamed", settings: { persona: "x" } });
    if (isCancelled(updated)) throw new Error("update cancelled");
    expect(updated.name).toBe("renamed");
    expect(updated.settings).toEqual({ persona: "x" });
    expect(view.projects.get(project.id)?.name).toBe("renamed");
  });

  test("emits project.create with the plugin's stamped caller", async () => {
    const seen = watch("project.create");
    await makeProject();
    expect(seen.callers).toEqual([{ plugin: "valet-test" }]);
    expect(seen.payloads[0]?.project.name).toBe("helper");
  });

  test("store.as() puts the actor and its role on the caller", async () => {
    const principal = view.principals.resolveIdentity("web", "owner", { displayName: "Owner" });
    await view.principals.setRole(principal.id, "owner");
    const seen = watch("project.create");
    await makeProject(view.as({ principalId: principal.id }));
    expect(seen.callers[0]?.plugin).toBe("valet-test");
    expect(seen.callers[0]?.actor).toEqual({ principalId: principal.id, role: "owner" });
  });

  test("a before hook can rewrite the payload", async () => {
    bus.forPlugin("valet-rewriter").before("project.create", (e) => {
      e.payload = { project: { ...e.payload.project, name: "rewritten" } };
    });
    const project = await makeProject();
    expect(project.name).toBe("rewritten");
    expect(view.projects.get(project.id)?.name).toBe("rewritten");
  });
});

describe("sessions", () => {
  test("create, list, update, bind and provider state", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    expect(session.id).toStartWith("ses_");
    expect(session.status).toBe("idle");

    expect(view.sessions.list({ projectId: project.id })).toHaveLength(1);
    expect(view.sessions.list({ status: "archived" })).toHaveLength(0);

    const updated = await view.sessions.update(session.id, { color: "mauve", status: "running" });
    if (isCancelled(updated)) throw new Error("update cancelled");
    expect(updated.color).toBe("mauve");

    await view.sessions.bind(session.id, { platform: "discord", conversationId: "c1" });
    expect(view.sessions.findByBinding("discord", "c1")?.id).toBe(session.id);
    expect(view.sessions.findByBinding("discord", "nope")).toBeUndefined();

    view.sessions.setProviderState(session.id, "devin-cli", { resumeId: "r1" });
    expect(view.sessions.get(session.id)?.providerState).toEqual({ "devin-cli": { resumeId: "r1" } });
  });

  test("sessions.update carries the patch to hooks", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const seen = watch("session.update");
    await view.sessions.update(session.id, { title: "new" });
    expect(seen.payloads[0]?.patch).toEqual({ title: "new" });
    expect(seen.payloads[0]?.session.title).toBe("new");
  });
});

describe("messages", () => {
  test("create with parts, ordered list and seq", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "user",
      parts: [
        { type: "text", text: "hello" },
        { type: "notice", level: "info", text: "hi" },
      ],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    expect(created.message.id).toStartWith("msg_");
    expect(created.message.seq).toBe(1);
    expect(created.parts.map((p) => p.idx)).toEqual([0, 1]);

    const second = await view.messages.create({ sessionId: session.id, role: "assistant", parts: [] });
    if (isCancelled(second)) throw new Error("cancelled");
    expect(second.message.seq).toBe(2);

    const list = view.messages.list(session.id);
    expect(list.map((m) => m.message.seq)).toEqual([1, 2]);
    expect(list[0]?.parts[0]?.data).toEqual({ type: "text", text: "hello" });
    expect(view.messages.list(session.id, { beforeSeq: 2 })).toHaveLength(1);
    expect(view.messages.list(session.id, { limit: 1 })[0]?.message.seq).toBe(2);
    expect(view.sessions.get(session.id)?.lastMessageAt).not.toBeNull();
  });

  test("message.create defaults caller.actor to the author principal", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const principal = view.principals.resolveIdentity("web", "friend", { displayName: "Friend" });
    const seen = watch("message.create");
    await view.messages.create({
      sessionId: session.id,
      role: "user",
      authorPrincipalId: principal.id,
      parts: [{ type: "text", text: "hi" }],
    });
    expect(seen.callers[0]?.actor).toEqual({ principalId: principal.id, role: "guest" });
  });

  test("openPart streams deltas as signals and checkpoints the row", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");

    const deltas: string[] = [];
    bus.forPlugin("valet-ui").onSignal("message.delta", (p) => deltas.push(`${p.kind}:${p.delta}`));
    const writer = view.messages.openPart(created.message.id, { type: "text", text: "" });
    writer.append("he");
    writer.append("llo");
    expect(deltas).toEqual(["text:he", "text:llo"]);

    writer.close("complete", { type: "text", text: "hello" });
    const row = view.messages.list(session.id)[0]?.parts[0];
    expect(row?.status).toBe("complete");
    expect(row?.data).toEqual({ type: "text", text: "hello" });
    expect(() => writer.append("!")).toThrow();
  });

  test("message.complete updates status through the action event", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    const seen = watch("message.complete");
    await view.messages.complete(created.message.id, "complete");
    expect(seen.payloads[0]?.message.status).toBe("complete");
    expect(view.messages.list(session.id)[0]?.message.status).toBe("complete");
  });

  test("a before hook rewrite on message.complete reaches the write", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    bus.forPlugin("valet-rewriter").before("message.complete", (e) => {
      e.payload = { message: { ...e.payload.message, status: "error" } };
    });
    await view.messages.complete(created.message.id, "complete");
    expect(view.messages.list(session.id)[0]?.message.status).toBe("error");
  });
});

describe("runs", () => {
  test("create emits run.start; terminal update emits run.end", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const started = watch("run.start");
    const ended = watch("run.end");

    const run = view.runs.create({ sessionId: session.id, role: "owner" });
    expect(run.status).toBe("queued");
    await tick();
    expect(started.payloads[0]?.run.id).toBe(run.id);

    view.runs.update(run.id, { status: "running", provider: "devin-cli", model: "opus" });
    expect(view.runs.get(run.id)?.startedAt).not.toBeNull();
    view.runs.update(run.id, { usage: { contextTokens: 5 } });
    view.runs.update(run.id, { status: "complete", usage: { inputTokens: 1 } });
    await tick();
    expect(ended.payloads[0]?.run.status).toBe("complete");
    expect(ended.payloads[0]?.run.usage).toEqual({ contextTokens: 5, inputTokens: 1 });
    expect(view.runs.get(run.id)?.usage).toEqual({ contextTokens: 5, inputTokens: 1 });
    expect(view.runs.get(run.id)?.endedAt).not.toBeNull();
  });

  test("runs.cancel emits run.cancel and ends the run", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const run = view.runs.create({ sessionId: session.id, role: "owner" });
    const seen = watch("run.cancel");
    await view.runs.cancel(run.id, "valet-test");
    expect(seen.payloads[0]).toEqual({ runId: run.id, by: "valet-test" });
    expect(view.runs.get(run.id)?.status).toBe("cancelled");
  });
});

describe("principals and identities", () => {
  test("resolveIdentity creates a guest once, then reuses it", async () => {
    const first = view.principals.resolveIdentity("discord", "42", { displayName: "Friend" });
    expect(first.role).toBe("guest");
    const again = view.principals.resolveIdentity("discord", "42");
    expect(again.id).toBe(first.id);
    expect(view.principals.get(first.id)?.displayName).toBe("Friend");
  });

  test("link emits principal.link and setRole changes the role", async () => {
    const principal = view.principals.resolveIdentity("web", "owner", { displayName: "Owner" });
    const seen = watch("principal.link");
    await view.principals.link(principal.id, "tailscale", "owner@ts");
    expect(seen.payloads[0]?.identity).toEqual({ platform: "tailscale", externalId: "owner@ts" });
    await view.principals.setRole(principal.id, "owner");
    expect(view.principals.get(principal.id)?.role).toBe("owner");
  });
});

describe("deny and cancel", () => {
  test("a before-hook deny rejects with ServiceDeniedError and writes nothing", async () => {
    const afterSeen: { cancelled?: boolean; deniedBy?: string }[] = [];
    bus.forPlugin("valet-guard").before("project.create", (e) => e.deny("not for you"));
    bus.forPlugin("valet-watch").after("project.create", (e) => {
      afterSeen.push({ cancelled: e.cancelled, deniedBy: e.denied?.by });
    });
    let thrown: unknown;
    try {
      await view.projects.create({ name: "x", workspaceDir: "/w" });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ServiceDeniedError);
    expect((thrown as ServiceDeniedError).by).toBe("valet-guard");
    expect((thrown as ServiceDeniedError).reason).toBe("not for you");
    expect(view.projects.list()).toHaveLength(0);
    expect(afterSeen[0]).toEqual({ cancelled: true, deniedBy: "valet-guard" });
  });

  test("a before-hook cancel returns CancelledResult and writes nothing", async () => {
    bus.forPlugin("valet-guard").before("session.create", (e) => e.cancel("slash command"));
    const project = await makeProject();
    const res = await view.sessions.create({ projectId: project.id });
    expect(res).toEqual({ cancelled: true, cancelReason: "slash command" });
    expect(view.sessions.list({})).toHaveLength(0);
  });

  test("an after-hook failure does not undo the write", async () => {
    bus.forPlugin("valet-buggy").after("project.create", () => {
      throw new Error("observer bug");
    });
    const project = await makeProject();
    expect(view.projects.get(project.id)?.name).toBe("helper");
    expect(hookErrors).toHaveLength(1);
    expect(hookErrors[0]?.plugin).toBe("valet-buggy");
  });
});

describe("plugin storage", () => {
  test("kv is namespaced per plugin", () => {
    const a = store.pluginStorage("valet-a");
    const b = store.pluginStorage("valet-b");
    a.kv.set("key", { n: 1 });
    a.kv.set("other", "x");
    expect(a.kv.get<{ n: number }>("key")).toEqual({ n: 1 });
    expect(b.kv.get("key")).toBeUndefined();
    expect(a.kv.list()).toEqual(["key", "other"]);
    expect(a.kv.list("ke")).toEqual(["key"]);
    expect(b.kv.list()).toEqual([]);
    a.kv.delete("key");
    expect(a.kv.get("key")).toBeUndefined();
  });

  test("sql.migrate creates plugin tables once", () => {
    const a = store.pluginStorage("valet-a");
    const migrations = [{ id: "001", up: "CREATE TABLE p_a_jobs (id TEXT PRIMARY KEY)" }];
    a.sql.migrate(migrations);
    a.sql.migrate(migrations); // re-run is a no-op
    a.sql.db.query("INSERT INTO p_a_jobs (id) VALUES ('j1')").run();
    expect(a.sql.db.query("SELECT id FROM p_a_jobs").all()).toEqual([{ id: "j1" }]);
  });
});

describe("blobs", () => {
  test("put writes bytes under <valetHome>/blobs and path resolves them", async () => {
    const { id } = await view.blobs.put(new Uint8Array([1, 2, 3]), {
      mime: "application/octet-stream",
      name: "b",
    });
    expect(id).toStartWith("blb_");
    const path = view.blobs.path(id);
    expect(path).toContain("/blobs/");
    expect(await Bun.file(path).bytes()).toEqual(new Uint8Array([1, 2, 3]));
  });
});

describe("restart recovery", () => {
  test("findInterruptedRuns interrupts running runs and streaming rows", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const running = view.runs.create({ sessionId: session.id, role: "owner" });
    view.runs.update(running.id, { status: "running" });
    const done = view.runs.create({ sessionId: session.id, role: "owner" });
    view.runs.update(done.id, { status: "complete" });
    const message = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(message)) throw new Error("cancelled");
    const writer = view.messages.openPart(message.message.id, { type: "text", text: "" });
    writer.append("partial");
    writer.replace({ type: "text", text: "partial" });

    const interrupted = store.findInterruptedRuns();
    expect(interrupted.map((r) => r.id)).toEqual([running.id]);
    expect(interrupted[0]?.status).toBe("interrupted");
    expect(view.runs.get(running.id)?.status).toBe("interrupted");
    expect(view.runs.get(done.id)?.status).toBe("complete");
    const rows = view.messages.list(session.id);
    expect(rows[0]?.message.status).toBe("interrupted");
    const part = rows[0]?.parts[0];
    expect(part?.status).toBe("interrupted");
    expect(part?.data).toEqual({ type: "text", text: "partial" });
    expect(store.findInterruptedRuns()).toEqual([]);
  });
});
