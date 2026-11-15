import { CORE_API_VERSION } from "@valethq/sdk";

// spec-gap: the doc shows ids like "valet-discord" but never fixes a grammar.
const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
const SCOPE_KEY_RE = /^[a-z0-9][a-z0-9-]*@\d+$/;
// spec-gap: Bun.semver treats a garbage range as "*", so require range-ish
// characters plus at least one digit or wildcard.
const RANGE_RE = /^[0-9A-Za-z.*+^~<>=|,&\s-]+$/;
const hasVersionChar = (s: string) => /[0-9*xX]/.test(s);

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

function checkRangeMap(value: unknown, field: string, errors: string[]): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    errors.push(`${field} must be an object of id -> semver range`);
    return;
  }
  for (const [dep, range] of Object.entries(value)) {
    if (!ID_RE.test(dep)) errors.push(`${field} key "${dep}" is not a plugin id`);
    if (typeof range !== "string" || range === "" || !RANGE_RE.test(range) || !hasVersionChar(range)) {
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
  if (typeof m.valet !== "string" || m.valet === "" || !RANGE_RE.test(m.valet) || !hasVersionChar(m.valet)) {
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

  const ns = (m.events as Record<string, unknown> | undefined)?.namespace;
  if (ns !== undefined && (typeof ns !== "string" || !ID_RE.test(ns))) {
    errors.push(`events.namespace must match ${ID_RE}, got ${JSON.stringify(ns)}`);
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
  return errors;
}
