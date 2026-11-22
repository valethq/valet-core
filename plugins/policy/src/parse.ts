import type { Role } from "@valethq/sdk";
import { selectorError } from "./selectors";
import { emptyPolicyFile, type Grant, type PolicyFile, type PolicyTest } from "./types";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const ROLES: readonly string[] = ["guest", "trusted", "owner"];

class Reader {
  readonly errors: string[] = [];

  fail(path: string, msg: string): undefined {
    this.errors.push(`${path}: ${msg}`);
  }

  keys(o: Obj, path: string, allowed: string[]): void {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) this.fail(path, `unknown key "${k}"`);
  }

  strings(v: unknown, path: string, check?: (s: string) => string | undefined): string[] {
    if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) {
      this.fail(path, "must be an array of strings");
      return [];
    }
    for (const s of v as string[]) {
      const problem = check?.(s);
      if (problem !== undefined) this.fail(path, problem);
    }
    return v as string[];
  }

  selectors(v: unknown, path: string, opts?: { group?: boolean }): string[] {
    return this.strings(v, path, (s) => selectorError(s, opts));
  }
}

function readGrant(r: Reader, v: unknown, path: string): Grant | undefined {
  if (!isObj(v)) return r.fail(path, "must be an object");
  r.keys(v, path, ["to", "allow", "on", "via"]);
  const grant: Grant = { to: r.selectors(v.to, `${path}.to`), allow: r.strings(v.allow, `${path}.allow`) };
  if (v.on !== undefined) grant.on = r.strings(v.on, `${path}.on`);
  if (v.via !== undefined) {
    if (v.via === "authenticated") grant.via = "authenticated";
    else r.fail(`${path}.via`, 'must be "authenticated"');
  }
  return grant;
}

function readTest(r: Reader, v: unknown, path: string): PolicyTest | undefined {
  if (!isObj(v)) return r.fail(path, "must be an object");
  r.keys(v, path, ["subject", "audience", "tags", "cap", "resource", "allow", "deny"]);
  if (typeof v.subject !== "string") return r.fail(`${path}.subject`, "must be a string");
  const problem = selectorError(v.subject, { group: false });
  if (problem !== undefined) r.fail(`${path}.subject`, problem);
  const test: PolicyTest = { subject: v.subject };
  if (v.audience !== undefined) {
    if (!isObj(v.audience)) r.fail(`${path}.audience`, "must be an object");
    else {
      r.keys(v.audience, `${path}.audience`, ["tier", "principals"]);
      const audience: NonNullable<PolicyTest["audience"]> = {};
      const { tier, principals } = v.audience;
      if (tier !== undefined) {
        if (typeof tier === "string" && ROLES.includes(tier)) audience.tier = tier as Role;
        else r.fail(`${path}.audience.tier`, "must be guest, trusted or owner");
      }
      if (principals !== undefined)
        audience.principals = r.strings(principals, `${path}.audience.principals`);
      test.audience = audience;
    }
  }
  if (v.tags !== undefined) test.tags = r.strings(v.tags, `${path}.tags`);
  if (v.cap !== undefined) test.cap = r.strings(v.cap, `${path}.cap`);
  if (v.resource !== undefined) {
    if (typeof v.resource === "string") test.resource = v.resource;
    else r.fail(`${path}.resource`, "must be a string");
  }
  if (v.allow !== undefined) test.allow = r.strings(v.allow, `${path}.allow`);
  if (v.deny !== undefined) test.deny = r.strings(v.deny, `${path}.deny`);
  return test;
}

export function parsePolicy(text: string): PolicyFile {
  if (text.trim() === "") return emptyPolicyFile();
  let raw: unknown;
  try {
    raw = Bun.JSONC.parse(text);
  } catch (error) {
    throw new Error(`policy.json is not valid JSONC: ${error instanceof Error ? error.message : error}`);
  }
  if (!isObj(raw)) throw new Error("policy.json must be an object");
  const r = new Reader();
  r.keys(raw, "policy", ["version", "useDefaults", "groups", "tags", "grants", "tests"]);
  // spec-gap: a missing version is read as 1 so that "{}" is an empty policy.
  if (raw.version !== undefined && raw.version !== 1) r.fail("version", "must be 1");
  const file = emptyPolicyFile();
  if (raw.useDefaults !== undefined) {
    if (typeof raw.useDefaults === "boolean") file.useDefaults = raw.useDefaults;
    else r.fail("useDefaults", "must be a boolean");
  }
  if (raw.groups !== undefined) {
    if (!isObj(raw.groups)) r.fail("groups", "must be an object");
    else
      for (const [name, members] of Object.entries(raw.groups)) {
        if (!name.startsWith("group:") || name.length === 6)
          r.fail(`groups.${name}`, 'name must be "group:<name>"');
        file.groups[name] = r.selectors(members, `groups.${name}`, { group: false });
      }
  }
  if (raw.tags !== undefined) {
    if (!isObj(raw.tags)) r.fail("tags", "must be an object");
    else
      for (const [name, def] of Object.entries(raw.tags)) {
        if (!name.startsWith("tag:") || name.length === 4)
          r.fail(`tags.${name}`, 'name must be "tag:<name>"');
        if (!isObj(def)) r.fail(`tags.${name}`, "must be an object");
        else {
          r.keys(def, `tags.${name}`, ["owners"]);
          file.tags[name] = { owners: r.selectors(def.owners, `tags.${name}.owners`) };
        }
      }
  }
  for (const [key, list, read] of [
    ["grants", raw.grants, readGrant],
    ["tests", raw.tests, readTest],
  ] as const) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) r.fail(key, "must be an array");
    else
      list.forEach((item, i) => {
        const parsed = read(r, item, `${key}[${i}]`);
        if (parsed !== undefined) (file[key] as unknown[]).push(parsed);
      });
  }
  if (r.errors.length > 0) throw new Error(`policy.json is invalid: ${r.errors.join("; ")}`);
  return file;
}
