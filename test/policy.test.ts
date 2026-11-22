import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, PolicyProvider, PolicySubject, Role } from "@valethq/sdk";
import policy from "../plugins/policy/src/index";
import { parsePolicy } from "../plugins/policy/src/parse";

const PERMISSIONS: Record<string, { default?: Role }> = {
  "exec:run": {},
  "search:query": {},
  "search:admin": {},
  "core:project.read": {},
  "core:session.read": {},
  "core:settings.write": {},
  "open:read": { default: "guest" },
  "mid:thing": { default: "trusted" },
  "policy:tag.assign": {},
};
const PRINCIPALS: Record<string, { role: Role; identities: { platform: string; externalId: string }[] }> = {
  prn_owner: { role: "owner", identities: [{ platform: "discord", externalId: "1" }] },
  prn_trusted: { role: "trusted", identities: [{ platform: "discord", externalId: "2" }] },
  prn_friend: { role: "guest", identities: [{ platform: "discord", externalId: "123456" }] },
  prn_other: { role: "guest", identities: [] },
};

interface Harness {
  home: string;
  events: { name: string; payload: unknown }[];
  logs: { level: string; msg: string }[];
  check(
    subject: PolicySubject,
    permission: string,
    resource?: string | { id: string; ancestors?: string[] },
    authenticatedBy?: string,
  ): boolean;
  reload(): Promise<void>;
  stop(): void;
}

const homes: string[] = [];
const stops: (() => void)[] = [];

const guest: PolicySubject = { role: "guest" };
const principal = (id: string): PolicySubject => ({ principalId: id, role: PRINCIPALS[id]?.role ?? "guest" });

async function start(policyText: string | undefined, existingHome?: string): Promise<Harness> {
  const home = existingHome ?? mkdtempSync(join(tmpdir(), "valet-policy-"));
  if (existingHome === undefined) homes.push(home);
  if (policyText !== undefined) writeFileSync(join(home, "policy.json"), policyText);
  const events: Harness["events"] = [];
  const logs: Harness["logs"] = [];
  const changeFns: (() => void | Promise<void>)[] = [];
  const disposers: (() => void | Promise<void>)[] = [];
  let provider: PolicyProvider | undefined;
  const log = (level: string) => (msg: string) => void logs.push({ level, msg });
  const ctx = {
    plugin: { id: "valet-policy" },
    log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
    paths: { valetHome: home, data: join(home, "data", "valet-policy"), cache: join(home, "cache") },
    acl: {
      permission: (name: string) => PERMISSIONS[name],
      names: () => Object.keys(PERMISSIONS),
    },
    store: {
      principals: {
        get: (id: string) =>
          PRINCIPALS[id] === undefined ? undefined : { id, displayName: id, role: PRINCIPALS[id].role },
        identities: (id: string) => PRINCIPALS[id]?.identities ?? [],
      },
    },
    events: {
      emit: async (name: string, payload: unknown) => void events.push({ name, payload }),
    },
    scopes: {
      provide: (_: string, impl: PolicyProvider) => {
        provider = impl;
        return { dispose() {} };
      },
    },
    onConfigChange: (fn: () => void) => void changeFns.push(fn),
    onDispose: (fn: () => void) => void disposers.push(fn),
  } as unknown as PluginContext;
  await policy.activate(ctx);
  const stop = () => {
    for (const d of disposers.splice(0)) void d();
  };
  stops.push(stop);
  return {
    home,
    events,
    logs,
    check(subject, permission, resource, authenticatedBy) {
      const scope = typeof resource === "string" ? { id: resource } : resource;
      return (
        provider?.check(
          subject,
          permission,
          scope,
          authenticatedBy === undefined ? undefined : { authenticatedBy },
        ).allow ?? false
      );
    },
    async reload() {
      for (const fn of changeFns) await fn();
    },
    stop,
  };
}

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

const doc = (body: unknown) => JSON.stringify({ version: 1, ...(body as object) });

