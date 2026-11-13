import {
  type Caller,
  type Disposable,
  type Logger,
  ScopeMissingError,
  type ScopeDefinition,
  type ScopeImpl,
  type ScopeName,
  type ScopeProvider,
  type ScopeRegistry,
  ServiceDeniedError,
  type ValetScopes,
} from "@valethq/sdk";
import { scopeKey } from "./manifest";

interface ProviderRecord {
  /** Provider key (opts.key, default the plugin id). */
  readonly key: string;
  readonly plugin: string;
  readonly name: string;
  readonly implOrFactory: ScopeImpl<ScopeName>;
  /** Bound impls, one per consuming plugin (a factory is called once per consumer). */
  readonly bound: Map<string, ValetScopes[ScopeName]>;
}

export interface CoreScopes {
  define(def: ScopeDefinition): void;
  /** The ScopeRegistry one plugin sees; `provides` is the manifest's provides list. */
  forPlugin(pluginId: string, provides: readonly string[]): ScopedScopeRegistry;
  /** Providers of "name@major", in load order. For the control plane and tests. */
  providers(scope: string): readonly { key: string; plugin: string }[];
  /** Providers of a scope name ("identity") with impls bound to `caller` — e.g. the control plane asking identity@1 (10.2). */
  providersFor<K extends ScopeName>(scope: K, caller: Caller): ScopeProvider<K>[];
}

export interface ScopedScopeRegistry extends ScopeRegistry {
  disposeAll(): void;
}

function stampDenied(error: unknown, plugin: string): void {
  if (error instanceof ServiceDeniedError && error.by === undefined) {
    (error as { by: string }).by = plugin;
  }
}

/** Sets `by` to the provider's id on any ServiceDeniedError the impl throws (6). */
function wrapDenied<T>(impl: T, plugin: string): T {
  if (impl === null || (typeof impl !== "object" && typeof impl !== "function")) return impl;
  return new Proxy(impl as object, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        try {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          if (out instanceof Promise) {
            return out.catch((error: unknown) => {
              stampDenied(error, plugin);
              throw error;
            });
          }
          return out;
        } catch (error) {
          stampDenied(error, plugin);
          throw error;
        }
      };
    },
  }) as T;
}

