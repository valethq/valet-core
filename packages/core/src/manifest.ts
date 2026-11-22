import { CORE_API_VERSION } from "@valethq/sdk";
import { CORE_EVENT_NAMESPACES } from "./bus/types";

// spec-gap: the doc shows ids like "valet-discord" but never fixes a grammar.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCOPE_KEY_RE = /^[a-z0-9][a-z0-9-]*@\d+$/;
// spec-gap: Bun.semver treats a garbage range as "*", so require a real range.

export function scopeKey(name: string, version: number): string {
  return `${name}@${version}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSemver(value: string): boolean {
  try {
    Bun.semver.order(value, "0.0.0");
    return true;
  } catch {
    return false;
  }
}

function isPrereleaseId(id: string): boolean {
  if (!/^[0-9A-Za-z-]+$/.test(id)) return false;
  return !/^\d+$/.test(id) || /^(?:0|[1-9]\d*)$/.test(id);
}

/** A partial version: `1`, `1.2`, `1.2.3`, `1.x`, `*`, with an optional `v`, prerelease and build. */
function isPartial(value: string): boolean {
  const match = /^(v)?([^+-]+?)(?:-([^+]+))?(?:\+(.+))?$/.exec(value);
  if (match === null) return false;
  const core = match[2];
  if (core === undefined || core === "") return false;
  const parts = core.split(".");
  if (parts.length > 3) return false;
  let wildcard = false;
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d*|[xX*])$/.test(part)) return false;
    if (wildcard && !/^[xX*]$/.test(part)) return false;
    if (/^[xX*]$/.test(part)) wildcard = true;
  }
  const pre = match[3];
  const build = match[4];
  if (pre !== undefined && !pre.split(".").every(isPrereleaseId)) return false;
  if (build !== undefined && !build.split(".").every((part) => /^[0-9A-Za-z-]+$/.test(part))) return false;
  return true;
}

function isComparator(token: string): boolean {
  const version = /^(>=|<=|>|<|=|~|\^)?(.+)$/.exec(token)?.[2];
  return version !== undefined && version !== "" && isPartial(version);
}

/** `*`, a comparator, an AND (`>=1.0.0 <2.0.0`), a hyphen (`1.0.0 - 2.0.0`) or OR (`||`) of those. */
function isSemverRange(range: string): boolean {
  if (range.length === 0 || range !== range.trim()) return false;
  const clauses = range.split(/\s*\|\|\s*/);
  if (clauses.length === 0) return false;
  for (const clause of clauses) {
    if (clause.length === 0) return false;
    const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(clause);
    if (hyphen !== null) {
      const left = hyphen[1];
      const right = hyphen[2];
      if (left === undefined || right === undefined || !isPartial(left) || !isPartial(right)) return false;
      continue;
    }
    const tokens = clause.split(/\s+/);
    if (tokens.length === 0 || tokens.some((token) => !isComparator(token))) return false;
  }
  return true;
}

function checkRangeMap(value: unknown, field: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${field} must be an object of id -> semver range`);
    return;
  }
  for (const [dep, range] of Object.entries(value)) {
    if (!ID_RE.test(dep)) errors.push(`${field} key "${dep}" is not a plugin id`);
    if (typeof range !== "string" || !isSemverRange(range)) {
      errors.push(`${field}["${dep}"] must be a semver range, got ${JSON.stringify(range)}`);
    }
  }
}

function checkScopeList(value: unknown, field: string, errors: string[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((s) => typeof s !== "string" || !SCOPE_KEY_RE.test(s))) {
    errors.push(`${field} must be a string array of "name@major"`);
  }
}

/** 5.2 step 2: manifest shape plus the `valet` range against CORE_API_VERSION. Returns error strings. */
export function validateManifest(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(manifest)) return ["manifest is not an object"];
  const m = manifest;

  if (m.schema !== 1) errors.push(`schema must be 1, got ${JSON.stringify(m.schema)}`);
  if (typeof m.id !== "string" || !ID_RE.test(m.id)) {
    errors.push(`id must match ${ID_RE}, got ${JSON.stringify(m.id)}`);
  }
  if (typeof m.name !== "string" || m.name === "") errors.push("name must be a non-empty string");
  if (typeof m.version !== "string" || !isSemver(m.version)) {
    errors.push(`version must be semver, got ${JSON.stringify(m.version)}`);
  }
  if (typeof m.valet !== "string" || !isSemverRange(m.valet)) {
    errors.push(`valet must be a semver range, got ${JSON.stringify(m.valet)}`);
  } else if (!Bun.semver.satisfies(CORE_API_VERSION, m.valet)) {
    errors.push(`valet range "${m.valet}" does not cover core API ${CORE_API_VERSION}`);
  }
  if (typeof m.main !== "string" || m.main === "") {
    errors.push("main must be a non-empty string");
  } else if (m.main.startsWith("/") || m.main.split("/").includes("..")) {
    errors.push(`main must be a relative path inside the plugin dir, got ${JSON.stringify(m.main)}`);
  }
  if (m.repository !== undefined && typeof m.repository !== "string") {
    errors.push("repository must be a string");
  }
  if (m.description !== undefined && typeof m.description !== "string") {
    errors.push("description must be a string");
  }

  checkRangeMap(m.dependencies, "dependencies", errors);
  checkRangeMap(m.optionalDependencies, "optionalDependencies", errors);
  checkScopeList(m.provides, "provides", errors);
  checkScopeList(m.requires, "requires", errors);
  checkScopeList(m.optionalRequires, "optionalRequires", errors);

  const ns = isRecord(m.events) ? m.events.namespace : undefined;
  if (ns !== undefined && (typeof ns !== "string" || !ID_RE.test(ns))) {
    errors.push(`events.namespace must match ${ID_RE}, got ${JSON.stringify(ns)}`);
  } else {
    const effective =
      typeof ns === "string" ? ns : typeof m.id === "string" ? m.id.replace(/^valet-/, "") : "";
    if (CORE_EVENT_NAMESPACES.has(effective)) {
      errors.push(`events.namespace "${effective}" is reserved by core`);
    }
  }
  if (m.configSchema !== undefined && !isRecord(m.configSchema)) {
    errors.push("configSchema must be an object");
  }
  if (
    m.permissions !== undefined &&
    (!Array.isArray(m.permissions) || m.permissions.some((p) => typeof p !== "string"))
  ) {
    errors.push("permissions must be a string array");
  }
  if (m.acl !== undefined) checkAcl(m.acl, errors);
  return errors;
}

const ROLES = new Set(["owner", "trusted", "guest"]);

function checkAcl(acl: unknown, errors: string[]): void {
  if (!isRecord(acl) || !isRecord(acl.permissions)) {
    errors.push("acl.permissions must be an object");
    return;
  }
  for (const [name, def] of Object.entries(acl.permissions)) {
    const at = `acl.permissions.${name}`;
    if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/.test(name))
      errors.push(`${at}: name must be dotted lowercase`);
    if (!isRecord(def) || typeof def.summary !== "string") {
      errors.push(`${at}.summary must be a string`);
      continue;
    }
    if (def.default !== undefined && !ROLES.has(def.default as string))
      errors.push(`${at}.default must be owner, trusted or guest`);
    if (def.resource !== undefined && typeof def.resource !== "string")
      errors.push(`${at}.resource must be a string`);
    if (def.requireVerifiedLogin !== undefined && typeof def.requireVerifiedLogin !== "boolean")
      errors.push(`${at}.requireVerifiedLogin must be a boolean`);
  }
}