describe("defaults", () => {
  test("a missing or empty policy.json decides like role defaults", async () => {
    for (const text of [undefined, "", "{}", doc({})]) {
      const h = await start(text);
      expect(h.check(principal("prn_owner"), "exec:run")).toBe(true);
      expect(h.check(principal("prn_trusted"), "exec:run")).toBe(false);
      expect(h.check(principal("prn_trusted"), "mid:thing")).toBe(true);
      expect(h.check(guest, "mid:thing")).toBe(false);
      expect(h.check(guest, "open:read")).toBe(true);
      h.stop();
    }
  });

  test("useDefaults false removes the tier grants but never the owner's", async () => {
    const h = await start(doc({ useDefaults: false }));
    expect(h.check(guest, "open:read")).toBe(false);
    expect(h.check(principal("prn_trusted"), "mid:thing")).toBe(false);
    expect(h.check(principal("prn_owner"), "exec:run")).toBe(true);
    expect(h.check(principal("prn_owner"), "anything:else")).toBe(true);
  });

  test("unknown permissions fall back to owner", async () => {
    const h = await start(undefined);
    expect(h.check(principal("prn_trusted"), "ghost:thing")).toBe(false);
    expect(h.check(principal("prn_owner"), "ghost:thing")).toBe(true);
  });
});

describe("selectors", () => {
  test("autogroups are inclusive upward", async () => {
    const h = await start(
      doc({
        grants: [
          { to: ["autogroup:trusted"], allow: ["search:query"] },
          { to: ["autogroup:owner"], allow: ["search:admin"] },
          { to: ["autogroup:anyone"], allow: ["core:project.read"] },
          { to: ["autogroup:guest"], allow: ["core:session.read"] },
        ],
      }),
    );
    expect(h.check(guest, "search:query")).toBe(false);
    expect(h.check(principal("prn_friend"), "search:query")).toBe(false);
    expect(h.check(principal("prn_trusted"), "search:query")).toBe(true);
    expect(h.check(principal("prn_owner"), "search:query")).toBe(true);
    expect(h.check(principal("prn_trusted"), "search:admin")).toBe(false);
    expect(h.check(guest, "core:project.read")).toBe(true);
    expect(h.check(guest, "core:session.read")).toBe(true);
    expect(h.check(guest, "exec:run")).toBe(false);
  });

  test("principal, identity and tag selectors", async () => {
    const h = await start(
      doc({
        grants: [
          { to: ["principal:prn_other"], allow: ["search:query"] },
          { to: ["discord:123456"], allow: ["search:admin"] },
          { to: ["tag:ci"], allow: ["core:project.read"] },
        ],
      }),
    );
    expect(h.check(principal("prn_other"), "search:query")).toBe(true);
    expect(h.check(principal("prn_friend"), "search:query")).toBe(false);
    expect(h.check(principal("prn_friend"), "search:admin")).toBe(true);
    expect(h.check(principal("prn_other"), "search:admin")).toBe(false);
    expect(h.check(guest, "search:admin")).toBe(false);
    expect(h.check({ ...principal("prn_other"), tags: ["tag:ci"] }, "core:project.read")).toBe(true);
    expect(h.check({ ...principal("prn_other"), tags: ["ci"] }, "core:project.read")).toBe(true);
    expect(h.check({ ...principal("prn_other"), tags: ["tag:deploy"] }, "core:project.read")).toBe(false);
    expect(h.check(principal("prn_other"), "core:project.read")).toBe(false);
  });

  test("groups hold principals and identities and do not nest", async () => {
    const h = await start(
      doc({
        groups: { "group:friends": ["discord:123456", "principal:prn_other"] },
        grants: [{ to: ["group:friends"], allow: ["search:*"] }],
      }),
    );
    expect(h.check(principal("prn_friend"), "search:query")).toBe(true);
    expect(h.check(principal("prn_other"), "search:admin")).toBe(true);
    expect(h.check(principal("prn_trusted"), "search:query")).toBe(false);
    expect(h.check(principal("prn_friend"), "exec:run")).toBe(false);

    const nested = await start(doc({ groups: { "group:a": ["group:b"], "group:b": [] } }));
    expect(nested.events[0]?.name).toBe("policy.rejected");
  });
});

