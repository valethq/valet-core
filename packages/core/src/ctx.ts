import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { PluginContext, PluginManifest } from "@valethq/sdk";
import type { CoreBus } from "./bus/types";
import type { HttpRegistry, WsRegistry } from "./hosts";
import type { CoreLogger } from "./log";
import { createSecrets } from "./secrets";
import type { CoreScopes } from "./scopes";
import type { ConfigHooks } from "./settings/service";
import type { OpenedStore } from "./store";

export interface PluginRuntime {
  readonly ctx: PluginContext;
  readonly abort: AbortController;
  /** The plugin's onConfigCheck / onConfigChange registrations, for the settings service. */
  readonly hooks: ConfigHooks;
  /** Runs onDispose fns (reverse registration order), then disposes every registered view. */
  dispose(): Promise<void>;
}

/** Where ctx.config and ctx.configFor read from (the settings service). */
export interface ConfigSource {
  read(): Record<string, unknown>;
  readFor(projectId: string): Record<string, unknown>;
}

export interface CtxDeps {
  valetHome: string;
  bus: CoreBus;
  store: OpenedStore;
  scopes: CoreScopes;
  http: HttpRegistry;
  ws: WsRegistry;
  log: CoreLogger;
}

/** 5.3: builds the id-bound PluginContext for one plugin. */
export function buildPluginContext(
  deps: CtxDeps,
  plugin: { id: string; version: string; dir: string; manifest: PluginManifest },
  config: ConfigSource,
): PluginRuntime {
  const namespace = plugin.manifest.events?.namespace ?? plugin.id.replace(/^valet-/, "");
  const log = deps.log.forPlugin(plugin.id);
  const events = deps.bus.forPlugin(plugin.id, namespace);
  const scopes = deps.scopes.forPlugin(plugin.id, plugin.manifest.provides ?? []);
  const http = deps.http.forPlugin(plugin.id);
  const ws = deps.ws.forPlugin(plugin.id, namespace);
  const abort = new AbortController();
  const onDispose: (() => void | Promise<void>)[] = [];
  type ConfigFn = (next: Record<string, unknown>, prev: Record<string, unknown>) => void | Promise<void>;
  const configListeners: ConfigFn[] = [];
  const configChecks: ConfigFn[] = [];

  deps.store.setOrigin({
    id: plugin.id,
    version: plugin.version,
    ...(plugin.manifest.repository ? { repository: plugin.manifest.repository } : {}),
  });
  const data = join(deps.valetHome, "data", plugin.id);
  const cache = join(deps.valetHome, "cache", plugin.id);
  mkdirSync(data, { recursive: true });
  mkdirSync(cache, { recursive: true });

  const ctx: PluginContext = {
    plugin: { id: plugin.id, version: plugin.version, dir: plugin.dir, manifest: plugin.manifest },
    get config() {
      return config.read();
    },
    configFor(projectId) {
      return config.readFor(projectId);
    },
    onConfigCheck(fn) {
      configChecks.push(fn as ConfigFn);
    },
    onConfigChange(fn) {
      configListeners.push(fn as ConfigFn);
    },
    log,
    events,
    scopes,
    store: deps.store.forPlugin(plugin.id),
    storage: deps.store.pluginStorage(plugin.id),
    http,
    ws,
    secrets: createSecrets(deps.valetHome, log),
    paths: { data, cache, valetHome: deps.valetHome },
    signal: abort.signal,
    onDispose(fn) {
      onDispose.push(fn);
    },
  };

  return {
    ctx,
    abort,
    hooks: {
      listeners: () => configListeners.length,
      async runChecks(next, prev) {
        for (const fn of configChecks) await fn(next, prev);
      },
      async runListeners(next, prev) {
        for (const fn of configListeners) await fn(next, prev);
      },
    },
    async dispose() {
      for (const fn of onDispose.reverse()) {
        try {
          await fn();
        } catch (error) {
          log.error("onDispose failed", { error: String(error) });
        }
      }
      events.disposeAll();
      scopes.disposeAll();
      http.disposeAll();
      ws.disposeAll();
    },
  };
}
