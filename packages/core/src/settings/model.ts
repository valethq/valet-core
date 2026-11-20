import type { InputDef, PluginManifest, Scope, SettingsDoc } from "@valethq/sdk";
import { isAbsolute } from "node:path";
import { validateAt } from "../jsonschema";
import { expandHome } from "../paths";
import { typeChains } from "./catalog";
import { compileDocSchema, compileNode } from "./compile";
import { requiredErrors } from "./cond";
import { type CompiledDoc, compileDoc, DocError, defaultOf, type Node } from "./doc";
import { interpolate, refsIn, tokenize } from "./refs";
import { parseUnit } from "./units";
import { DROP, mapLeaves } from "./walk";

type Block = Record<string, unknown>;
type Schema = Record<string, unknown>;
export type PathErrors = Record<string, string>;

const isRecord = (v: unknown): v is Block => typeof v === "object" && v !== null && !Array.isArray(v);

/** A plugin's settings, compiled once per manifest: a v3 document, or a raw configSchema. */
export interface Model {
  doc?: CompiledDoc;
  /** Published schema (stored form). */
  schema?: Schema;
  /** Schema for unit-parsed values, refs still raw. */
  valuesSchema?: Schema;
  defaults: Block;
  types?: Record<string, InputDef>;
}

export function buildModel(manifest: PluginManifest): Model {
  if (manifest.settings !== undefined) {
    const doc = compileDoc(manifest.settings);
    const model: Model = {
      doc,
      schema: compileDocSchema(doc, "stored"),
      valuesSchema: compileDocSchema(doc, "values"),
      defaults: {},
      types: typeChains(doc.used, (manifest.settings as SettingsDoc).types ?? {}),
    };
    const errors: string[] = [];
    for (const [id, cs] of doc.settings) {
      const d = defaultOf(cs.node);
      if (d === undefined) continue;
      model.defaults[id] = d;
      const e: PathErrors = {};
      const parsed = parseValues(model, { [id]: d }, e)[id];
      if (Object.keys(e).length === 0) Object.assign(e, checkKey(model, id, parsed));
      for (const [p, m] of Object.entries(e)) errors.push(`default ${p}: ${m}`);
    }
    if (errors.length > 0) throw new DocError(errors);
    return model;
  }
  const raw = manifest.configSchema;
  const defaults: Block = {};
  if (isRecord(raw?.properties))
    for (const [k, p] of Object.entries(raw.properties))
      if (isRecord(p) && "default" in p) defaults[k] = p.default;
  return { ...(raw === undefined ? {} : { schema: raw, valuesSchema: raw }), defaults };
}

/** Which layers a key may be stored in. Raw schemas and unknown keys are user-only. */
export function scopesOf(model: Model, key: string): Scope[] {
  return model.doc?.settings.get(key)?.scopes ?? ["user"];
}

export const isReadonly = (node: Node): boolean => node.input.readonly === true;

/** Parses unit strings and unescaped ref syntax per leaf; errors keyed by path. */
export function parseValues(model: Model, block: Block, errors: PathErrors): Block {
  const doc = model.doc;
  if (doc === undefined) return { ...block };
  const out: Block = { ...block };
  for (const [key, value] of Object.entries(block)) {
    const cs = doc.settings.get(key);
    if (cs === undefined) continue;
    out[key] = mapLeaves(cs.node, value, key, (node, v, path) => {
      if (typeof v !== "string") return v;
      if (node.refs.length > 0 && v.includes("${")) {
        try {
          if (refsIn(v, node.refs, node.info.kind !== "string").length > 0) return v;
        } catch (e) {
          errors[path] = (e as Error).message;
          return v;
        }
      }
      if (node.info.unit === undefined) return v;
      const n = parseUnit(node.info.unit, v);
      if (n === undefined) errors[path] = `not a valid ${node.info.unit} string`;
      return n ?? v;
    });
  }
  return out;
}

/** Schema errors for one key's (unit-parsed) value. */
export function checkKey(model: Model, key: string, value: unknown): PathErrors {
  const out: PathErrors = {};
  const vs = model.valuesSchema;
  if (vs === undefined) {
    out[key] = "this plugin takes no settings";
    return out;
  }
  const props = isRecord(vs.properties) ? vs.properties : {};
  const sub = props[key];
  if (!isRecord(sub)) {
    if (vs.additionalProperties === false) out[key] = "unknown setting";
    else if (isRecord(vs.additionalProperties))
      for (const e of validateAt(value, vs.additionalProperties, key)) push(out, e);
    return out;
  }
  for (const e of validateAt(value, sub, key)) push(out, e);
  return out;
}

const push = (out: PathErrors, e: string) => {
  const i = e.indexOf(": ");
  const path = i < 0 ? "" : e.slice(0, i);
  if (!(path in out)) out[path] = e.slice(i + 2);
};

