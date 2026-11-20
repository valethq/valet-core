import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CancelledResult, Part, PartData, Store } from "@valethq/sdk";
import { createCoreBus, type CoreBus, openStore, type OpenedStore } from "../src/index";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isCancelled(value: unknown): value is CancelledResult {
  return typeof value === "object" && value !== null && (value as { cancelled?: boolean }).cancelled === true;
}

let bus: CoreBus;
let store: OpenedStore;
let view: Store;

beforeEach(async () => {
  bus = createCoreBus({ logger });
  const valetHome = mkdtempSync(join(tmpdir(), "valet-store-fixes-"));
  store = await openStore({ valetHome, dbPath: ":memory:", bus, logger });
  view = store.forPlugin("valet-test");
});

async function makeProject() {
  const project = await view.projects.create({ name: "helper", workspaceDir: "/tmp/ws" });
  if (isCancelled(project)) throw new Error("project.create cancelled");
  return project;
}

async function makeSession(projectId: string) {
  const session = await view.sessions.create({ projectId, title: "t" });
  if (isCancelled(session)) throw new Error("session.create cancelled");
  return session;
}

function partRow(partId: string): { type: string; data: PartData; status: string } {
  const row = store.db
    .query<{ type: string; data: string; status: string }, string>(
      "SELECT type, data, status FROM parts WHERE id = ?",
    )
    .get(partId);
  if (!row) throw new Error(`missing part ${partId}`);
  return { type: row.type, data: JSON.parse(row.data) as PartData, status: row.status };
}

describe("message seq", () => {
  test("concurrent creates with an async before hook get distinct seqs", async () => {
    bus.forPlugin("valet-agent").before("message.create", async () => {});
    const seen: number[] = [];
    bus.forPlugin("valet-watch").after("message.create", (e) => {
      seen.push(e.payload.message.seq);
    });
    const project = await makeProject();
    const session = await makeSession(project.id);
    const [first, second] = await Promise.all([
      view.messages.create({ sessionId: session.id, role: "user", parts: [{ type: "text", text: "a" }] }),
      view.messages.create({ sessionId: session.id, role: "user", parts: [{ type: "text", text: "b" }] }),
    ]);
    if (isCancelled(first) || isCancelled(second)) throw new Error("cancelled");
    expect(first.message.seq).toBe(1);
    expect(second.message.seq).toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(view.messages.list(session.id).map((row) => row.message.seq)).toEqual([1, 2]);
  });

  test("a before hook can create a message in the same session", async () => {
    const seen: { role: string; seq: number }[] = [];
    bus.forPlugin("valet-watch").after("message.create", (e) => {
      seen.push({ role: e.payload.message.role, seq: e.payload.message.seq });
    });
    bus.forPlugin("valet-agent").before("message.create", async (e) => {
      if (e.payload.message.role !== "user") return;
      await view.sessions.update(e.payload.message.sessionId, { title: "from-hook" });
      const nested = await view.messages.create({
        sessionId: e.payload.message.sessionId,
        role: "system",
        parts: [{ type: "notice", level: "info", text: "cmd" }],
      });
      if (isCancelled(nested)) throw new Error("nested cancelled");
    });
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    expect(view.sessions.get(session.id)?.title).toBe("from-hook");
    expect(view.messages.list(session.id).map((row) => [row.message.role, row.message.seq])).toEqual([
      ["system", 1],
      ["user", 2],
    ]);
    expect(seen).toContainEqual({ role: "system", seq: 1 });
    expect(seen).toContainEqual({ role: "user", seq: 2 });
    expect(created.message.seq).toBe(2);
  });

  test("an after hook can create a message in the same session", async () => {
    bus.forPlugin("valet-agent").after("message.create", async (e) => {
      if (e.payload.message.meta?.hook === true) return;
      const nested = await view.messages.create({
        sessionId: e.payload.message.sessionId,
        role: "system",
        meta: { hook: true },
        parts: [],
      });
      if (isCancelled(nested)) throw new Error("nested cancelled");
    });
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "user",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    expect(view.messages.list(session.id).map((row) => [row.message.role, row.message.seq])).toEqual([
      ["user", 1],
      ["system", 2],
    ]);
  });

  test("concurrent creates on a dev-mode bus do not throw", async () => {
    const devBus = createCoreBus({ logger, dev: true });
    const valetHome = mkdtempSync(join(tmpdir(), "valet-store-fixes-dev-"));
    const devStore = await openStore({ valetHome, dbPath: ":memory:", bus: devBus, logger });
    const devView = devStore.forPlugin("valet-test");
    devBus.forPlugin("valet-agent").before("message.create", async () => {});
    const seen: number[] = [];
    devBus.forPlugin("valet-watch").after("message.create", (e) => {
      seen.push(e.payload.message.seq);
    });
    const project = await devView.projects.create({ name: "helper", workspaceDir: "/tmp/ws" });
    if (isCancelled(project)) throw new Error("cancelled");
    const session = await devView.sessions.create({ projectId: project.id });
    if (isCancelled(session)) throw new Error("cancelled");
    const [first, second] = await Promise.all([
      devView.messages.create({ sessionId: session.id, role: "user", parts: [] }),
      devView.messages.create({ sessionId: session.id, role: "user", parts: [] }),
    ]);
    if (isCancelled(first) || isCancelled(second)) throw new Error("cancelled");
    expect([first.message.seq, second.message.seq]).toEqual([1, 2]);
    expect(devView.messages.list(session.id).map((row) => row.message.seq)).toEqual([1, 2]);
    // spec-gap: the frozen payload still carries the provisional seq.
    expect(seen).toEqual([1, 1]);
    devStore.close();
  });
});

