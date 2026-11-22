import type { AclHost } from "./acl";
import type { ControlPlane } from "./control";
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
  /** The applied user block (12.1 layers 1-3), refs resolved; `cmd:` values come from the cache. */
  readonly config: Config;
  /** A project's view: its project layer over the applied user block. `ctx.config` for an unknown project or one without overrides. */
  configFor(projectId: string): Config;
  /**
   * Pre-save veto: runs before a save (user or project) is written, with the validated next and current blocks.
   * Throw to reject the save (422 for a user save, 400 for a project save); nothing is written.
   */
  onConfigCheck(fn: (next: Config, prev: Config) => void | Promise<void>): void;
  /**
   * Runs after a user save, reload or ref re-resolve changed this plugin's desired block. `ctx.config` switches to
   * `next` only once every listener has returned. A throw keeps the previous applied block and reports the error as
   * restart-required; it never rejects the save. A plugin without a listener is reported as restart-required.
   */
  onConfigChange(fn: (next: Config, prev: Config) => void | Promise<void>): void;
  readonly log: Logger;
  readonly events: PluginEventBus;
  readonly scopes: ScopeRegistry;
  readonly store: Store;
  readonly storage: PluginStorage;
  readonly http: HttpHost;
  readonly ws: WsHost;
  /** Transport entry: core identifies, authorizes and serves; the caller decides nothing. */
  readonly control: ControlPlane;
  /** Declared permissions and credential state, for `can`. */
  readonly acl: AclHost;
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