export function createScopeRegistry(opts: {
  logger: Logger;
  /** Cardinality-"one" winners from config.scopes, keyed by scope name or "name@major". */
  winners?: Record<string, string>;
}): CoreScopes {
  const defs = new Map<string, ScopeDefinition>();
  const byScope = new Map<string, ProviderRecord[]>(); // key: "name@major"
  const watchers = new Map<
    string,
    Set<{ plugin: string; fn: (providers: ScopeProvider<ScopeName>[]) => void }>
  >();

  const listOf = (skey: string): ProviderRecord[] => byScope.get(skey) ?? [];

  const publicList = (name: string, consumer: string): ScopeProvider<ScopeName>[] => {
    const def = defs.get(name);
    if (!def) return [];
    return listOf(scopeKey(name, def.version)).map((rec) => ({
      key: rec.key,
      plugin: rec.plugin,
      impl: bind(rec, consumer),
    }));
  };

  const notify = (name: string): void => {
    for (const watcher of watchers.get(name) ?? []) {
      try {
        watcher.fn(publicList(name, watcher.plugin));
      } catch (error) {
        opts.logger.error(`scope watcher on "${name}" failed`, { plugin: watcher.plugin, error });
      }
    }
  };

  function bind(rec: ProviderRecord, consumer: string): ValetScopes[ScopeName] {
    const cached = rec.bound.get(consumer);
    if (cached !== undefined) return cached;
    const caller: Caller = { plugin: consumer };
    let impl: ValetScopes[ScopeName];
    try {
      impl =
        typeof rec.implOrFactory === "function"
          ? rec.implOrFactory(caller)
          : (rec.implOrFactory as ValetScopes[ScopeName]);
    } catch (error) {
      stampDenied(error, rec.plugin);
      throw error;
    }
    const bound = wrapDenied(impl, rec.plugin);
    rec.bound.set(consumer, bound);
    return bound;
  }

  const registry: CoreScopes = {
    define(def) {
      // spec-gap: one definition per scope name; redefining replaces.
      defs.set(def.name, def);
    },

    forPlugin(pluginId, provides) {
      const allowed = new Set(provides);
      const tracked = new Set<Disposable>();

      const view: ScopedScopeRegistry = {
        define: (def) => registry.define(def),

        provide<K extends ScopeName>(scope: K, impl: ScopeImpl<K>, opts2?: { key?: string }): Disposable {
          const def = defs.get(scope);
          if (!def) throw new Error(`unknown scope "${scope}" (define it first)`);
          const skey = scopeKey(scope, def.version);
          if (!allowed.has(skey)) {
            throw new Error(`plugin "${pluginId}" provides scope "${skey}" not listed in its manifest`);
          }
          const winner = opts.winners?.[skey] ?? opts.winners?.[scope];
          if (winner !== undefined && winner !== pluginId) {
            throw new Error(`scope "${skey}" is bound to plugin "${winner}" by config`);
          }
          const list = byScope.get(skey) ?? [];
          if (def.cardinality === "one" && list.length > 0) {
            throw new Error(`scope "${skey}" (cardinality one) is already provided by "${list[0]?.plugin}"`);
          }
          const key = opts2?.key ?? pluginId;
          if (list.some((p) => p.key === key)) {
            throw new Error(`scope "${skey}" already has a provider with key "${key}"`);
          }
          const rec: ProviderRecord = {
            key,
            plugin: pluginId,
            name: scope,
            implOrFactory: impl as ScopeImpl<ScopeName>,
            bound: new Map(),
          };
          list.push(rec);
          byScope.set(skey, list);
          notify(scope);
          const disposable: Disposable = {
            dispose() {
              const current = byScope.get(skey);
              if (!current) return;
              const next = current.filter((p) => p !== rec);
              if (next.length === 0) byScope.delete(skey);
              else byScope.set(skey, next);
              notify(scope);
            },
          };
          tracked.add(disposable);
          return disposable;
        },

        get<K extends ScopeName>(scope: K, key?: string): ValetScopes[K] {
          const found = this.maybe(scope, key);
          if (found === undefined) throw new ScopeMissingError(scope, key);
          return found;
        },

        maybe<K extends ScopeName>(scope: K, key?: string): ValetScopes[K] | undefined {
          const def = defs.get(scope);
          if (!def) return undefined;
          const list = listOf(scopeKey(scope, def.version));
          // spec-gap: "many" with no key returns the first provider in load order.
          const rec = key === undefined ? list[0] : list.find((p) => p.key === key);
          return rec === undefined ? undefined : (bind(rec, pluginId) as ValetScopes[K]);
        },

        all<K extends ScopeName>(scope: K): ScopeProvider<K>[] {
          return publicList(scope, pluginId) as ScopeProvider<K>[];
        },

        watch<K extends ScopeName>(scope: K, fn: (providers: ScopeProvider<K>[]) => void): Disposable {
          // spec-gap: fires immediately with the current providers, then on provide/dispose.
          const watcher = { plugin: pluginId, fn: fn as (p: ScopeProvider<ScopeName>[]) => void };
          const set = watchers.get(scope) ?? new Set();
          set.add(watcher);
          watchers.set(scope, set);
          const disposable: Disposable = {
            dispose() {
              watchers.get(scope)?.delete(watcher);
            },
          };
          tracked.add(disposable);
          fn(publicList(scope, pluginId) as ScopeProvider<K>[]);
          return disposable;
        },

        disposeAll() {
          for (const disposable of tracked) disposable.dispose();
          tracked.clear();
        },
      };
      return view;
    },

    providers(scope) {
      const skey = defs.has(scope) ? scopeKey(scope, defs.get(scope)?.version ?? 0) : scope;
      return listOf(skey).map((rec) => ({ key: rec.key, plugin: rec.plugin }));
    },

    providersFor<K extends ScopeName>(scope: K, caller: Caller): ScopeProvider<K>[] {
      return publicList(scope, caller.plugin) as ScopeProvider<K>[];
    },
  };
  return registry;
}

/** Core scope definitions (3): core fixes the interfaces, never the impls. */
export const CORE_SCOPE_DEFS: ScopeDefinition[] = [
  { name: "inference", version: 1, cardinality: "many" },
  { name: "tools", version: 1, cardinality: "many" },
  { name: "platform", version: 1, cardinality: "many" },
  // spec-gap: cardinality for identity is unstated; 10.2 asks providers in load order, so "many".
  { name: "identity", version: 1, cardinality: "many" },
];