describe("project and session updates", () => {
  test("concurrent project updates keep each patched field", async () => {
    bus.forPlugin("valet-agent").before("project.update", async () => {});
    const project = await makeProject();
    const [named, tuned] = await Promise.all([
      view.projects.update(project.id, { name: "renamed" }),
      view.projects.update(project.id, { workspaceDir: "/tmp/elsewhere", settings: { persona: "x" } }),
    ]);
    if (isCancelled(named) || isCancelled(tuned)) throw new Error("cancelled");
    const got = view.projects.get(project.id);
    expect(got?.name).toBe("renamed");
    expect(got?.workspaceDir).toBe("/tmp/elsewhere");
    expect(got?.settings).toEqual({ persona: "x" });
  });

  test("concurrent session updates keep each patched field", async () => {
    bus.forPlugin("valet-agent").before("session.update", async () => {});
    const project = await makeProject();
    const session = await makeSession(project.id);
    const [titled, colored] = await Promise.all([
      view.sessions.update(session.id, { title: "A" }),
      view.sessions.update(session.id, { color: "red", status: "running" }),
    ]);
    if (isCancelled(titled) || isCancelled(colored)) throw new Error("cancelled");
    const got = view.sessions.get(session.id);
    expect(got?.title).toBe("A");
    expect(got?.color).toBe("red");
    expect(got?.status).toBe("running");
  });

  test("session update reapplies a before-hook edit onto the fresh row", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    let waiting = false;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    bus.forPlugin("valet-rewriter").before("session.update", async (e) => {
      if (e.payload.patch.title === undefined) return;
      e.payload = { session: { ...e.payload.session, color: "blue" }, patch: e.payload.patch };
      waiting = true;
      await gate;
    });
    const pending = view.sessions.update(session.id, { title: "T" });
    while (!waiting) await tick();
    const status = await view.sessions.update(session.id, { status: "archived" });
    if (isCancelled(status)) throw new Error("cancelled");
    release();
    const titled = await pending;
    if (isCancelled(titled)) throw new Error("cancelled");
    const got = view.sessions.get(session.id);
    expect(got?.title).toBe("T");
    expect(got?.color).toBe("blue");
    expect(got?.status).toBe("archived");
  });
});

