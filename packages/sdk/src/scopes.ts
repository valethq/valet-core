import type { ContextManager } from "./context";
import type { Caller } from "./events";
import type { IdentityProvider } from "./identity";
import type { InferenceProvider } from "./inference";
import type { MessagePlatform } from "./platform";
import type { Disposable } from "./plugin";
import type { ToolProvider } from "./tools";

export interface ValetScopes {
  inference: InferenceProvider;
  tools: ToolProvider;
  platform: MessagePlatform;
  identity: IdentityProvider;
  context: ContextManager; // defined and provided by valet-contextmanager
}
export type ScopeName = Extract<keyof ValetScopes, string>;

export interface ScopeDefinition {
  name: string;
  version: number;
  cardinality: "one" | "many";
}
export function defineScope(def: ScopeDefinition): ScopeDefinition {
  return def;
}

export interface ScopeProvider<K extends ScopeName> {
  readonly key: string; // provider key, e.g. "devin-cli"; defaults to the plugin id
  readonly plugin: string;
  readonly impl: ValetScopes[K];
}

export type ScopeImpl<K extends ScopeName> = ValetScopes[K] | ((caller: Caller) => ValetScopes[K]);

export interface ScopeRegistry {
  define(def: ScopeDefinition): void;
  /** A factory is called once per consuming plugin with that plugin's identity, so the provider knows who is calling. */
  provide<K extends ScopeName>(scope: K, impl: ScopeImpl<K>, opts?: { key?: string }): Disposable;
  /** The single provider (cardinality "one") or the provider with this key. Throws ScopeMissingError. */
  get<K extends ScopeName>(scope: K, key?: string): ValetScopes[K];
  maybe<K extends ScopeName>(scope: K, key?: string): ValetScopes[K] | undefined;
  all<K extends ScopeName>(scope: K): ScopeProvider<K>[];
  /** Fires on provide and dispose, so consumers can track providers that arrive later or go away. */
  watch<K extends ScopeName>(scope: K, fn: (providers: ScopeProvider<K>[]) => void): Disposable;
}

export class ServiceDeniedError extends Error {
  readonly by!: string;
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.name = "ServiceDeniedError";
    this.reason = reason;
  }
}

/** spec-gap: referenced by ScopeRegistry.get but never defined in the doc. */
export class ScopeMissingError extends Error {
  constructor(
    readonly scope: string,
    readonly key?: string,
  ) {
    super(`no provider for scope "${scope}"${key === undefined ? "" : ` with key "${key}"`}`);
    this.name = "ScopeMissingError";
  }
}