describe("permission patterns, resources and via", () => {
  test("patterns: full name, namespace wildcard and *", async () => {
    const h = await start(
      doc({
        grants: [
          { to: ["principal:prn_other"], allow: ["search:*"] },
          { to: ["principal:prn_friend"], allow: ["*"] },
        ],
      }),
    );
    expect(h.check(principal("prn_other"), "search:admin")).toBe(true);
    expect(h.check(principal("prn_other"), "exec:run")).toBe(false);
    expect(h.check(principal("prn_friend"), "exec:run")).toBe(true);
  });

  test("on matches the resource, its ancestors, exact or trailing *", async () => {
    const h = await start(
      doc({
        grants: [
          {
            to: ["principal:prn_other"],
            allow: ["core:session.read"],
            on: ["project:prj_1", "session:ses_a*"],
          },
        ],
      }),
    );
    const s = principal("prn_other");
    expect(h.check(s, "core:session.read", "project:prj_1")).toBe(true);
    expect(h.check(s, "core:session.read", "project:prj_2")).toBe(false);
    expect(h.check(s, "core:session.read", { id: "session:ses_x", ancestors: ["project:prj_1"] })).toBe(true);
    expect(h.check(s, "core:session.read", { id: "session:ses_x", ancestors: ["project:prj_2"] })).toBe(
      false,
    );
    expect(h.check(s, "core:session.read", "session:ses_abc")).toBe(true);
    expect(h.check(s, "core:session.read", "session:ses_b")).toBe(false);
  });

  test("a scoped grant never matches a check without a resource", async () => {
    const h = await start(
      doc({ grants: [{ to: ["principal:prn_other"], allow: ["core:session.read"], on: ["project:*"] }] }),
    );
    expect(h.check(principal("prn_other"), "core:session.read")).toBe(false);
    expect(h.check(principal("prn_other"), "core:session.read", "project:prj_1")).toBe(true);
  });

  test("via authenticated needs authenticatedBy evidence", async () => {
    const h = await start(
      doc({ grants: [{ to: ["principal:prn_other"], allow: ["search:query"], via: "authenticated" }] }),
    );
    expect(h.check(principal("prn_other"), "search:query")).toBe(false);
    expect(h.check(principal("prn_other"), "search:query", undefined, "valet-auth")).toBe(true);
  });

  test("tag owners are a grant of policy:tag.assign on the tag", async () => {
    const h = await start(
      doc({
        tags: { "tag:ci": { owners: ["principal:prn_trusted"] } },
        useDefaults: false,
      }),
    );
    expect(h.check(principal("prn_trusted"), "policy:tag.assign", "tag:ci")).toBe(true);
    expect(h.check(principal("prn_trusted"), "policy:tag.assign", "tag:deploy")).toBe(false);
    expect(h.check(principal("prn_trusted"), "policy:tag.assign")).toBe(false);
    expect(h.check(principal("prn_owner"), "policy:tag.assign", "tag:deploy")).toBe(true);
  });
});