describe("runs", () => {
  test("a usage patch on a finished run does not emit run.end", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const run = view.runs.create({ sessionId: session.id, role: "owner" });
    view.runs.update(run.id, { status: "running" });
    view.runs.update(run.id, { status: "complete", usage: { inputTokens: 1 } });
    await tick();
    const updates = { n: 0 };
    const ended = { n: 0 };
    bus.forPlugin("valet-watch").before("run.update", () => {
      updates.n += 1;
    });
    bus.forPlugin("valet-watch").before("run.end", () => {
      ended.n += 1;
    });
    view.runs.update(run.id, { usage: { outputTokens: 4 } });
    await tick();
    expect(updates.n).toBe(1);
    expect(ended.n).toBe(0);
    expect(view.runs.get(run.id)?.status).toBe("complete");
    expect(view.runs.get(run.id)?.usage).toEqual({ inputTokens: 1, outputTokens: 4 });
  });

  test("cancel leaves an already terminal run unchanged and does not emit run.end", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const done = view.runs.create({ sessionId: session.id, role: "owner" });
    view.runs.update(done.id, { status: "complete" });
    await tick();
    const ended = { n: 0 };
    bus.forPlugin("valet-watch").before("run.end", () => {
      ended.n += 1;
    });
    await view.runs.cancel(done.id, "user");
    await tick();
    expect(view.runs.get(done.id)?.status).toBe("complete");
    expect(ended.n).toBe(0);

    const live = view.runs.create({ sessionId: session.id, role: "owner" });
    view.runs.update(live.id, { status: "running" });
    await view.runs.cancel(live.id, "user");
    await tick();
    expect(view.runs.get(live.id)?.status).toBe("cancelled");
    expect(ended.n).toBe(1);
    await view.runs.cancel(live.id, "user");
    await tick();
    expect(view.runs.get(live.id)?.status).toBe("cancelled");
    expect(ended.n).toBe(1);
  });
});

describe("parts", () => {
  test("part.update carries the full part on replace and close", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    const seen: Part[] = [];
    bus.forPlugin("valet-ui").onSignal("part.update", (payload) => {
      seen.push(payload.part as Part);
    });
    const writer = view.messages.openPart(created.message.id, { type: "text", text: "" });
    writer.replace({ type: "text", text: "x" });
    writer.close("complete", { type: "text", text: "x" });
    expect(seen).toHaveLength(3);
    for (const part of seen) {
      expect(part.id).toBe(writer.partId);
      expect(part.messageId).toBe(created.message.id);
      expect(part.idx).toBe(0);
      expect(typeof part.createdAt).toBe("number");
      expect(typeof part.updatedAt).toBe("number");
      expect(part.type).toBe("text");
    }
    expect(seen[1]?.status).toBe("streaming");
    expect(seen[2]?.status).toBe("complete");
    expect(seen[0]?.createdAt).toBe(seen[2]?.createdAt);
  });

  test("replace and close persist part.type", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    const writer = view.messages.openPart(created.message.id, { type: "text", text: "a" });
    writer.replace({ type: "reasoning", text: "b" });
    expect(partRow(writer.partId)).toMatchObject({
      type: "reasoning",
      status: "streaming",
      data: { type: "reasoning", text: "b" },
    });
    writer.close("complete", { type: "notice", level: "info", text: "c" });
    expect(partRow(writer.partId)).toMatchObject({
      type: "notice",
      status: "complete",
      data: { type: "notice", level: "info", text: "c" },
    });
    expect(view.messages.list(session.id)[0]?.parts[0]?.type).toBe("notice");
  });

  test("a streaming part is checkpointed 500ms after the first append", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    const writer = view.messages.openPart(created.message.id, { type: "text", text: "" });
    writer.append("ab");
    writer.append("cd");
    await delay(100);
    expect(partRow(writer.partId).data).toEqual({ type: "text", text: "" });
    await delay(550);
    expect(partRow(writer.partId).data).toEqual({ type: "text", text: "abcd" });
    writer.close("complete");
  });

  test("a checkpoint timer does not throw after the store closes", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const created = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [],
    });
    if (isCancelled(created)) throw new Error("cancelled");
    const writer = view.messages.openPart(created.message.id, { type: "text", text: "" });
    writer.append("hello");
    store.close();
    await delay(700);
    expect(writer.partId).toStartWith("prt_");
  });
});

