import type { InputDef } from "@valethq/sdk";

export type StorageKind = "boolean" | "number" | "string" | "array" | "object";
export type UnitKind = "duration" | "bytes" | "tokens";

interface Primitive {
  kind: StorageKind;
  fields: string[];
}

const NUMBER_FIELDS = [
  "min",
  "max",
  "exclusiveMin",
  "exclusiveMax",
  "step",
  "unit",
  "integer",
  "precision",
  "style",
  "scale",
  "marks",
];

/** Fields every input may carry (InputBase), on top of its type's own. */
export const BASE_FIELDS = new Set([
  "type",
  "id",
  "label",
  "summary",
  "default",
  "required",
  "readonly",
  "when",
  "refs",
  "ttl",
]);

export const PRIMITIVES: Record<string, Primitive> = {
  bool: { kind: "boolean", fields: ["style"] },
  number: { kind: "number", fields: NUMBER_FIELDS },
  range: { kind: "array", fields: NUMBER_FIELDS },
  string: { kind: "string", fields: ["placeholder", "minLength", "maxLength", "masked"] },
  tags: { kind: "array", fields: [] },
  group: { kind: "object", fields: ["inputs", "layout"] },
  list: { kind: "array", fields: ["item", "style", "min", "max", "addLabel"] },
  map: { kind: "object", fields: ["key", "value"] },
  variant: { kind: "object", fields: ["tag", "cases"] },
};

interface Derived {
  base: string;
  /** Fields this type adds to its base's. */
  fields: string[];
  /** Fixed field values the type sets on its base. */
  preset?: Record<string, unknown>;
  unit?: UnitKind;
}

export const DERIVED: Record<string, Derived> = {
  int: { base: "number", fields: [], preset: { integer: true } },
  percent: { base: "number", fields: [] },
  duration: { base: "int", fields: [], unit: "duration" },
  bytes: { base: "int", fields: [], unit: "bytes" },
  tokens: { base: "int", fields: [], unit: "tokens" },
  strict_string: { base: "string", fields: ["pattern", "patternHint"] },
  text: { base: "string", fields: ["lines", "mono"] },
  code: { base: "text", fields: ["language"] },
  secret: { base: "string", fields: [] },
  path: { base: "string", fields: ["kind", "mustExist"] },
  url: { base: "strict_string", fields: ["schemes"] },
  color: {
    base: "strict_string",
    fields: [],
    preset: { pattern: "^#[0-9a-fA-F]{6}$", patternHint: "#rrggbb" },
  },
  keybind: { base: "string", fields: [] },
  select: { base: "string", fields: ["options", "style"] },
  multiselect: { base: "tags", fields: ["options", "style", "min", "max"] },
  ref: { base: "select", fields: [] },
};

/** Everything core knows about one input's type, after following its base chain. */
export interface TypeInfo {
  /** The type name, then each base down to the primitive. */
  chain: string[];
  primitive: string;
  kind: StorageKind;
  /** Fields an input of this type may set. */
  fields: Set<string>;
  /** Presets from the chain, base first; an input's own fields go on top. */
  preset: Record<string, unknown>;
  unit?: UnitKind;
  /** Has `secret` in its chain. */
  secret: boolean;
}

/** Follows a type to its primitive through local recipes and the catalog. Throws on an unknown type or a cycle. */
export function typeInfo(name: string, local: Record<string, InputDef> = {}): TypeInfo {
  const chain: string[] = [];
  const layers: Record<string, unknown>[] = [];
  const fieldSets: string[][] = [];
  let unit: UnitKind | undefined;
  let current = name;
  for (;;) {
    if (chain.includes(current)) throw new Error(`type "${name}" has a cycle through "${current}"`);
    chain.push(current);
    const prim = PRIMITIVES[current];
    if (prim !== undefined) {
      fieldSets.push(prim.fields);
      const fields = new Set([...BASE_FIELDS, ...fieldSets.flat()]);
      const preset = Object.assign({}, ...layers.reverse()) as Record<string, unknown>;
      return {
        chain,
        primitive: current,
        kind: prim.kind,
        fields,
        preset,
        ...(unit === undefined ? {} : { unit }),
        secret: chain.includes("secret"),
      };
    }
    const derived = DERIVED[current];
    if (derived !== undefined) {
      fieldSets.push(derived.fields);
      if (derived.preset) layers.push(derived.preset);
      unit ??= derived.unit;
      current = derived.base;
      continue;
    }
    const recipe = current.startsWith("local:") ? local[current] : undefined;
    if (recipe === undefined) throw new Error(`unknown type "${current}"`);
    const { base, ...fields } = recipe;
    if (typeof base !== "string") throw new Error(`type "${current}" needs a string "base"`);
    layers.push(fields);
    current = base;
  }
}

/** The recipe chain a UI needs for each non-primitive type in `used`, catalog and local alike. */
export function typeChains(
  used: Iterable<string>,
  local: Record<string, InputDef> = {},
): Record<string, InputDef> {
  const out: Record<string, InputDef> = {};
  for (const name of used) {
    for (const t of typeInfo(name, local).chain) {
      if (PRIMITIVES[t] !== undefined || out[t] !== undefined) continue;
      const d = DERIVED[t];
      out[t] = d !== undefined ? { base: d.base, ...d.preset } : (local[t] as InputDef);
    }
  }
  return out;
}
