import type { Cond } from "@valethq/sdk";
import type { CompiledDoc, Node } from "./doc";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads a Path from stored values; "@" is the enclosing list item or map value. */
export function getPath(root: Record<string, unknown>, path: string, item?: unknown): unknown {
  const [head, ...rest] = path.split(".");
  let v: unknown = head === "@" ? item : root[head ?? ""];
  for (const seg of rest) v = isRecord(v) ? v[seg] : undefined;
  return v;
}

const isSet = (v: unknown) => v !== undefined && v !== null;

/** Evaluates a condition on stored text: refs compare as written, absent and null are "not set". */
export function evalCond(cond: Cond, root: Record<string, unknown>, item?: unknown): boolean {
  if ("not" in cond) return !evalCond(cond.not, root, item);
  if ("all" in cond) return cond.all.every((c) => evalCond(c, root, item));
  if ("any" in cond) return cond.any.some((c) => evalCond(c, root, item));
  if ("set" in cond) return isSet(getPath(root, cond.set, item));
  if ("eq" in cond) {
    const v = getPath(root, cond.eq[0], item);
    return isSet(v) && Bun.deepEquals(v, cond.eq[1]);
  }
  if ("ne" in cond) {
    const v = getPath(root, cond.ne[0], item);
    return !(isSet(v) && Bun.deepEquals(v, cond.ne[1]));
  }
  const v = getPath(root, cond.in[0], item);
  return isSet(v) && cond.in[1].some((x) => Bun.deepEquals(v, x));
}

/** Required failures where `when` holds, at every depth, keyed by path. `keys` limits the settings checked. */
export function requiredErrors(
  doc: CompiledDoc,
  values: Record<string, unknown>,
  keys?: Iterable<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  const check = (node: Node, value: unknown, path: string, item: unknown): void => {
    if (node.input.when !== undefined && !evalCond(node.input.when, values, item)) return;
    if (!isSet(value)) {
      if (node.input.required === true) out[path] = "required";
      return;
    }
    const fields = (inputs: Node[]) => {
      if (!isRecord(value)) return;
      for (const c of inputs) check(c, value[c.input.id as string], `${path}.${c.input.id}`, item);
    };
    if (node.inputs) fields(node.inputs);
    if (node.cases && isRecord(value))
      fields(node.cases.find((k) => k.value === value[node.tag as string])?.inputs ?? []);
    if (node.item && Array.isArray(value)) {
      const n = node.item;
      for (const [i, v] of value.entries()) check(n, v, `${path}[${i}]`, v);
    }
    if (node.value && isRecord(value)) {
      const n = node.value;
      for (const [k, v] of Object.entries(value)) check(n, v, `${path}[${JSON.stringify(k)}]`, v);
    }
  };
  const only = keys === undefined ? undefined : new Set(keys);
  for (const [id, cs] of doc.settings) {
    if (only !== undefined && !only.has(id)) continue;
    if (cs.setting.deprecated !== undefined) continue;
    if (cs.setting.when !== undefined && !evalCond(cs.setting.when, values)) continue;
    check(cs.node, values[id], id, undefined);
  }
  return out;
}
