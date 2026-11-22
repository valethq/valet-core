import { describe, expect, test } from "bun:test";
import {
  type AclContext,
  allowedTools,
  type Caller,
  can,
  defineTool,
  matchPermission,
  type PermissionDef,
  type PolicyProvider,
  type Role,
  type ToolDefinition,
} from "../src/index";

const roles: Record<string, Role> = { own: "owner", fr: "trusted", gu: "guest" };
const perms: Record<string, PermissionDef> = {
  "x:read": { summary: "r", default: "trusted" },
  "x:admin": { summary: "a", requireVerifiedLogin: true },
  "x:open": { summary: "o", default: "guest" },
};

function ctx(
  opts: { policy?: PolicyProvider; credential?: { active: boolean; cap?: string[] } } = {},
): AclContext {
  return {
    plugin: { id: "valet-x" },
    acl: {
      permission: (n) => perms[n],
      names: () => Object.keys(perms),
      credential: () => opts.credential,
    },
    scopes: { maybe: () => opts.policy } as unknown as AclContext["scopes"],
    store: {
      principals: { get: (id: string) => (roles[id] ? { id, displayName: id, role: roles[id] } : undefined) },
    } as unknown as AclContext["store"],
    log: { debug() {}, info() {}, warn() {}, error() {} },
  };
}
const as = (
  principalId: string,
  extra: Partial<NonNullable<Caller["actor"]>> = {},
  top: Partial<Caller> = {},
): Caller => ({
  plugin: "core",
  actor: { principalId, role: roles[principalId] ?? "guest", ...extra },
  ...top,
});

describe("can", () => {
  test("fallback compares the current stored role with the declared default", () => {
    expect(can(ctx(), as("fr"), "x:read").allow).toBe(true);
    expect(can(ctx(), as("gu"), "x:read").allow).toBe(false);
    expect(can(ctx(), { plugin: "p" }, "x:open").allow).toBe(true);
    expect(can(ctx(), { plugin: "p" }, "x:read").allow).toBe(false);
  });

  test("undeclared permissions are denied", () => {
    expect(can(ctx(), as("own"), "x:nope")).toMatchObject({ allow: false, by: "valet-x" });
  });

  test("caps, credential liveness and verified login apply before grants", () => {
    expect(can(ctx(), as("own", { cap: ["y:*"] }), "x:read").allow).toBe(false);
    expect(can(ctx(), as("own", { cap: ["x:*"] }), "x:read").allow).toBe(true);
    const cred = { credentialId: "auth:t1" };
    expect(can(ctx(), as("own", {}, cred), "x:read").allow).toBe(false);
    expect(can(ctx({ credential: { active: false } }), as("own", {}, cred), "x:read").allow).toBe(false);
    expect(
      can(ctx({ credential: { active: true, cap: ["x:open"] } }), as("own", {}, cred), "x:read").allow,
    ).toBe(false);
    expect(can(ctx({ credential: { active: true } }), as("own", {}, cred), "x:read").allow).toBe(true);
    expect(can(ctx(), as("own"), "x:admin").allow).toBe(false);
    expect(can(ctx(), as("own", {}, { verifiedLogin: true }), "x:admin").allow).toBe(true);
  });

  test("every audience reader and the unknown-reader tier must hold the permission", () => {
    expect(can(ctx(), as("own", { audience: { principals: ["fr"] } }), "x:read").allow).toBe(true);
    expect(can(ctx(), as("own", { audience: { principals: ["gu"] } }), "x:read").allow).toBe(false);
    expect(can(ctx(), as("own", { audience: { tier: "guest" } }), "x:read").allow).toBe(false);
    expect(can(ctx(), as("own", { audience: { tier: "trusted" } }), "x:read").allow).toBe(true);
  });

  test("a policy provider decides each grant; tags reach it and the action evidence rides separately", () => {
    const seen: unknown[] = [];
    const policy: PolicyProvider = {
      check(subject, permission, resource, action) {
        seen.push({ subject, permission, resource, action });
        return subject.tags?.includes("tag:ci")
          ? { allow: true }
          : { allow: false, by: "valet-policy", reason: "no" };
      },
    };
    const tagged = as("gu", { tags: ["tag:ci"] }, { authenticatedBy: "valet-auth" });
    expect(can(ctx({ policy }), tagged, "x:read", "project:p1").allow).toBe(true);
    expect(seen[0]).toEqual({
      subject: { principalId: "gu", role: "guest", tags: ["tag:ci"] },
      permission: "x:read",
      resource: { id: "project:p1" },
      action: { authenticatedBy: "valet-auth" },
    });
    expect(can(ctx({ policy }), as("own"), "x:read")).toMatchObject({ allow: false, by: "valet-policy" });
  });

  test("matchPermission handles full names, namespace wildcards and *", () => {
    expect(matchPermission("*", "a:b")).toBe(true);
    expect(matchPermission("a:*", "a:b.c")).toBe(true);
    expect(matchPermission("a:*", "ab:c")).toBe(false);
    expect(matchPermission("a:b", "a:b")).toBe(true);
  });
});

describe("defineTool and allowedTools", () => {
  const tool: ToolDefinition = {
    name: "t",
    description: "",
    inputSchema: {},
    permission: "x:read",
    invoke: async () => ({ content: [{ type: "text", text: "ran" }] }),
  };
  const call = (caller: Caller, role: Role) => ({
    sessionId: "s",
    runId: "r",
    callId: "c",
    role,
    caller,
    cwd: "/",
    signal: new AbortController().signal,
    progress() {},
  });
  const c = ctx();
  (c.store as unknown as { sessions: unknown }).sessions = { get: () => ({ projectId: "p" }) };

  test("invoke re-checks the permission; list filters by subject", async () => {
    const wrapped = defineTool(tool, c);
    expect((await wrapped.invoke({}, call(as("fr"), "trusted"))).isError).toBeUndefined();
    expect((await wrapped.invoke({}, call(as("gu"), "guest"))).isError).toBe(true);
    expect(allowedTools(c, { sessionId: "s", role: "trusted", caller: as("fr") }, [wrapped])).toHaveLength(1);
    expect(allowedTools(c, { sessionId: "s", role: "guest", caller: as("gu") }, [wrapped])).toHaveLength(0);
  });

  test("minRole stays a stricter floor against the run's role", async () => {
    const floored = defineTool({ ...tool, minRole: "owner" }, c);
    expect((await floored.invoke({}, call(as("own"), "trusted"))).isError).toBe(true);
    expect((await floored.invoke({}, call(as("own"), "owner"))).isError).toBeUndefined();
  });
});
