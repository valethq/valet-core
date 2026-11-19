import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger, PluginManifest } from "@valethq/sdk";
import type { ValetConfig } from "./config";
import { validateJsonSchema } from "./jsonschema";
import { withDefaults } from "./settings";
import { validateManifest } from "./manifest";

export type PluginState = "pending" | "active" | "failed" | "disabled";

export interface PluginRecord {
  id: string;
  dir: string;
  state: PluginState;
  manifest?: PluginManifest;
  error?: string;
  /** Position in the computed load order; only plugins that reached the graph have one. */
  order?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPluginDir(base: string, entry: Dirent): boolean {
  if (entry.isDirectory()) return true;
  if (!entry.isSymbolicLink()) return false;
  try {
    return statSync(join(base, entry.name)).isDirectory();
  } catch {
    return false;
  }
}

/** 5.2 step 1: read every "PLUGIN_DIR/manifest.json" under each plugin path. Throws on a duplicate id. */
export function discoverPlugins(config: ValetConfig, log: Logger): PluginRecord[] {
  const records: PluginRecord[] = [];
  const seen = new Map<string, string>();
  for (const base of config.pluginPaths) {
    if (!existsSync(base)) {
      log.debug(`plugin path ${base} does not exist, skipping`);
      continue;
    }
    const entries = readdirSync(base, { withFileTypes: true })
      .filter((entry) => isPluginDir(base, entry))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const dir = join(base, entry.name);
      const manifestPath = join(dir, "manifest.json");
      if (!existsSync(manifestPath)) continue;
      let raw: unknown;
      let parseError: string | undefined;
      try {
        raw = JSON.parse(readFileSync(manifestPath, "utf8"));
      } catch (error) {
        parseError = `manifest.json is not valid JSON: ${(error as Error).message}`;
      }
      // spec-gap: an unparseable manifest still occupies a slot, keyed by directory name.
      const id = isRecord(raw) && typeof raw.id === "string" ? raw.id : entry.name;
      const prev = seen.get(id);
      if (prev !== undefined) {
        throw new Error(`duplicate plugin id "${id}" (${prev} and ${dir})`);
      }
      seen.set(id, dir);
      const rec: PluginRecord = { id, dir, state: "pending" };
      if (parseError !== undefined) {
        rec.state = "failed";
        rec.error = parseError;
      } else {
        rec.manifest = raw as PluginManifest;
      }
      records.push(rec);
    }
  }
  return records;
}

/**
 * 5.2 steps 2-4: validate manifests and config, build the dependency/scope
 * graph and produce the activation order. Marks `state`/`error` on every record.
 * Returns the plugins to activate, in order.
 */
