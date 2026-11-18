import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { ValetPlugin } from "@valethq/sdk";
import { createCoreBus } from "./bus";
import type { CoreBus } from "./bus/types";
import { type ValetConfig, defaultValetHome, loadConfig, sameConfig } from "./config";
import { validateJsonSchema } from "./jsonschema";
import { type CtxDeps, type PluginRuntime, buildPluginContext } from "./ctx";
import { type HttpRegistry, type WsRegistry, createHttpRegistry, createWsRegistry } from "./hosts";
import { type PluginRecord, discoverPlugins, resolvePlugins, unmetAtActivation } from "./loader";
import { type CoreLogger, createLogger } from "./log";
import { CORE_SCOPE_DEFS, type CoreScopes, createScopeRegistry } from "./scopes";
import {
  layer,
  loadOverlay,
  patchOverlay,
  type SettingSource,
  type SettingsOverlay,
  type SettingsPatch,
  saveOverlay,
  sourcesOf,
  withDefaults,
} from "./settings";
import { type OpenedStore, openStore } from "./store";

const ACTIVATION_TIMEOUT_MS = 15_000;
const DEACTIVATION_TIMEOUT_MS = 5_000;

export interface PluginStatus {
  id: string;
  /** Friendly display name from the manifest (e.g. "Claude Code"); UIs show it instead of the id. */
  name?: string;
  version?: string;
  state: "active" | "failed" | "disabled";
  error?: string;
  order?: number;
  /** Set when a reload changed this plugin's config in a way it can only apply after a restart. */
  restartRequired?: string;
}

/** One plugin's settings as the control plane serves them (12.1). */
export interface PluginSettings {
  plugin: string;
  name?: string;
  description?: string;
  version?: string;
  provides: string[];
  state: PluginStatus["state"] | "pending";
  enabled: boolean;
  /** The manifest's configSchema: the form a UI renders. */
  schema?: Record<string, unknown>;
  /** The effective config: schema defaults, then the config file, then saved settings. */
  values: Record<string, unknown>;
  sources: Record<string, SettingSource>;
  restartRequired?: string;
}