/**
 * Full validation of a merged values block: unit/ref syntax, schema per key (or all keys), and `required`/`when`
 * on stored text. Raw-schema plugins validate the whole block against their schema.
 */
export function validateValues(model: Model, values: Block, keys?: string[]): PathErrors {
  const errors: PathErrors = {};
  if (model.doc === undefined) {
    if (model.valuesSchema === undefined) {
      for (const k of keys ?? []) errors[k] = "this plugin takes no settings";
      return errors;
    }
    for (const e of validateAt(values, model.valuesSchema, "")) {
      const [p, m] = splitErr(e);
      if (keys === undefined || keys.some((k) => p === k || p.startsWith(`${k}.`) || p === ""))
        errors[p || "config"] = m;
    }
    return errors;
  }
  parseValues(model, values, errors);
  for (const key of keys ?? Object.keys(values)) {
    if (values[key] === undefined && model.doc.settings.has(key)) continue;
    if (Object.keys(errors).some((p) => p === key || p.startsWith(`${key}.`) || p.startsWith(`${key}[`)))
      continue;
    Object.assign(errors, checkKey(model, key, values[key]));
  }
  const touched = keys === undefined ? [...model.doc.settings.keys()] : withDependents(model.doc, keys);
  for (const [p, m] of Object.entries(requiredErrors(model.doc, values, touched))) errors[p] ??= m;
  return errors;
}

/** The touched keys plus every setting whose conditions read one of them. */
function withDependents(doc: CompiledDoc, keys: string[]): string[] {
  const out = new Set(keys);
  const heads = (c: unknown, acc: Set<string>): void => {
    if (!isRecord(c)) return;
    for (const [op, arg] of Object.entries(c)) {
      if (op === "set" && typeof arg === "string") acc.add(arg.split(".")[0] as string);
      else if ((op === "eq" || op === "ne" || op === "in") && Array.isArray(arg))
        acc.add(String(arg[0]).split(".")[0] as string);
      else if (op === "not") heads(arg, acc);
      else if (Array.isArray(arg)) for (const x of arg) heads(x, acc);
    }
  };
  const nodeConds = (n: Node, acc: Set<string>): void => {
    heads(n.input.when, acc);
    for (const c of [...(n.inputs ?? []), ...(n.cases ?? []).flatMap((k) => k.inputs)]) nodeConds(c, acc);
    if (n.item) nodeConds(n.item, acc);
    if (n.value) nodeConds(n.value, acc);
  };
  for (const [id, cs] of doc.settings) {
    const acc = new Set<string>();
    heads(cs.setting.when, acc);
    nodeConds(cs.node, acc);
    if (keys.some((k) => acc.has(k))) out.add(id);
  }
  return [...out];
}

const splitErr = (e: string): [string, string] => {
  const i = e.indexOf(": ");
  return [e.slice(0, i).replace(/^\./, ""), e.slice(i + 2)];
};

/** A leaf whose value still holds a `cmd:` ref; resolved on read. */
export interface PendingLeaf {
  key: string;
  path: (string | number)[];
  node: Node;
  raw: string;
}

export interface ResolveResult {
  block: Block;
  pending: PendingLeaf[];
  /** Optional settings whose ref failed (now unset), and permission warnings. */
  issues: PathErrors;
  /** Required settings whose ref failed: the plugin can't run with this block. */
  fatal: PathErrors;
  /** ref text -> resolved value, for scrubbing and for refs inside pending leaves. */
  resolved: Map<string, string>;
  watches: Set<string>;
}

export type StaticResolve = (
  resolver: string,
  arg: string,
  ref: string,
) => { value: string; warning?: string; watch?: string };

/** Turns a resolved ref string into the input's storage form, then checks it against the resolved schema. */
export function parseResolved(node: Node, text: string, path: string): unknown {
  let v: unknown = text;
  switch (node.info.kind) {
    case "number": {
      const u = node.info.unit === undefined ? undefined : parseUnit(node.info.unit, text);
      v = u ?? (text.trim() === "" ? Number.NaN : Number(text));
      if (Number.isNaN(v)) throw new Error(`${path}: resolved value is not a number`);
      break;
    }
    case "boolean":
      if (text !== "true" && text !== "false")
        throw new Error(`${path}: resolved value is not true or false`);
      v = text === "true";
      break;
    case "array":
    case "object":
      try {
        v = JSON.parse(text);
      } catch {
        throw new Error(`${path}: resolved value is not JSON`);
      }
  }
  const errs = validateAt(v, compileNode(node, "resolved"), path);
  if (errs.length > 0) throw new Error(errs[0]);
  return v;
}

