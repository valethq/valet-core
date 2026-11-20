import type { CompiledDoc, Node } from "./doc";
import { defaultOf } from "./doc";
import { UNIT_PATTERNS } from "./units";

type Schema = Record<string, unknown>;

/**
 * - stored: what a layer may hold (published as `PluginSettings.schema`): refs and unit strings allowed.
 * - values: after unit parsing; refs still raw.
 * - resolved: a resolved ref's value; no refs, and `secret` is the plain string.
 */
export type Mode = "stored" | "values" | "resolved";

const SECRET_REF = String.raw`^\$\{secret:[A-Za-z0-9][A-Za-z0-9._-]{0,127}\}$`;
const anyRef = (refs: string[]) => `(^|[^$])\\$\\{(${refs.join("|")}):`;
const wholeRef = (refs: string[]) => `^\\$\\{(${refs.join("|")}):[^}]+\\}$`;

const put = (out: Schema, key: string, v: unknown) => {
  if (v !== undefined) out[key] = v;
};

function numberSchema(f: Record<string, unknown>): Schema {
  const out: Schema = { type: f.integer === true ? "integer" : "number" };
  put(out, "minimum", f.min);
  put(out, "maximum", f.max);
  put(out, "exclusiveMinimum", f.exclusiveMin);
  put(out, "exclusiveMaximum", f.exclusiveMax);
  put(out, "multipleOf", f.step);
  return out;
}

function base(node: Node, mode: Mode): Schema {
  const { f, info } = node;
  switch (info.primitive) {
    case "bool":
      return { type: "boolean" };
    case "number":
      return numberSchema(f);
    case "range":
      return { type: "array", items: numberSchema(f), minItems: 2, maxItems: 2, "x-ordered": true };
    case "string": {
      if (info.secret)
        return mode === "resolved" ? { type: "string" } : { type: "string", pattern: SECRET_REF };
      const out: Schema = { type: "string" };
      put(out, "minLength", f.minLength);
      put(out, "maxLength", f.maxLength);
      put(out, "pattern", f.pattern);
      put(out, "x-patternHint", f.patternHint);
      put(out, "x-schemes", f.schemes);
      if (f.mustExist === true) out["x-mustExist"] = f.kind === "dir" || f.kind === "file" ? f.kind : "any";
      if (Array.isArray(f.options) && !info.chain.includes("multiselect"))
        out.enum = (f.options as { value: string }[]).map((o) => o.value);
      return out;
    }
    case "tags": {
      const items: Schema = { type: "string" };
      if (Array.isArray(f.options)) items.enum = (f.options as { value: string }[]).map((o) => o.value);
      const out: Schema = { type: "array", items };
      put(out, "minItems", f.min);
      put(out, "maxItems", f.max);
      return out;
    }
    case "group":
      return objectOf(node.inputs ?? [], mode);
    case "list": {
      const out: Schema = { type: "array", items: node.item ? compileNode(node.item, mode) : {} };
      put(out, "minItems", f.min);
      put(out, "maxItems", f.max);
      return out;
    }
    case "map":
      return {
        type: "object",
        ...(node.key ? { propertyNames: compileNode(node.key, mode) } : {}),
        additionalProperties: node.value ? compileNode(node.value, mode) : {},
      };
    case "variant": {
      const tag = node.tag as string;
      return {
        type: "object",
        required: [tag],
        "x-discriminator": tag,
        oneOf: (node.cases ?? []).map((c) => {
          const s = objectOf(c.inputs, mode);
          (s.properties as Schema)[tag] = { const: c.value };
          return s;
        }),
      };
    }
    default:
      return {};
  }
}

function objectOf(inputs: Node[], mode: Mode): Schema {
  const properties: Schema = {};
  for (const c of inputs) properties[c.input.id as string] = compileNode(c, mode);
  return { type: "object", properties, additionalProperties: false };
}

/** One input's schema in the given mode. */
export function compileNode(node: Node, mode: Mode): Schema {
  let out = base(node, mode);
  if (mode === "stored" && node.info.unit !== undefined)
    out = { anyOf: [out, { type: "string", pattern: UNIT_PATTERNS[node.info.unit] }] };
  if (mode !== "resolved" && node.refs.length > 0 && !node.info.secret) {
    const ref = node.info.kind === "string" ? anyRef(node.refs) : wholeRef(node.refs);
    out = { anyOf: [{ type: "string", pattern: ref }, out] };
  }
  const title = node.input.label;
  if (mode === "stored") {
    if (typeof title === "string") out.title = title;
    if (node.input.default !== undefined) out.default = node.input.default;
  }
  return out;
}

/** The block schema: one property per setting, no others. */
export function compileDocSchema(doc: CompiledDoc, mode: Mode): Schema {
  const properties: Schema = {};
  for (const [id, cs] of doc.settings) {
    const s = compileNode(cs.node, mode);
    if (mode === "stored") {
      const d = defaultOf(cs.node);
      if (d !== undefined) s.default = d;
    }
    properties[id] = s;
  }
  return { type: "object", properties, additionalProperties: false };
}