describe("file format", () => {
  test("JSONC: comments and trailing commas", async () => {
    const h = await start(`{
      // who may search
      "version": 1,
      /* grants */
      "grants": [
        { "to": ["principal:prn_other"], "allow": ["search:query",], },
      ],
    }`);
    expect(h.events.map((e) => e.name)).toEqual(["policy.changed"]);
    expect(h.check(principal("prn_other"), "search:query")).toBe(true);
  });

  test("schema errors are specific", () => {
    expect(() => parsePolicy("{ nope")).toThrow("not valid JSONC");
    expect(() => parsePolicy(doc({ version: 2 }))).toThrow("version");
    expect(() => parsePolicy(doc({ extra: 1 }))).toThrow('unknown key "extra"');
    expect(() => parsePolicy(doc({ grants: [{ to: ["bogus"], allow: ["*"] }] }))).toThrow("invalid selector");
    expect(() => parsePolicy(doc({ grants: [{ to: ["autogroup:nobody"], allow: ["*"] }] }))).toThrow(
      "autogroup",
    );
    expect(() => parsePolicy(doc({ grants: [{ to: ["tag:a"], allow: ["*"], via: "x" }] }))).toThrow("via");
    expect(() => parsePolicy(doc({ groups: { friends: [] } }))).toThrow("group:<name>");
    expect(() => parsePolicy(doc({ tests: [{ subject: "group:x" }] }))).toThrow("not allowed here");
  });

  test("unknown permissions and selectors warn instead of failing", async () => {
    const h = await start(
      doc({
        grants: [
          { to: ["group:ghost", "principal:prn_missing"], allow: ["ghost:thing", "nope:*", "search:query"] },
        ],
      }),
    );
    expect(h.events[0]?.name).toBe("policy.changed");
    const warns = h.logs.filter((l) => l.level === "warn").map((l) => l.msg);
    expect(warns).toContain('grants[0]: unknown group "group:ghost"');
    expect(warns).toContain('grants[0]: unknown principal "principal:prn_missing"');
    expect(warns).toContain('grants[0]: unknown permission "ghost:thing"');
    expect(warns).toContain('grants[0]: unknown permission "nope:*"');
    expect(warns.some((w) => w.includes('"search:query"'))).toBe(false);
  });
});

describe("tests", () => {
  const base = {
    grants: [{ to: ["group:friends"], allow: ["search:*"] }],
    groups: { "group:friends": ["discord:123456"] },
  };

  test("passing tests load the policy", async () => {
    const h = await start(
      doc({
        ...base,
        tests: [
          { subject: "discord:123456", allow: ["search:query"], deny: ["exec:run", "core:settings.write"] },
          { subject: "principal:prn_owner", audience: { tier: "trusted" }, deny: ["exec:run"] },
          {
            subject: "principal:prn_owner",
            audience: { principals: ["prn_friend"] },
            allow: ["search:query"],
            deny: ["exec:run"],
          },
          { subject: "principal:prn_owner", cap: ["search:*"], allow: ["search:query"], deny: ["exec:run"] },
          { subject: "autogroup:trusted", allow: ["mid:thing"], deny: ["exec:run"] },
          { subject: "tag:ci", deny: ["search:query"] },
          { subject: "autogroup:anyone", allow: ["open:read"] },
        ],
      }),
    );
    expect(h.events).toEqual([{ name: "policy.changed", payload: { mode: "policy" } }]);
  });

  test("a failing allow or deny rejects the file", async () => {
    for (const test of [
      { subject: "discord:123456", allow: ["exec:run"] },
      { subject: "discord:123456", deny: ["search:query"] },
      { subject: "principal:prn_owner", audience: { tier: "guest" }, allow: ["exec:run"] },
      { subject: "principal:prn_owner", audience: { principals: ["prn_other"] }, allow: ["search:query"] },
      { subject: "principal:prn_owner", cap: ["search:*"], allow: ["exec:run"] },
    ]) {
      const h = await start(doc({ ...base, tests: [test] }));
      expect(h.events[0]?.name).toBe("policy.rejected");
      expect(h.events[0]?.payload).toMatchObject({ reason: expect.stringContaining("tests[0]") });
      h.stop();
    }
  });

  test("resource and tags apply to a test", async () => {
    const h = await start(
      doc({
        grants: [{ to: ["tag:ci"], allow: ["core:session.read"], on: ["project:prj_1"] }],
        tests: [
          {
            subject: "autogroup:guest",
            tags: ["tag:ci"],
            resource: "project:prj_1",
            allow: ["core:session.read"],
          },
          {
            subject: "autogroup:guest",
            tags: ["tag:ci"],
            resource: "project:prj_2",
            deny: ["core:session.read"],
          },
          { subject: "autogroup:guest", tags: ["tag:ci"], deny: ["core:session.read"] },
        ],
      }),
    );
    expect(h.events[0]?.name).toBe("policy.changed");
  });
});

