import type { Migration } from "@valethq/sdk";
import type { StorageKind } from "./catalog";
import type { Node } from "./doc";
import type { Model } from "./model";
import { refsIn } from "./refs";
import { parseUnit } from "./units";

type Block = Record<string, unknown>;

export interface MigrateResult {
  layer: Block;
  changed: boolean;
  warnings: string[];
  /** plugin_kv keys whose values moved into this layer. */
  kvMoved: string[];
}

const kindOf = (v: unknown): StorageKind | "null" =>
  v === null || v === undefined ? "null" : Array.isArray(v) ? "array" : (typeof v as StorageKind);

/** A stored form the input already accepts besides its storage kind: a ref string or a valid unit string. */
function accepts(node: Node, v: unknown): boolean {
  if (typeof v !== "string") return false;
  if (node.info.unit !== undefined && parseUnit(node.info.unit, v) !== undefined) return true;
  if (node.refs.length === 0) return false;
  try {
    return refsIn(v, node.refs, true).length > 0;
  } catch {
    return false;
  }
}

const NO_VALUE = Symbol("no value");

function transform(map: Migration["map"], old: unknown): unknown {
  if (map === undefined) return old;
  if ("template" in map) {
    if (typeof old !== "string") return NO_VALUE;
    // A blank or whitespace-only old name yields nothing usable: drop it so the input's default fires.
    const trimmed = old.trim();
    return trimmed === "" ? NO_VALUE : map.template.replaceAll("{}", trimmed);
  }
  if ("scale" in map) return typeof old === "number" ? old * map.scale : NO_VALUE;
  if ("match" in map) {
    if (typeof old !== "string") return NO_VALUE;
    const m = new RegExp(map.match, "u").exec(old);
    if (m === null) return NO_VALUE;
    const out: Block = {};
    for (const [k, v] of Object.entries(m.groups ?? {})) if (v !== undefined) out[k] = v;
    return out;
  }
  const key = typeof old === "string" ? old : JSON.stringify(old);
  return Object.hasOwn(map.values, key) ? map.values[key] : NO_VALUE;
}

/**
 * Runs each setting's `migrate` entries on one stored layer. The first entry that applies wins; when the new key
 * already has a value in the layer, the old one is dropped. `kv` reads plugin_kv rows (user layer only).
 */
export function migrateLayer(model: Model, layer: Block, kv?: (key: string) => unknown): MigrateResult {
  const res: MigrateResult = { layer: { ...layer }, changed: false, warnings: [], kvMoved: [] };
  const out = res.layer;
  for (const [id, cs] of model.doc?.settings ?? []) {
    for (const entry of cs.setting.migrate ?? []) {
      let old: unknown;
      let source: string;
      if (entry.from?.startsWith("kv:")) {
        const key = entry.from.slice(3);
        old = kv?.(key);
        if (old === undefined) continue;
        res.kvMoved.push(key);
        source = entry.from;
      } else if (entry.from !== undefined) {
        if (!Object.hasOwn(out, entry.from)) continue;
        old = out[entry.from];
        delete out[entry.from];
        source = entry.from;
      } else {
        if (!Object.hasOwn(out, id)) continue;
        old = out[id];
        if (kindOf(old) === cs.node.info.kind || kindOf(old) === "null" || accepts(cs.node, old)) continue;
        delete out[id];
        source = id;
      }
      res.changed = true;
      if (Object.hasOwn(out, id)) {
        res.warnings.push(`${source}: dropped, "${id}" already has a value`);
        break;
      }
      const next = transform(entry.map, old);
      if (next === NO_VALUE)
        res.warnings.push(`${source}: value could not be migrated to "${id}" and was dropped`);
      else {
        out[id] = next;
        res.warnings.push(`${source}: migrated to "${id}"`);
      }
      break;
    }
  }
  return res;
}