export function resolvePlugins(records: PluginRecord[], config: ValetConfig, log: Logger): PluginRecord[] {
  // Disabled-by-config drop (step 1) then manifest + configSchema validation (step 2).
  for (const rec of records) {
    if (rec.state === "failed") continue;
    if (config.plugins[rec.id]?.enabled === false) {
      rec.state = "disabled";
      continue;
    }
    const manifestErrors = validateManifest(rec.manifest);
    if (manifestErrors.length > 0) {
      rec.state = "failed";
      rec.error = `invalid manifest: ${manifestErrors.join("; ")}`;
      continue;
    }
    const schema = rec.manifest?.configSchema;
    if (schema !== undefined) {
      const errors = validateJsonSchema(withDefaults(schema, config.plugins[rec.id]?.config ?? {}), schema);
      if (errors.length > 0) {
        rec.state = "failed";
        rec.error = `invalid plugin config: ${errors.join("; ")}`;
      }
    }
  }

  const loadable = new Map<string, PluginRecord>();
  for (const rec of records) {
    if (rec.state === "pending" && rec.manifest) loadable.set(rec.id, rec);
  }

  const providersOf = (scope: string): PluginRecord[] =>
    [...loadable.values()].filter((p) => p.state === "pending" && p.manifest?.provides?.includes(scope));

  /** Step 3: hard requirements that fail a plugin outright (and cascade). */
  const unmetStatic = (rec: PluginRecord): string | undefined => {
    const manifest = rec.manifest as PluginManifest;
    for (const [depId, range] of Object.entries(manifest.dependencies ?? {})) {
      const dep = loadable.get(depId);
      if (!dep) return `missing dependency "${depId}"`;
      if (dep.state === "failed") return `dependency "${depId}" failed`;
      // spec-gap: a dependency range is enforced the obvious way.
      if (!Bun.semver.satisfies(dep.manifest?.version ?? "", range)) {
        return `dependency "${depId}@${dep.manifest?.version}" does not satisfy "${range}"`;
      }
    }
    for (const scope of manifest.requires ?? []) {
      if (providersOf(scope).length === 0) return `required scope "${scope}" has no provider`;
    }
    return undefined;
  };

  // Missing hard deps / required scopes, cascading to dependents until stable.
  let changed = true;
  while (changed) {
    changed = false;
    for (const rec of loadable.values()) {
      if (rec.state !== "pending") continue;
      const error = unmetStatic(rec);
      if (error !== undefined) {
        rec.state = "failed";
        rec.error = error;
        changed = true;
      }
    }
  }

  // Step 3: edges from hard deps, present optional deps, and every provider of a
  // required or optional scope (providers load before their consumers).
  const pending = [...loadable.values()].filter((r) => r.state === "pending");
  const pendingSet = new Set(pending);
  const edges = new Map<string, Set<string>>(); // prerequisite -> dependents
  const addEdge = (from: PluginRecord, to: PluginRecord): void => {
    if (!pendingSet.has(from) || !pendingSet.has(to) || from === to) return;
    const list = edges.get(from.id) ?? new Set();
    list.add(to.id);
    edges.set(from.id, list);
  };
  for (const rec of pending) {
    const manifest = rec.manifest as PluginManifest;
    for (const depId of Object.keys(manifest.dependencies ?? {})) {
      const dep = loadable.get(depId);
      if (dep) addEdge(dep, rec);
    }
    for (const depId of Object.keys(manifest.optionalDependencies ?? {})) {
      const dep = loadable.get(depId);
      // spec-gap: an optional dep whose version misses its range is treated as absent.
      if (
        dep?.state === "pending" &&
        Bun.semver.satisfies(dep.manifest?.version ?? "", manifest.optionalDependencies?.[depId] ?? "*")
      ) {
        addEdge(dep, rec);
      }
    }
    for (const scope of [...(manifest.requires ?? []), ...(manifest.optionalRequires ?? [])]) {
      for (const provider of providersOf(scope)) addEdge(provider, rec);
    }
  }

  // Step 4: Kahn's algorithm, ties broken by id so boot order is deterministic.
  const byId = new Map(pending.map((r) => [r.id, r]));
  let order = kahn(pending, edges);

  // Leftover nodes are in a cycle or downstream of one.
  // Disjoint cycles get their own error; hard dependents cascade-fail below.
  const leftover = pending.filter((r) => !order.includes(r));
  if (leftover.length > 0) {
    const remaining = new Set(leftover.map((r) => r.id));
    while (remaining.size > 0) {
      const successors = new Map<string, string[]>();
      for (const id of remaining) {
        successors.set(
          id,
          [...(edges.get(id) ?? [])].filter((to) => remaining.has(to)),
        );
      }
      const cycle = findCycle(remaining, successors);
      if (!cycle) break;
      for (const id of cycle) {
        const rec = byId.get(id);
        if (rec) {
          rec.state = "failed";
          rec.error = `dependency cycle: ${[...cycle, cycle[0]].join(" -> ")}`;
        }
        remaining.delete(id);
      }
      log.warn(`plugin dependency cycle: ${[...cycle, cycle[0]].join(" -> ")}`, { plugins: cycle });
    }

    // A cycle failure cascades to hard dependents like any other failure.
    let cascade = true;
    while (cascade) {
      cascade = false;
      for (const rec of loadable.values()) {
        if (rec.state !== "pending") continue;
        const error = unmetStatic(rec);
        if (error !== undefined) {
          rec.state = "failed";
          rec.error = error;
          cascade = true;
        }
      }
    }

    // Edges out of failed nodes are gone. Optional dependents of a cycle still activate.
    const ordered = new Set(order.map((r) => r.id));
    const still = pending.filter((r) => r.state === "pending" && !ordered.has(r.id));
    if (still.length > 0) {
      const more = kahn(still, edges);
      order = order.concat(more);
      const scheduled = new Set(more.map((r) => r.id));
      const stuck = still.filter((r) => !scheduled.has(r.id));
      if (stuck.length > 0) {
        log.warn(`plugins left unresolved after a dependency cycle: ${stuck.map((r) => r.id).join(", ")}`);
        for (const rec of stuck) {
          rec.state = "failed";
          rec.error = "unresolved dependency cycle";
        }
      }
    }
  }

  for (const [i, rec] of order.entries()) rec.order = i;
  return order;
}

