import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type PartData, type PartTypeDefinition, parsePartTypeId, type Store } from "@valethq/sdk";
import { createCoreBus, type OpenedStore, openStore, PartTypeRegistry } from "../src/index";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

const jobEnd: PartTypeDefinition = {
  id: "valet-exec/job-end@1",
  schema: {
    type: "object",
    required: ["jobId", "status"],
    properties: { jobId: { type: "integer" }, status: { type: "string" } },
  },
  view: { collapsed: true, fields: ["jobId", "status"] },
  wakes: true,
};
const part = (data: unknown): PartData => ({
  type: "custom",
  kind: "valet-exec/job-end@1",
  title: "Process finished",
  text: "job 1 exited 0",
  data,
});

let home: string;
let store: OpenedStore;
let exec: Store;

async function open(): Promise<void> {
  store = await openStore({ valetHome: home, bus: createCoreBus({ logger }), logger });
  store.setOrigin({ id: "valet-exec", version: "0.1.0", repository: "https://example.invalid/valet-exec" });
  exec = store.forPlugin("valet-exec");
}

async function session(): Promise<string> {
  const p = await exec.projects.create({ name: "p", workspaceDir: "/tmp" });
  if ("cancelled" in p) throw new Error("cancelled");
  const s = await exec.sessions.create({ projectId: p.id });
  if ("cancelled" in s) throw new Error("cancelled");
  return s.id;
}

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "valet-parttypes-"));
  await open();
});

test("parsePartTypeId", () => {
  expect(parsePartTypeId("valet-exec/job-end@2")).toEqual({
    plugin: "valet-exec",
    name: "job-end",
    major: 2,
  });
  expect(parsePartTypeId("valet-exec/job-end")).toBeUndefined();
  expect(parsePartTypeId("Job@1")).toBeUndefined();
});

test("define records the origin, persists to part-types.json and survives a restart", async () => {
  const t = exec.partTypes.define(jobEnd);
  expect(t.plugin).toEqual({
    id: "valet-exec",
    version: "0.1.0",
    repository: "https://example.invalid/valet-exec",
  });
  store.close();
  const saved = JSON.parse(readFileSync(join(home, "part-types.json"), "utf8"));
  expect(saved.map((x: { id: string }) => x.id)).toEqual(["valet-exec/job-end@1"]);
  await open(); // the plugin hasn't defined anything yet this boot
  expect(exec.partTypes.get("valet-exec/job-end@1")).toMatchObject({ wakes: true, definedAt: t.definedAt });
});

test("re-defining merges by id; a new schema for the same id is refused", () => {
  const a = exec.partTypes.define(jobEnd);
  expect(exec.partTypes.define(jobEnd)).toBe(a); // same definition: no write
  const b = exec.partTypes.define({ ...jobEnd, description: "a job ended" });
  expect(b).toMatchObject({ description: "a job ended", definedAt: a.definedAt });
  expect(exec.partTypes.list()).toHaveLength(1);
  expect(() => exec.partTypes.define({ ...jobEnd, schema: { type: "object" } })).toThrow(/define @2 instead/);
  exec.partTypes.define({ ...jobEnd, id: "valet-exec/job-end@2", schema: { type: "object" } });
  expect(exec.partTypes.list().map((t) => t.id)).toEqual(["valet-exec/job-end@1", "valet-exec/job-end@2"]);
});

test("ids are namespaced to the defining plugin", () => {
  expect(() => store.forPlugin("valet-other").partTypes.define(jobEnd)).toThrow(/start with "valet-other\/"/);
  expect(() => exec.partTypes.define({ ...jobEnd, id: "job-end" })).toThrow(/is not/);
  expect(() => store.forCaller({ plugin: "core" }).partTypes.define(jobEnd)).toThrow(/only plugins/);
});

test("custom parts are validated against the schema and written only by the owner", async () => {
  exec.partTypes.define(jobEnd);
  const sessionId = await session();
  const ok = await exec.messages.create({
    sessionId,
    role: "system",
    parts: [part({ jobId: 1, status: "exited" })],
  });
  if ("cancelled" in ok) throw new Error("cancelled");
  expect(ok.parts[0]?.type).toBe("custom");
  expect(exec.messages.list(sessionId)[0]?.parts[0]?.data).toEqual(part({ jobId: 1, status: "exited" }));

  await expect(
    exec.messages.create({ sessionId, role: "system", parts: [part({ jobId: "1", status: "exited" })] }),
  ).rejects.toThrow(/invalid "valet-exec\/job-end@1" part: data.jobId: expected integer/);
  await expect(
    store
      .forPlugin("valet-other")
      .messages.create({ sessionId, role: "system", parts: [part({ jobId: 1, status: "x" })] }),
  ).rejects.toThrow(/only valet-exec writes/);
  await expect(
    exec.messages.create({
      sessionId,
      role: "system",
      parts: [{ ...(part({}) as Extract<PartData, { type: "custom" }>), kind: "valet-exec/nope@1" }],
    }),
  ).rejects.toThrow(/unknown part type/);
  expect(exec.messages.list(sessionId)).toHaveLength(1);
});

test("custom parts open and close whole, and are checked on replace and close", async () => {
  exec.partTypes.define(jobEnd);
  const sessionId = await session();
  const m = await exec.messages.create({ sessionId, role: "system", status: "streaming", parts: [] });
  if ("cancelled" in m) throw new Error("cancelled");
  const w = exec.messages.openPart(m.message.id, part({ jobId: 1, status: "running" }));
  expect(() => w.append("x")).toThrow(/takes replace\(\)/);
  expect(() => w.replace(part({ jobId: 1 }))).toThrow(/missing required "status"/);
  w.close("complete", part({ jobId: 1, status: "exited" }));
  expect(exec.messages.list(sessionId)[0]?.parts[0]).toMatchObject({
    status: "complete",
    data: { data: { status: "exited" } },
  });
});

test("an in-memory registry writes no file", () => {
  const r = new PartTypeRegistry(null);
  r.define({ id: "valet-exec", version: "1.0.0" }, jobEnd);
  expect(r.get(jobEnd.id)).toBeDefined();
  expect(existsSync(":memory:")).toBe(false);
});
