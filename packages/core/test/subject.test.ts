import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Caller, Session, Store } from "@valethq/sdk";
import { createCoreBus, type CoreBus, openStore, type OpenedStore } from "../src/index";

const logger = { debug() {}, info() {}, warn() {}, error() {} };

let bus: CoreBus;
let store: OpenedStore;
let view: Store;
let session: Session;

beforeEach(async () => {
  bus = createCoreBus({ logger, onHookError: () => {} });
  store = await openStore({
    valetHome: mkdtempSync(join(tmpdir(), "valet-subj-")),
    dbPath: ":memory:",
    bus,
    logger,
  });
  view = store.forPlugin("valet-test");
  const project = (await view.projects.create({ name: "p", workspaceDir: "/tmp/ws" })) as { id: string };
  session = (await view.sessions.create({ projectId: project.id })) as Session;
});

async function principal(external: string, role: "owner" | "trusted" | "guest") {
  const p = view.principals.resolveIdentity("test", external);
  if (role !== "guest") await view.principals.setRole(p.id, role);
  return p.id;
}

describe("run subjects", () => {
  test("the stored role is the lowest of principal, readers and tier; runs.caller stamps the subject", async () => {
    const owner = await principal("o", "owner");
    const friend = await principal("f", "trusted");
    const run = view.runs.create({
      sessionId: session.id,
      role: "owner",
      subject: {
        principalId: owner,
        credentialId: "auth:tok_1",
        cap: ["search:*"],
        audience: { principals: [friend] },
      },
    });
    expect(run.role).toBe("trusted");
    expect(view.runs.get(run.id)?.subject?.cap).toEqual(["search:*"]);
    const caller = view.runs.caller(run.id);
    expect(caller).toEqual({
      plugin: "valet-test",
      credentialId: "auth:tok_1",
      actor: {
        principalId: owner,
        role: "owner",
        runId: run.id,
        cap: ["search:*"],
        audience: { principals: [friend] },
      },
    });
    const tiered = view.runs.create({
      sessionId: session.id,
      role: "owner",
      subject: { principalId: owner, audience: { tier: "guest" } },
    });
    expect(tiered.role).toBe("guest");
  });

  test("store.as({ runId }) stamps the run's subject and rejects another principal's run", async () => {
    const owner = await principal("o", "owner");
    const other = await principal("x", "owner");
    const run = view.runs.create({
      sessionId: session.id,
      role: "owner",
      subject: { principalId: owner, cap: ["exec:run"] },
    });
    const seen: Caller[] = [];
    bus.forPlugin("valet-watch").before("message.create", (e) => void seen.push(e.caller));
    await view
      .as({ principalId: owner, runId: run.id })
      .messages.create({ sessionId: session.id, role: "system", parts: [] });
    expect(seen[0]?.actor).toMatchObject({ principalId: owner, runId: run.id, cap: ["exec:run"] });
    expect(() => view.as({ principalId: other, runId: run.id })).toThrow("another principal");
    expect(() => view.as({ principalId: owner, runId: "run_missing" })).toThrow("unknown run");
  });

  test("emit(…, { as }) stamps the same caller", async () => {
    const owner = await principal("o", "owner");
    const run = view.runs.create({ sessionId: session.id, role: "owner", subject: { principalId: owner } });
    const seen: Caller[] = [];
    bus.forPlugin("valet-watch").before("tool.call", (e) => void seen.push(e.caller));
    await bus
      .forPlugin("valet-agent", "agent")
      .emit(
        "tool.call",
        { runId: run.id, callId: "c", name: "t", input: {}, role: "owner" },
        { as: { principalId: owner, runId: run.id } },
      );
    expect(seen[0]).toMatchObject({ plugin: "valet-agent", actor: { principalId: owner, runId: run.id } });
  });
});

describe("principals", () => {
  test("setRole emits principal.update, can be denied, and refuses to demote the last owner", async () => {
    const owner = await principal("o", "owner");
    const updates: unknown[] = [];
    bus.forPlugin("valet-watch").after("principal.update", (e) => void updates.push(e.payload.patch));
    await expect(view.principals.setRole(owner, "guest")).rejects.toThrow("last owner");
    expect(view.principals.get(owner)?.role).toBe("owner");
    const second = await principal("s", "owner");
    await view.principals.setRole(owner, "trusted");
    expect(view.principals.get(owner)?.role).toBe("trusted");
    expect(updates).toContainEqual({ role: "trusted" });
    bus.forPlugin("valet-guard").before("principal.update", (e) => e.deny("no"));
    await expect(view.principals.setRole(second, "guest")).rejects.toThrow("no");
  });

  test("link without a code is an admin link; with a code it is a challenge; identities are listed", async () => {
    const owner = await principal("o", "owner");
    const proofs: unknown[] = [];
    bus.forPlugin("valet-watch").after("principal.link", (e) => void proofs.push(e.payload.proof));
    await view.principals.link(owner, "discord", "1");
    const code = view.principals.linkChallenge(owner);
    await store
      .forPlugin("valet-discord")
      .principals.link(owner, "discord", "2", { code: code.toLowerCase() });
    await expect(view.principals.link(owner, "discord", "3", { code })).rejects.toThrow("invalid");
    expect(proofs).toEqual([
      { kind: "admin", by: "valet-test" },
      { kind: "challenge", by: "valet-discord" },
    ]);
    expect(view.principals.identities(owner)).toEqual([
      { platform: "discord", externalId: "1" },
      { platform: "discord", externalId: "2" },
      { platform: "test", externalId: "o" },
    ]);
  });
});
