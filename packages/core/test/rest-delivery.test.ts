import { describe, expect, test } from "bun:test";
import type { Caller, RequestContext, Session, Store } from "@valethq/sdk";
import { matchRest, type RestDeps, runRest } from "../src/control/rest";

const session: Session = {
  id: "ses_1",
  projectId: "prj_1",
  title: null,
  color: null,
  parentSessionId: null,
  status: "idle",
  settings: {},
  providerState: {},
  createdAt: 1,
  updatedAt: 1,
  lastMessageAt: null,
  lastResponseAt: null,
};

const caller: Caller = { plugin: "core" };

function rig() {
  const created: Record<string, unknown>[] = [];
  const store = {
    sessions: { get: (id: string) => (id === "ses_1" ? session : undefined) },
    messages: {
      list: () => [],
      create: async (write: Record<string, unknown>) => {
        created.push(write);
        return { message: { id: "msg_1" }, parts: [] };
      },
    },
  } as unknown as Store;
  const deps = {} as RestDeps;
  const call = (body: unknown) => {
    const match = matchRest(deps, "POST", "/api/core/sessions/ses_1/messages");
    if (match === undefined) throw new Error("no messages route");
    const req = new Request("http://x/api/core/sessions/ses_1/messages", {
      method: "POST",
      body: JSON.stringify(body),
    });
    const ctx: RequestContext = { caller, principal: undefined, params: {}, url: new URL(req.url) };
    return runRest(match, { forCaller: () => store }, req, ctx);
  };
  return { call, created };
}

const message = (extra: Record<string, unknown> = {}) => ({
  role: "user",
  parts: [{ type: "text", text: "hi" }],
  ...extra,
});

describe("POST /sessions/:id/messages delivery", () => {
  test("forwards the delivery mode to the store", async () => {
    const { call, created } = rig();
    const res = await call(message({ delivery: "interrupt" }));
    expect(res.status).toBe(201);
    expect(created[0]?.delivery).toBe("interrupt");
  });

  test("leaves delivery out when the body has none, next to client metadata", async () => {
    const { call, created } = rig();
    await call(message({ clientMessageId: "cm_1" }));
    expect(created[0]).toMatchObject({ meta: { clientMessageId: "cm_1" } });
    expect(created[0]).not.toHaveProperty("delivery");
  });

  test("rejects an unknown mode without writing", async () => {
    const { call, created } = rig();
    const res = await call(message({ delivery: "later" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "bad_request", message: 'delivery must be "queue" or "interrupt"' },
    });
    expect(created).toEqual([]);
  });
});
