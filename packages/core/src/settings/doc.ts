import type { Input, InputDef, Resolver, Scope, Setting, SettingsDoc } from "@valethq/sdk";
import { type TypeInfo, typeInfo } from "./catalog";

const ID = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const RESERVED = new Set(["enabled", "constructor", "__proto__", "prototype", "hasOwnProperty"]);
const SECTIONS = new Set(["system", "inference", "tools"]);
const RESOLVERS = new Set<Resolver>(["secret", "file", "env", "cmd"]);
export const DISPLAY_TYPES = new Set([
  "heading",
  "note",
  "divider",
  "link",
  "badge",
  "stat",
  "meter",
  "table",
  "action",
]);

/** One input with its type resolved and its children compiled. */
export interface Node {
  input: Input;
  info: TypeInfo;
  /** The type's presets with the input's own fields on top. */
  f: Record<string, unknown>;
  refs: Resolver[];
  /** group: value-bearing children. */
  inputs?: Node[];
  /** list item. */
  item?: Node;
  key?: Node;
  value?: Node;
  /** variant. */
  tag?: string;
  cases?: { value: string; inputs: Node[] }[];
}

export interface CompiledSetting {
  setting: Setting;
  node: Node;
  scopes: Scope[];
}

export interface CompiledDoc {
  doc: SettingsDoc;
  settings: Map<string, CompiledSetting>;
  /** Every type name the doc uses. */
  used: Set<string>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export class DocError extends Error {
  constructor(readonly errors: string[]) {
    super(`invalid settings document: ${errors.join("; ")}`);
    this.name = "DocError";
  }
}

const isContainer = (n: Node): boolean => ["group", "list", "map", "variant"].includes(n.info.primitive);

/** True for nodes that store a value directly (not group/list/map/variant). */
export const isLeaf = (n: Node): boolean => !isContainer(n);

/** Checks a settings document and compiles its inputs. Throws DocError listing every problem. */
export function compileDoc(doc: unknown): CompiledDoc {
  const errors: string[] = [];
  const err = (path: string, msg: string) => errors.push(`${path}: ${msg}`);
  const settings = new Map<string, CompiledSetting>();
  const used = new Set<string>();
  if (!isRecord(doc) || !isRecord(doc.sections)) throw new DocError(["settings: needs a sections object"]);
  const local = (isRecord(doc.types) ? doc.types : {}) as Record<string, InputDef>;

  for (const [name, recipe] of Object.entries(local)) {
    const at = `settings.types.${name}`;
    if (!name.startsWith("local:")) err(at, 'local type names start with "local:"');
    if (!isRecord(recipe) || typeof recipe.base !== "string") {
      err(at, "needs a string base");
      continue;
    }
    try {
      const base = typeInfo(recipe.base, local);
      for (const k of Object.keys(recipe))
        if (k !== "base" && !base.fields.has(k))
          err(at, `field "${k}" is not understood by "${recipe.base}"`);
    } catch (e) {
      err(at, (e as Error).message);
    }
  }

  const compileInput = (raw: unknown, at: string): Node | undefined => {
    if (!isRecord(raw) || typeof raw.type !== "string") {
      err(at, "input needs a string type");
      return undefined;
    }
    const input = raw as Input;
    let info: TypeInfo;
    try {
      info = typeInfo(input.type, local);
    } catch (e) {
      err(at, (e as Error).message);
      return undefined;
    }
    used.add(input.type);
    for (const k of Object.keys(input))
      if (!info.fields.has(k)) err(at, `field "${k}" is not understood by "${input.type}"`);
    if (input.id !== undefined && (typeof input.id !== "string" || !ID.test(input.id)))
      err(at, `id must match ${ID}`);
    const f = { ...info.preset, ...input };
    let refs = (input.refs ?? []) as Resolver[];
    if (!Array.isArray(refs) || refs.some((r) => !RESOLVERS.has(r))) {
      err(at, "refs must list secret, file, env or cmd");
      refs = [];
    }
    if (info.secret) {
      if (input.refs !== undefined && (refs.length !== 1 || refs[0] !== "secret"))
        err(at, 'a secret input accepts only "secret" refs');
      refs = ["secret"];
    }
    if (input.ttl !== undefined && (typeof input.ttl !== "number" || input.ttl < 0))
      err(at, "ttl must be a non-negative number of ms");
    const node: Node = { input, info, f, refs };
    if (refs.length > 0 && isContainer(node)) err(at, `${info.primitive} inputs take no refs`);
    const opts = f.options;
    if (info.chain.includes("select") || info.chain.includes("multiselect")) {
      if (Array.isArray(opts)) {
        const seen = new Set<string>();
        for (const o of opts) {
          if (!isRecord(o) || typeof o.value !== "string") err(at, "options need string values");
          else if (seen.has(o.value)) err(at, `duplicate option "${o.value}"`);
          else seen.add(o.value);
        }
      } else if (!isRecord(opts) || typeof opts.from !== "string") {
        err(at, "options must be a list or { from }");
      }
      if (info.chain.includes("ref") && !(isRecord(opts) && typeof opts.from === "string"))
        err(at, "a ref input needs options.from");
    }
    switch (info.primitive) {
      case "group":
        node.inputs = children(f.inputs, `${at}.inputs`);
        break;
      case "list": {
        const item = compileInput(f.item, `${at}.item`);
        if (item) node.item = item;
        break;
      }
      case "map": {
        const key = compileInput(f.key ?? { type: "string" }, `${at}.key`);
        // A map without `value` is a free-form object (arbitrary JSON keys and values).
        const value = f.value === undefined ? undefined : compileInput(f.value, `${at}.value`);
        if (key && key.info.kind !== "string") err(at, "a map key must be string-stored");
        if (key && key.refs.length > 0) err(at, "a map key takes no refs");
        if (key) node.key = key;
        if (value) node.value = value;
        break;
      }
      case "variant": {
        if (typeof f.tag !== "string" || !ID.test(f.tag)) err(at, `tag must match ${ID}`);
        else node.tag = f.tag;
        if (!Array.isArray(f.cases) || f.cases.length === 0) {
          err(at, "a variant needs cases");
          break;
        }
        const seen = new Set<string>();
        node.cases = [];
        for (const [i, c] of f.cases.entries()) {
          if (!isRecord(c) || typeof c.value !== "string") {
            err(`${at}.cases[${i}]`, "needs a string value");
            continue;
          }
          if (seen.has(c.value)) err(`${at}.cases[${i}]`, `duplicate case "${c.value}"`);
          seen.add(c.value);
          const inputs = children(c.inputs ?? [], `${at}.cases[${i}].inputs`);
          if (inputs.some((n) => n.input.id === node.tag))
            err(`${at}.cases[${i}]`, "an input reuses the tag id");
          node.cases.push({ value: c.value, inputs });
        }
        break;
      }
    }
    return node;
  };

  const children = (list: unknown, at: string): Node[] => {
    if (!Array.isArray(list)) {
      err(at, "must be a list");
      return [];
    }
    const out: Node[] = [];
    const ids = new Set<string>();
    for (const [i, raw] of list.entries()) {
      if (isRecord(raw) && DISPLAY_TYPES.has(raw.type as string)) continue;
      const node = compileInput(raw, `${at}[${i}]`);
      if (!node) continue;
      if (typeof node.input.id !== "string") err(`${at}[${i}]`, "needs an id");
      else if (ids.has(node.input.id)) err(`${at}[${i}]`, `duplicate id "${node.input.id}"`);
      else {
        ids.add(node.input.id);
        out.push(node);
      }
    }
    return out;
  };

  for (const [section, sec] of Object.entries(doc.sections)) {
    const at = `settings.sections.${section}`;
    if (!SECTIONS.has(section)) err(at, "sections are system, inference and tools");
    if (!isRecord(sec) || !Array.isArray(sec.subsections) || sec.subsections.length === 0) {
      err(at, "needs at least one subsection");
      continue;
    }
    const subIds = new Set<string>();
    for (const [si, sub] of sec.subsections.entries()) {
      const sat = `${at}.subsections[${si}]`;
      if (!isRecord(sub)) {
        err(sat, "must be an object");
        continue;
      }
      if (typeof sub.id !== "string" || !ID.test(sub.id)) err(sat, `id must match ${ID}`);
      else if (subIds.has(sub.id)) err(sat, `duplicate subsection "${sub.id}"`);
      else subIds.add(sub.id);
      if (typeof sub.label !== "string") err(sat, "needs a label");
      if (!Array.isArray(sub.items)) {
        err(sat, "needs items");
        continue;
      }
      for (const [ii, item] of sub.items.entries()) {
        const iat = `${sat}.items[${ii}]`;
        if (!isRecord(item)) {
          err(iat, "must be an object");
          continue;
        }
        if (item.input === undefined) {
          if (!DISPLAY_TYPES.has(item.type as string))
            err(iat, "neither a setting (no input) nor a display type");
          continue;
        }
        const s = item as unknown as Setting;
        if (typeof s.id !== "string" || !ID.test(s.id)) {
          err(iat, `id must match ${ID}`);
          continue;
        }
        if (RESERVED.has(s.id)) err(iat, `"${s.id}" is reserved`);
        if (settings.has(s.id)) err(iat, `duplicate setting "${s.id}"`);
        if (typeof s.label !== "string") err(iat, "needs a label");
        const scopes = s.scopes ?? ["user"];
        if (
          !Array.isArray(scopes) ||
          !scopes.includes("user") ||
          scopes.some((x) => x !== "user" && x !== "project")
        )
          err(iat, 'scopes must include "user" and only list "user" and "project"');
        if (s.migrate !== undefined && !Array.isArray(s.migrate)) err(iat, "migrate must be a list");
        const node = compileInput(s.input, `${iat}.input`);
        if (node) settings.set(s.id, { setting: s, node, scopes });
      }
    }
  }

  const checkCond = (cond: unknown, at: string, scope: Node | undefined): void => {
    if (!isRecord(cond)) {
      err(at, "a condition must be an object");
      return;
    }
    const keys = Object.keys(cond);
    if (keys.length !== 1) {
      err(at, "a condition has exactly one operator");
      return;
    }
    const op = keys[0] as string;
    const arg = cond[op];
    if (op === "not") {
      checkCond(arg, at, scope);
      return;
    }
    if (op === "all" || op === "any") {
      if (!Array.isArray(arg)) err(at, `${op} takes a list`);
      else for (const c of arg) checkCond(c, at, scope);
      return;
    }
    const path = op === "set" ? arg : Array.isArray(arg) ? arg[0] : undefined;
    if (!["eq", "ne", "in", "set"].includes(op) || typeof path !== "string") {
      err(at, `unknown condition ${JSON.stringify(cond)}`);
      return;
    }
    if (op === "in" && !Array.isArray((arg as unknown[])[1])) err(at, "in takes [path, values]");
    const target = nodeAt(settings, path, scope);
    if (target === null) err(at, `path "${path}" does not name an input`);
    else if (target !== undefined && target.refs.length > 0 && op !== "set")
      err(at, `"${path}" accepts refs, so its conditions may only use set`);
  };
  const walkConds = (node: Node, at: string, scope: Node | undefined): void => {
    if (node.input.when !== undefined) checkCond(node.input.when, `${at}.when`, scope);
    for (const c of node.inputs ?? []) walkConds(c, at, scope);
    for (const k of node.cases ?? []) for (const c of k.inputs) walkConds(c, at, scope);
    if (node.item) walkConds(node.item, at, node.item);
    if (node.value) walkConds(node.value, at, node.value);
  };
  for (const [id, cs] of settings) {
    if (cs.setting.when !== undefined) checkCond(cs.setting.when, `${id}.when`, undefined);
    walkConds(cs.node, id, undefined);
  }

  if (errors.length > 0) throw new DocError(errors);
  return { doc: doc as unknown as SettingsDoc, settings, used };
}

/**
 * The input a Path names: null when it names nothing, undefined when it goes through a map or list (can't be
 * checked statically). `scope` is the list item or map value "@" refers to.
 */
export function nodeAt(
  settings: Map<string, CompiledSetting>,
  path: string,
  scope?: Node,
): Node | null | undefined {
  const [head, ...rest] = path.split(".");
  let node: Node | undefined = head === "@" ? scope : settings.get(head ?? "")?.node;
  if (head === "@" && scope === undefined) return null;
  if (node === undefined) return null;
  for (const seg of rest) {
    if (node.inputs) {
      node = node.inputs.find((n) => n.input.id === seg);
      if (node === undefined) return null;
    } else if (node.cases) {
      if (seg === node.tag) return undefined;
      node = node.cases.flatMap((c) => c.inputs).find((n) => n.input.id === seg);
      if (node === undefined) return null;
    } else if (node.value || node.item) {
      return undefined;
    } else {
      return null;
    }
  }
  return node;
}

/** The setting's default: its input's `default`, or for a group the defaults its inputs declare. */
export function defaultOf(node: Node): unknown {
  if (node.input.default !== undefined) return node.input.default;
  if (node.inputs) {
    const out: Record<string, unknown> = {};
    for (const c of node.inputs) {
      const d = defaultOf(c);
      if (d !== undefined) out[c.input.id as string] = d;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return undefined;
}
