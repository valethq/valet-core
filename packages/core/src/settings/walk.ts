import type { Node } from "./doc";
import { isLeaf } from "./doc";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Removes a leaf from its parent when returned from a `mapLeaves` callback. */
export const DROP = Symbol("drop");

export type LeafFn = (node: Node, value: unknown, path: string) => unknown;

/** Children of a container value paired with their nodes; unknown keys are left to validation. */
export function childrenOf(
  node: Node,
  value: unknown,
  path: string,
): [Node, unknown, string, string | number][] {
  if (node.inputs && isRecord(value))
    return node.inputs
      .filter((c) => (c.input.id as string) in value)
      .map((c) => [c, value[c.input.id as string], `${path}.${c.input.id}`, c.input.id as string]);
  if (node.cases && isRecord(value)) {
    const c = node.cases.find((k) => k.value === value[node.tag as string]);
    return (c?.inputs ?? [])
      .filter((n) => (n.input.id as string) in value)
      .map((n) => [n, value[n.input.id as string], `${path}.${n.input.id}`, n.input.id as string]);
  }
  if (node.item && Array.isArray(value)) {
    const item = node.item;
    return value.map((v, i) => [item, v, `${path}[${i}]`, i]);
  }
  if (node.value && isRecord(value)) {
    const v = node.value;
    return Object.entries(value).map(([k, x]) => [v, x, `${path}[${JSON.stringify(k)}]`, k]);
  }
  return [];
}

/** A copy of `value` with each leaf replaced by `fn`'s result (DROP removes it). Containers are rebuilt. */
export function mapLeaves(node: Node, value: unknown, path: string, fn: LeafFn): unknown {
  if (isLeaf(node) || value === null || value === undefined) return fn(node, value, path);
  const kids = childrenOf(node, value, path);
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const [n, v, p] of kids) {
      const r = mapLeaves(n, v, p, fn);
      if (r !== DROP) out.push(r);
    }
    return out;
  }
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [n, v, p, k] of kids) {
    const r = mapLeaves(n, v, p, fn);
    if (r === DROP) delete out[k as string];
    else out[k as string] = r;
  }
  return out;
}

/** Visits every node/value pair, containers before their children. `item` is the enclosing list item or map value. */
export function visit(
  node: Node,
  value: unknown,
  path: string,
  fn: (node: Node, value: unknown, path: string, item: unknown) => boolean | undefined,
  item?: unknown,
): void {
  if (fn(node, value, path, item) === false) return;
  const inItem = node.item !== undefined || node.value !== undefined;
  for (const [n, v, p] of childrenOf(node, value, path)) visit(n, v, p, fn, inItem ? v : item);
}
