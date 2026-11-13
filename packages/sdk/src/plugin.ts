import type { PluginEventBus } from "./events";
import type { HttpHost } from "./http";
import type { PluginManifest } from "./manifest";
import type { ScopeRegistry } from "./scopes";
import type { PluginStorage, Store } from "./store";
import type { WsHost } from "./ws";

export interface ValetPlugin<Config = unknown> {
  activate(ctx: PluginContext<Config>): void | Promise<void>;
  deactivate?(): void | Promise<void>;
}
export function definePlugin<Config = unknown>(plugin: ValetPlugin<Config>): ValetPlugin<Config> {
  return plugin;
}

export interface PluginContext<Config = unknown> {
  readonly plugin: {
    readonly id: string;
    readonly version: string;
    readonly dir: string;
    readonly manifest: PluginManifest;
  };
  readonly config: Config;
  readonly log: Logger;
  readonly events: PluginEventBus;
  readonly scopes: ScopeRegistry;
  readonly store: Store;
  readonly storage: PluginStorage;
  readonly http: HttpHost;
  readonly ws: WsHost;
  readonly secrets: Secrets;
  readonly paths: { readonly data: string; readonly cache: string; readonly valetHome: string };
  /** Aborted when this plugin deactivates or core shuts down. */
  readonly signal: AbortSignal;
  /** Runs on deactivate, in reverse registration order. Hooks, scopes, routes and WS handlers are disposed automatically. */
  onDispose(fn: () => void | Promise<void>): void;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface Secrets {
  /** Resolves ~/.valet/secrets/<name> (file, mode 0600) and then the environment variable <NAME>. */
  get(name: string): Promise<string | undefined>;
  require(name: string): Promise<string>;
}

export interface Disposable {
  dispose(): void;
}