/** Resolves `secret:`, `file:` and `env:` in a values block. `cmd:` leaves stay raw and are listed as pending. */
export function resolveBlock(model: Model, values: Block, resolve: StaticResolve): ResolveResult {
  const res: ResolveResult = {
    block: { ...values },
    pending: [],
    issues: {},
    fatal: {},
    resolved: new Map(),
    watches: new Set(),
  };
  const doc = model.doc;
  if (doc === undefined) return res;
  for (const [key, value] of Object.entries(values)) {
    const cs = doc.settings.get(key);
    if (cs === undefined) continue;
    const required = cs.node.input.required === true;
    const out = mapLeaves(cs.node, value, key, (node, v, path) => {
      if (typeof v !== "string" || node.refs.length === 0 || !v.includes("${")) return v;
      const tokens = tokenize(v);
      let failed: string | undefined;
      for (const t of tokens) {
        if (!("ref" in t) || t.resolver === "cmd" || res.resolved.has(t.ref)) continue;
        try {
          const r = resolve(t.resolver, t.arg, t.ref);
          res.resolved.set(t.ref, r.value);
          if (r.watch) res.watches.add(r.watch);
          if (r.warning) res.issues[path] = r.warning;
        } catch (e) {
          failed = (e as Error).message;
          if (t.resolver === "file" && isAbsolute(expandHome(t.arg))) res.watches.add(expandHome(t.arg));
          break;
        }
      }
      if (failed === undefined && tokens.some((t) => "ref" in t && t.resolver === "cmd")) {
        res.pending.push({ key, path: pathOf(path, key), node, raw: v });
        return v;
      }
      try {
        if (failed !== undefined) throw new Error(`${key}: ${failed}`);
        const text = interpolate(tokens, (t) => res.resolved.get(t.ref) as string);
        return parseResolved(node, text, path);
      } catch (e) {
        const msg = (e as Error).message;
        if (required || node.input.required === true) res.fatal[path] = msg;
        else res.issues[path] = msg;
        return DROP;
      }
    });
    if (out === DROP) delete res.block[key];
    else res.block[key] = out;
  }
  return res;
}

/** "a.b[2][\"k\"]" -> ["a", "b", 2, "k"], dropping the leading key. */
function pathOf(path: string, key: string): (string | number)[] {
  const out: (string | number)[] = [];
  const rest = path.slice(key.length);
  for (const m of rest.matchAll(/\.([^.[]+)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g)) {
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
    else out.push(JSON.parse(m[3] as string) as string);
  }
  return out;
}

export type CmdRead = (ref: string, line: string, ttl: number) => { value?: string; error?: string };

/**
 * The block with each pending `cmd:` leaf filled from the cache. A leaf with no value yet is unset. `skip` holds
 * top-level keys an overlay replaced, whose pending leaves no longer apply.
 */
export function fillPending(
  block: Block,
  pending: PendingLeaf[],
  resolved: Map<string, string>,
  cmd: CmdRead,
  issues: PathErrors,
  skip: ReadonlySet<string> = new Set(),
): Block {
  const live = pending.filter((p) => !skip.has(p.key));
  if (live.length === 0) return block;
  const out: Block = { ...block };
  for (const p of live) {
    const where = [p.key, ...p.path]
      .map((s) => (typeof s === "number" ? `[${s}]` : `.${s}`))
      .join("")
      .slice(1);
    let value: unknown;
    let missing = false;
    try {
      const text = interpolate(tokenize(p.raw), (t) => {
        if (t.resolver !== "cmd") return resolved.get(t.ref) ?? "";
        const r = cmd(t.ref, t.arg, (p.node.input.ttl as number | undefined) ?? 60_000);
        if (r.error) issues[where] = r.error;
        if (r.value === undefined) missing = true;
        return r.value ?? "";
      });
      value = parseResolved(p.node, text, where);
    } catch (e) {
      issues[where] = (e as Error).message;
      missing = true;
    }
    setIn(out, [p.key, ...p.path], missing ? DROP : value);
  }
  return out;
}

/** Copy-on-write set along a path; DROP removes an object entry and leaves null in a list, so indices hold. */
function setIn(root: Block, path: (string | number)[], value: unknown): void {
  let parent: Block | unknown[] = root;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as string | number;
    const child: unknown = (parent as Record<string | number, unknown>)[k];
    const copy: Block | unknown[] | undefined = Array.isArray(child)
      ? [...child]
      : isRecord(child)
        ? { ...child }
        : undefined;
    if (copy === undefined) return;
    (parent as Record<string | number, unknown>)[k] = copy;
    parent = copy;
  }
  const last = path[path.length - 1] as string | number;
  if (value !== DROP) (parent as Record<string | number, unknown>)[last] = value;
  else if (Array.isArray(parent)) parent[last as number] = null;
  else delete (parent as Block)[last as string];
}