export class SettingsError extends Error {
  constructor(
    readonly status: 400 | 404 | 422,
    message: string,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

export interface ReloadResult {
  ok: boolean;
  /** Plugins whose config block changed and was applied live. */
  changed: string[];
  /** Changes that only take effect after a restart; "core" covers server host/port, pluginPaths, scopes and enabled flags. */
  restartRequired: { plugin: string; reason: string }[];
  /** Why the reload was rejected (nothing is applied when this is non-empty). */
  errors: string[];
}

export interface BootOptions {
  valetHome?: string;
  /** Defaults to <valetHome>/valet.sqlite; ":memory:" for tests. */
  dbPath?: string;
  /** Defaults to 15000 (5.2 step 5). */
  activationTimeoutMs?: number;
  /** Defaults to 5000 (5.2 step 7). */
  deactivationTimeoutMs?: number;
  /** Stdout sink for the JSONL logger (tests). */
  out?: (line: string) => void;
  /** Runs after the bus is created and before plugins load (tests). */
  tapBus?: (bus: CoreBus) => void;
}

export interface ValetKernel {
  readonly valetHome: string;
  readonly configPath: string;
  readonly config: ValetConfig;
  readonly bus: CoreBus;
  readonly store: OpenedStore;
  readonly scopes: CoreScopes;
  readonly http: HttpRegistry;
  readonly ws: WsRegistry;
  readonly log: CoreLogger;
  /** Each plugin's state, error and load order (5.2: GET /api/core/plugins). */
  plugins(): PluginStatus[];
  /** spec-gap: re-reads the config file, validates it, and applies what can change live; rejects the whole reload on any error. */
  reload(): Promise<ReloadResult>;
  /** Every discovered plugin's settings (12.1). */
  settings(): PluginSettings[];
  /**
   * Saves a plugin's settings to settings.json and applies them live. Rejects (nothing saved) when the result
   * fails the configSchema or the plugin's onConfigChange listener throws.
   */
  updateSettings(plugin: string, patch: SettingsPatch): Promise<PluginSettings>;
  shutdown(): Promise<void>;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

async function importPlugin(rec: PluginRecord): Promise<ValetPlugin> {
  const main = rec.manifest?.main ?? "";
  const mod = (await import(resolve(rec.dir, main))) as Record<string, unknown>;
  // spec-gap: the doc never names the export; accept a default export or a named "plugin".
  const plugin = (mod.default ?? mod.plugin) as ValetPlugin | undefined;
  if (!plugin || typeof plugin.activate !== "function") {
    throw new Error(`entry "${main}" does not export a plugin (definePlugin result)`);
  }
  return plugin;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Boots the kernel: config, store, plugin discovery/activation, then core.ready (5.2). */
export async function boot(opts: BootOptions = {}): Promise<ValetKernel> {
  const valetHome = opts.valetHome ?? defaultValetHome();
  mkdirSync(valetHome, { recursive: true });
  const { configPath, config: bootFile } = loadConfig(valetHome);
  let fileConfig = bootFile;
  let overlay: SettingsOverlay = loadOverlay(valetHome);
  let config = layer(fileConfig, overlay);
  const log = createLogger({ valetHome, out: opts.out });
  const coreLog = log.forPlugin("core");

  const bus = createCoreBus({
    logger: coreLog,
    onHookError(report) {
      try {
        bus.signalAs({ plugin: "core" }, "core.hook.error", report);
      } catch (error) {
        coreLog.error("core.hook.error signal failed", { error: errorMessage(error) });
      }
    },
  });
  opts.tapBus?.(bus);

  const store = await openStore({ valetHome, dbPath: opts.dbPath, bus, logger: coreLog });
  try {
    // 7.4: find the leftovers of an unclean stop before plugins activate.
    const interrupted = store.findInterruptedRuns();

    const scopes = createScopeRegistry({ logger: coreLog, winners: config.scopes });
    for (const def of CORE_SCOPE_DEFS) scopes.define(def);
    const http = createHttpRegistry(config.server);
    const ws = createWsRegistry();
    const ctxDeps: CtxDeps = { valetHome, bus, store, scopes, http, ws, log };

    const records = discoverPlugins(config, coreLog);
    const byId = new Map(records.map((r) => [r.id, r]));
    const loadOrder = resolvePlugins(records, config, coreLog);

    const pendingRestart = new Map<string, string>();
    /** A plugin's config block with its schema's defaults filled in. */
    const blockOf = (c: ValetConfig, id: string): Record<string, unknown> =>
      withDefaults(byId.get(id)?.manifest?.configSchema, c.plugins[id]?.config ?? {});

    // 5.2 step 5: activate sequentially in load order.
    const activationTimeoutMs = opts.activationTimeoutMs ?? ACTIVATION_TIMEOUT_MS;
    const activated: { rec: PluginRecord; plugin: ValetPlugin; runtime: PluginRuntime }[] = [];
    for (const rec of loadOrder) {
      const unmet = unmetAtActivation(rec, byId);
      if (unmet !== undefined) {
        rec.state = "failed";
        rec.error = unmet;
        coreLog.warn(`plugin "${rec.id}" skipped: ${unmet}`);
        continue;
      }
      let runtime: PluginRuntime | undefined;
      try {
        const plugin = await importPlugin(rec);
        const manifest = rec.manifest;
        if (!manifest) throw new Error("manifest missing at activation");
        runtime = buildPluginContext(
          ctxDeps,
          { id: rec.id, version: manifest.version, dir: rec.dir, manifest },
          blockOf(config, rec.id),
        );
        const ctx = runtime.ctx;
        await withTimeout(
          Promise.resolve().then(() => plugin.activate(ctx)),
          activationTimeoutMs,
          `plugin "${rec.id}" activation`,
        );
        rec.state = "active";
        activated.push({ rec, plugin, runtime });
        coreLog.info(`plugin "${rec.id}" active`, { plugin: rec.id, order: rec.order });
      } catch (error) {
        rec.state = "failed";
        rec.error = errorMessage(error);
        coreLog.error(`plugin "${rec.id}" failed to activate: ${rec.error}`, { plugin: rec.id });
        // 5.2 step 5: dispose anything it registered; hard dependents fail next.
        await runtime?.dispose();
      }
    }

    // 5.2 step 6: core.ready once every plugin has settled, then run.interrupted.
    await bus.emitAs({ plugin: "core" }, "core.ready", {});
    for (const run of interrupted) {
      await bus.emitAs({ plugin: "core" }, "run.interrupted", { run });
    }

    const doReload = async (): Promise<ReloadResult> => {
      const rejected = (errors: string[]): ReloadResult => ({
        ok: false,
        changed: [],
        restartRequired: [],
        errors,
      });
      let next: ValetConfig;
      let nextFile: ValetConfig;
      let nextOverlay: SettingsOverlay;
      try {
        nextFile = loadConfig(valetHome).config;
        nextOverlay = loadOverlay(valetHome);
        next = layer(nextFile, nextOverlay);
      } catch (error) {
        return rejected([errorMessage(error)]);
      }
      const errors = activated.flatMap(({ rec }) => {
        const schema = rec.manifest?.configSchema;
        if (schema === undefined) return [];
        return validateJsonSchema(blockOf(next, rec.id), schema).map((e) => `plugin "${rec.id}": ${e}`);
      });
      if (errors.length > 0) return rejected(errors);

      const old = config;
      const restartRequired: ReloadResult["restartRequired"] = [];
      const coreChanges = [
        !sameConfig(old.server.host, next.server.host) || old.server.port !== next.server.port
          ? "server host/port"
          : "",
        !sameConfig(old.pluginPaths, next.pluginPaths) ? "pluginPaths" : "",
        !sameConfig(old.scopes, next.scopes) ? "scopes" : "",
        ...Object.keys({ ...old.plugins, ...next.plugins })
          .filter((id) => (old.plugins[id]?.enabled ?? true) !== (next.plugins[id]?.enabled ?? true))
          .map((id) => `plugins.${id}.enabled`),
      ].filter((c) => c !== "");
      for (const reason of coreChanges) restartRequired.push({ plugin: "core", reason });

      config = {
        ...old,
        server: { ...old.server, allowedOrigins: next.server.allowedOrigins },
        plugins: next.plugins,
      };
      fileConfig = nextFile;
      overlay = nextOverlay;

      const changed: string[] = [];
      for (const { rec, runtime } of activated) {
        const prev = blockOf(old, rec.id);
        const block = blockOf(next, rec.id);
        if (sameConfig(prev, block)) continue;
        try {
          if (await runtime.applyConfig(block)) {
            changed.push(rec.id);
            pendingRestart.delete(rec.id);
            coreLog.info(`plugin "${rec.id}" config reloaded`, { plugin: rec.id });
          } else {
            pendingRestart.set(rec.id, "plugin does not support live config changes");
          }
        } catch (error) {
          pendingRestart.set(rec.id, errorMessage(error));
        }
        const reason = pendingRestart.get(rec.id);
        if (reason !== undefined && !changed.includes(rec.id)) {
          restartRequired.push({ plugin: rec.id, reason });
          coreLog.warn(`plugin "${rec.id}" config change needs a restart: ${reason}`, { plugin: rec.id });
        }
      }
      if (changed.length > 0 || restartRequired.length > 0) {
        bus.signalAs({ plugin: "core" }, "core.config.changed", {
          changed,
          restartRequired: restartRequired.map((r) => r.plugin),
        });
      }
      return { ok: true, changed, restartRequired, errors: [] };
    };

    const settingsOf = (rec: PluginRecord): PluginSettings => {
      const m = rec.manifest;
      const schema = m?.configSchema;
      const enabled = config.plugins[rec.id]?.enabled ?? true;
      return {
        plugin: rec.id,
        ...(m?.name === undefined ? {} : { name: m.name }),
        ...(m?.description === undefined ? {} : { description: m.description }),
        ...(m?.version === undefined ? {} : { version: m.version }),
        provides: m?.provides ?? [],
        state: rec.state,
        enabled,
        ...(schema === undefined ? {} : { schema }),
        values: blockOf(config, rec.id),
        sources: sourcesOf(schema, fileConfig.plugins[rec.id]?.config, overlay.plugins[rec.id]?.config),
        ...(pendingRestart.has(rec.id) ? { restartRequired: pendingRestart.get(rec.id) as string } : {}),
      };
    };

    const doUpdate = async (id: string, patch: SettingsPatch): Promise<PluginSettings> => {
      const rec = byId.get(id);
      if (rec === undefined || rec.manifest === undefined)
        throw new SettingsError(404, `unknown plugin "${id}"`);
      const nextOverlay = patchOverlay(overlay, id, patch, fileConfig.plugins[id]?.enabled);
      const next = layer(fileConfig, nextOverlay);
      const block = blockOf(next, id);
      const schema = rec.manifest.configSchema;
      if (schema !== undefined) {
        const errors = validateJsonSchema(block, schema);
        if (errors.length > 0) throw new SettingsError(400, errors.join("; "));
      } else if (Object.keys(block).length > 0) {
        throw new SettingsError(400, `plugin "${id}" has no configSchema, so it takes no settings`);
      }
      const live = activated.find((a) => a.rec.id === id);
      const changed = !sameConfig(blockOf(config, id), block);
      let applied = false;
      if (live !== undefined && changed) {
        try {
          applied = await live.runtime.applyConfig(block);
        } catch (error) {
          throw new SettingsError(422, errorMessage(error));
        }
      }
      saveOverlay(valetHome, nextOverlay);
      overlay = nextOverlay;
      config = { ...config, plugins: next.plugins };
      const running = rec.state !== "disabled";
      const toggle = /^(enabled|disabled);/;
      if ((next.plugins[id]?.enabled ?? true) !== running) {
        pendingRestart.set(id, running ? "disabled; stops on restart" : "enabled; loads on restart");
      } else if (changed && !applied) {
        pendingRestart.set(
          id,
          live === undefined
            ? "loads with these settings on restart"
            : "plugin does not support live config changes",
        );
      } else if (applied || toggle.test(pendingRestart.get(id) ?? "")) {
        pendingRestart.delete(id);
      }
      if (changed || patch.enabled !== undefined) {
        coreLog.info(`plugin "${id}" settings saved`, { plugin: id, applied });
        bus.signalAs({ plugin: "core" }, "core.config.changed", {
          changed: applied ? [id] : [],
          restartRequired: pendingRestart.has(id) ? [id] : [],
        });
      }
      return settingsOf(rec);
    };

    let reloading: Promise<unknown> = Promise.resolve();
    let closing = false;
    const kernel: ValetKernel = {
      valetHome,
      configPath,
      get config() {
        return config;
      },
      reload() {
        const run = reloading.then(doReload);
        reloading = run.catch(() => undefined);
        return run;
      },
      settings() {
        return records.filter((r) => r.manifest !== undefined).map(settingsOf);
      },
      updateSettings(id, patch) {
        const run = reloading.then(() => doUpdate(id, patch));
        reloading = run.catch(() => undefined);
        return run;
      },
      bus,
      store,
      scopes,
      http,
      ws,
      log,
      plugins() {
        return records
          .filter((r) => r.state !== "pending")
          .map((r): PluginStatus => {
            return {
              id: r.id,
              ...(r.manifest?.name === undefined ? {} : { name: r.manifest.name }),
              ...(r.manifest?.version === undefined ? {} : { version: r.manifest.version }),
              state: r.state as PluginStatus["state"],
              ...(r.error === undefined ? {} : { error: r.error }),
              ...(r.order === undefined ? {} : { order: r.order }),
              ...(pendingRestart.has(r.id) ? { restartRequired: pendingRestart.get(r.id) as string } : {}),
            };
          })
          .sort(
            (a, b) =>
              (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
              a.id.localeCompare(b.id),
          );
      },
      async shutdown() {
        if (closing) return;
        closing = true;
        // 5.2 step 7: core.shutdown, then deactivate in reverse order (5s each),
        // aborting each ctx.signal. Then checkpoint SQLite.
        await bus.emitAs({ plugin: "core" }, "core.shutdown", {}).catch((error: unknown) => {
          coreLog.error("core.shutdown emit failed", { error: errorMessage(error) });
        });
        const deactivationTimeoutMs = opts.deactivationTimeoutMs ?? DEACTIVATION_TIMEOUT_MS;
        for (const { rec, plugin, runtime } of activated.slice().reverse()) {
          try {
            await withTimeout(
              Promise.resolve().then(() => plugin.deactivate?.()),
              deactivationTimeoutMs,
              `plugin "${rec.id}" deactivation`,
            );
          } catch (error) {
            coreLog.error(`plugin "${rec.id}" deactivation failed: ${errorMessage(error)}`, {
              plugin: rec.id,
            });
          }
          runtime.abort.abort();
          await runtime.dispose();
        }
        try {
          store.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch (error) {
          coreLog.warn("sqlite checkpoint failed", { error: errorMessage(error) });
        }
        store.close();
      },
    };
    return kernel;
  } catch (error) {
    store.close();
    throw error;
  }
}