/** Kahn's algorithm over `nodes`. Edges whose source is outside `nodes` are ignored. */
function kahn(nodes: PluginRecord[], edges: Map<string, Set<string>>): PluginRecord[] {
  const indegree = new Map<string, number>(nodes.map((r) => [r.id, 0]));
  for (const rec of nodes) {
    for (const to of edges.get(rec.id) ?? []) {
      if (!indegree.has(to)) continue;
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }
  const byId = new Map(nodes.map((r) => [r.id, r]));
  const ready = nodes
    .filter((r) => (indegree.get(r.id) ?? 0) === 0)
    .map((r) => r.id)
    .sort();
  const order: PluginRecord[] = [];
  while (ready.length > 0) {
    const id = ready.shift() as string;
    const rec = byId.get(id);
    if (!rec) continue;
    order.push(rec);
    for (const to of edges.get(id) ?? []) {
      if (!indegree.has(to)) continue;
      const next = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, next);
      if (next === 0) {
        ready.push(to);
        ready.sort();
      }
    }
  }
  return order;
}

/** Iterative three-color DFS; returns one cycle among `ids` (start node not repeated), or undefined. */
function findCycle(
  ids: ReadonlySet<string>,
  successors: ReadonlyMap<string, string[]>,
): string[] | undefined {
  const state = new Map<string, number>(); // 1 = visiting, 2 = done
  const stack: string[] = [];
  for (const start of ids) {
    if (state.has(start)) continue;
    const frames: { id: string; next: number }[] = [{ id: start, next: 0 }];
    state.set(start, 1);
    stack.push(start);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1] as { id: string; next: number };
      const tos = successors.get(frame.id) ?? [];
      if (frame.next < tos.length) {
        const to = tos[frame.next++] as string;
        const s = state.get(to) ?? 0;
        if (s === 1) return stack.slice(stack.indexOf(to));
        if (s === 0) {
          state.set(to, 1);
          stack.push(to);
          frames.push({ id: to, next: 0 });
        }
      } else {
        frames.pop();
        state.set(frame.id, 2);
        stack.pop();
      }
    }
  }
  return undefined;
}

/**
 * Re-checks a plugin's hard requirements at activation time: every dependency
 * must be active, and every required scope must have at least one active provider.
 */
export function unmetAtActivation(rec: PluginRecord, byId: Map<string, PluginRecord>): string | undefined {
  const manifest = rec.manifest as PluginManifest;
  for (const depId of Object.keys(manifest.dependencies ?? {})) {
    const dep = byId.get(depId);
    if (dep?.state !== "active") return `dependency "${depId}" failed`;
  }
  for (const scope of manifest.requires ?? []) {
    const hasActiveProvider = [...byId.values()].some(
      (p) => p.state === "active" && p.manifest?.provides?.includes(scope),
    );
    if (!hasActiveProvider) return `required scope "${scope}" has no active provider`;
  }
  return undefined;
}