describe("load failure", () => {
  const good = doc({ grants: [{ to: ["principal:prn_other"], allow: ["search:query"] }] });
  const bad = "{ not json";

  test("a rejected reload keeps the last good policy and reports it", async () => {
    const h = await start(good);
    expect(h.check(principal("prn_other"), "search:query")).toBe(true);
    writeFileSync(join(h.home, "policy.json"), bad);
    await h.reload();
    expect(h.check(principal("prn_other"), "search:query")).toBe(true);
    const names = h.events.map((e) => e.name);
    expect(names).toEqual(["policy.changed", "policy.rejected", "policy.changed"]);
    expect(h.events[2]?.payload).toMatchObject({ mode: "last-good" });
    expect(h.events[1]?.payload).toMatchObject({ reason: expect.stringContaining("not valid JSONC") });
    expect(h.logs.some((l) => l.level === "error" && l.msg === "policy rejected")).toBe(true);

    writeFileSync(join(h.home, "policy.json"), doc({ useDefaults: false }));
    await h.reload();
    expect(h.check(principal("prn_other"), "search:query")).toBe(false);
    expect(h.events.at(-1)?.payload).toEqual({ mode: "policy" });
  });

  test("last-good survives a restart", async () => {
    const first = await start(good);
    const lastGood = join(first.home, "data", "valet-policy", "last-good.json");
    expect(existsSync(lastGood)).toBe(true);
    expect(JSON.parse(readFileSync(lastGood, "utf8")).grants).toHaveLength(1);
    first.stop();
    writeFileSync(join(first.home, "policy.json"), bad);
    const second = await start(undefined, first.home);
    expect(second.check(principal("prn_other"), "search:query")).toBe(true);
    expect(second.events.map((e) => e.name)).toEqual(["policy.rejected", "policy.changed"]);
    expect(second.events[1]?.payload).toMatchObject({ mode: "last-good" });
  });

  test("failing tests reject the file the same way", async () => {
    const h = await start(good);
    writeFileSync(
      join(h.home, "policy.json"),
      doc({ useDefaults: false, tests: [{ subject: "principal:prn_trusted", allow: ["exec:run"] }] }),
    );
    await h.reload();
    expect(h.check(principal("prn_other"), "search:query")).toBe(true);
    expect(h.check(principal("prn_trusted"), "mid:thing")).toBe(true);
    expect(h.events.map((e) => e.name)).toEqual(["policy.changed", "policy.rejected", "policy.changed"]);
  });

  test("no last-good: defaults mode, logged with the reason", async () => {
    const h = await start(
      doc({ useDefaults: false, tests: [{ subject: "autogroup:guest", allow: ["exec:run"] }] }),
    );
    expect(h.events.map((e) => e.name)).toEqual(["policy.rejected", "policy.changed"]);
    expect(h.events[1]?.payload).toMatchObject({ mode: "defaults" });
    const entered = h.logs.find((l) => l.msg.includes("defaults mode"));
    expect(entered?.level).toBe("warn");
    expect(h.check(guest, "open:read")).toBe(true);
    expect(h.check(principal("prn_trusted"), "mid:thing")).toBe(true);
    expect(h.check(principal("prn_trusted"), "exec:run")).toBe(false);
  });

  test("defaults mode recovers when the file becomes valid", async () => {
    const h = await start(bad);
    expect(h.events.at(-1)?.payload).toMatchObject({ mode: "defaults" });
    writeFileSync(join(h.home, "policy.json"), good);
    await h.reload();
    expect(h.check(principal("prn_other"), "search:query")).toBe(true);
    expect(h.events.at(-1)?.payload).toEqual({ mode: "policy" });
  });
});

describe("reload", () => {
  test("a change to policy.json is picked up by the watcher", async () => {
    const h = await start(undefined);
    expect(h.check(principal("prn_other"), "search:query")).toBe(false);
    writeFileSync(
      join(h.home, "policy.json"),
      doc({ grants: [{ to: ["principal:prn_other"], allow: ["search:query"] }] }),
    );
    const deadline = Date.now() + 5000;
    while (!h.check(principal("prn_other"), "search:query") && Date.now() < deadline) await Bun.sleep(25);
    expect(h.check(principal("prn_other"), "search:query")).toBe(true);
    expect(h.events.filter((e) => e.name === "policy.changed").length).toBeGreaterThanOrEqual(2);
  });
});