describe("run ids and recovery", () => {
  test("rejects a run from another session and delete clears leftover run ids", async () => {
    const project = await makeProject();
    const home = await makeSession(project.id);
    const other = await makeSession(project.id);
    const run = view.runs.create({ sessionId: home.id, role: "owner" });
    await expect(
      view.messages.create({ sessionId: other.id, role: "user", runId: run.id, parts: [] }),
    ).rejects.toThrow(/^unknown run/);
    await expect(
      view.messages.create({ sessionId: home.id, role: "user", runId: "run_missing", parts: [] }),
    ).rejects.toThrow(/^unknown run/);

    const kept = await view.messages.create({
      sessionId: other.id,
      role: "user",
      parts: [{ type: "text", text: "stay" }],
    });
    if (isCancelled(kept)) throw new Error("cancelled");
    store.db.query("UPDATE messages SET run_id = ? WHERE id = ?").run(run.id, kept.message.id);
    const same = await view.messages.create({
      sessionId: home.id,
      role: "user",
      runId: run.id,
      parts: [],
    });
    if (isCancelled(same)) throw new Error("cancelled");
    expect(same.message.runId).toBe(run.id);

    await view.sessions.delete(home.id);
    expect(view.sessions.get(home.id)).toBeUndefined();
    expect(view.runs.get(run.id)).toBeUndefined();
    const left = view.messages.list(other.id)[0];
    expect(left?.message.runId).toBeNull();
    expect(left?.parts[0]?.data).toEqual({ type: "text", text: "stay" });
  });

  test("findInterruptedRuns cancels streaming tool-call data status", async () => {
    const project = await makeProject();
    const session = await makeSession(project.id);
    const running = view.runs.create({ sessionId: session.id, role: "owner" });
    view.runs.update(running.id, { status: "running" });
    const streaming = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      status: "streaming",
      parts: [
        { type: "tool-call", callId: "run", name: "exec", input: {}, status: "running" },
        { type: "tool-call", callId: "pend", name: "exec", input: {}, status: "pending" },
        { type: "tool-call", callId: "done", name: "exec", input: {}, status: "done" },
        { type: "text", text: "partial" },
      ],
    });
    if (isCancelled(streaming)) throw new Error("cancelled");
    const finished = await view.messages.create({
      sessionId: session.id,
      role: "assistant",
      parts: [{ type: "tool-call", callId: "kept", name: "exec", input: {}, status: "done" }],
    });
    if (isCancelled(finished)) throw new Error("cancelled");

    const interrupted = store.findInterruptedRuns();
    expect(interrupted.map((run) => run.id)).toEqual([running.id]);
    const rows = view.messages.list(session.id);
    const streamingParts = rows[0]?.parts ?? [];
    expect(streamingParts.map((part) => part.status)).toEqual([
      "interrupted",
      "interrupted",
      "interrupted",
      "interrupted",
    ]);
    expect(streamingParts.map((part) => part.data)).toEqual([
      { type: "tool-call", callId: "run", name: "exec", input: {}, status: "cancelled" },
      { type: "tool-call", callId: "pend", name: "exec", input: {}, status: "cancelled" },
      { type: "tool-call", callId: "done", name: "exec", input: {}, status: "done" },
      { type: "text", text: "partial" },
    ]);
    expect(rows[0]?.message.status).toBe("interrupted");
    expect(rows[1]?.parts[0]?.data).toEqual({
      type: "tool-call",
      callId: "kept",
      name: "exec",
      input: {},
      status: "done",
    });
    expect(rows[1]?.parts[0]?.status).toBe("complete");
  });
});
