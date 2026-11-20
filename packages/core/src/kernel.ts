import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PluginSettings, ValetPlugin } from "@valethq/sdk";
import { createCoreBus } from "./bus";
import type { CoreBus } from "./bus/types";
import { type ValetConfig, defaultValetHome, loadConfig, sameConfig } from "./config";
import { type CtxDeps, type PluginRuntime, buildPluginContext } from "./ctx";
import { type HttpRegistry, type WsRegistry, createHttpRegistry, createWsRegistry } from "./hosts";
import { type PluginRecord, discoverPlugins, resolvePlugins, unmetAtActivation } from "./loader";
import { type CoreLogger, createLogger } from "./log";
import { CORE_SCOPE_DEFS, type CoreScopes, createScopeRegistry } from "./scopes";
import { loadOverlay, type SettingsOverlay, type SettingsPatch, withEnabled } from "./settings/overlay";
import { SettingsError, SettingsService } from "./settings/service";
import { type OpenedStore, openStore } from "./store";

export type { PluginSettings };
export { SettingsError };

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
  /** Watch settings and ref files for changes (default true). */
  watchSettings?: boolean;
  /** `cmd:` ref timeout (default 10000). */
  cmdTimeoutMs?: number;
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
  /** Every discovered plugin's settings (12.1); `project` adds that project's layer. */
  settings(project?: string): PluginSettings[];
  /**
   * Saves one layer (user by default, or a project's) and applies it. Rejects with SettingsError, writing nothing,
   * when the touched keys fail validation (400), a project override would break (400), or onConfigCheck vetoes
   * (422). A throwing onConfigChange keeps the save and reports restartRequired.
   */
  updateSettings(plugin: string, patch: SettingsPatch): Promise<PluginSettings>;
  /** The settings service (tests: cmd cache, queue). */
  readonly settingsService: SettingsService;
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

interface ActivatedPlugin {
  rec: PluginRecord;
  plugin: ValetPlugin;
  runtime: PluginRuntime;
}

/** Boots the kernel: config, store, plugin discovery/activation, then core.ready (5.2). */
export async function boot(opts: BootOptions = {}): Promise<ValetKernel> {
  const valetHome = opts.valetHome ?? defaultValetHome();
  mkdirSync(valetHome, { recursive: true });
  const { configPath, config: bootFile } = loadConfig(valetHome);
  let fileConfig = bootFile;
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
  const activated: ActivatedPlugin[] = [];
  const deactivationTimeoutMs = opts.deactivationTimeoutMs ?? DEACTIVATION_TIMEOUT_MS;
  const deactivateAll = async (list: readonly ActivatedPlugin[]): Promise<void> => {
    for (const { rec, plugin, runtime } of list.slice().reverse()) {
      // 5.3: abort first so deactivate can observe ctx.signal, then dispose.
      runtime.abort.abort();
      const stopping = Promise.resolve().then(() => plugin.deactivate?.());
      void stopping.catch(() => {});
      try {
        await withTimeout(stopping, deactivationTimeoutMs, `plugin "${rec.id}" deactivation`);
      } catch (error) {
        coreLog.error(`plugin "${rec.id}" deactivation failed: ${errorMessage(error)}`, {
          plugin: rec.id,
        });
      }
      await runtime.dispose();
    }
  };
  let doReload: () => Promise<ReloadResult> = async () => ({
    ok: true,
    changed: [],
    restartRequired: [],
    errors: [],
  });
  const service = new SettingsService(
    {
      home: valetHome,
      configPath,
      log: coreLog,
      kv: {
        get: (plugin, key) => store.pluginStorage(plugin).kv.get(key),
        delete: (plugin, key) => store.pluginStorage(plugin).kv.delete(key),
      },
      projectExists: (id) => store.forPlugin("core").projects.get(id) !== undefined,
      onLayerFileChange: () => doReload(),
      onChanged: (changed, restartRequired) =>
        bus.signalAs({ plugin: "core" }, "core.config.changed", { changed, restartRequired }),
      ...(opts.watchSettings === undefined ? {} : { watch: opts.watchSettings }),
      ...(opts.cmdTimeoutMs === undefined ? {} : { cmdTimeoutMs: opts.cmdTimeoutMs }),
    },
    fileConfig,
  );
  let config = withEnabled(fileConfig, service.userOverlay);
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
    const loadOrder = resolvePlugins(records, config, coreLog, (rec) => service.prepare(rec));
    for (const rec of records) if (rec.state === "disabled") service.prepare(rec);
    service.finishBoot();
    bus.forPlugin("core").after("project.delete", (e) => {
      service.forgetProject((e.payload as { project: { id: string } }).project.id);
    });

    // 5.2 step 5: activate sequentially in load order.
    const activationTimeoutMs = opts.activationTimeoutMs ?? ACTIVATION_TIMEOUT_MS;
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
        const importing = importPlugin(rec);
        void importing.catch(() => {});
        const plugin = await withTimeout(importing, activationTimeoutMs, `plugin "${rec.id}" import`);
        const manifest = rec.manifest;
        if (!manifest) throw new Error("manifest missing at activation");
        const id = rec.id;
        runtime = buildPluginContext(
          ctxDeps,
          { id, version: manifest.version, dir: rec.dir, manifest },
          { read: () => service.read(id), readFor: (pid) => service.readFor(id, pid) },
        );
        const ctx = runtime.ctx;
        service.attach(id, runtime.hooks);
        const activating = Promise.resolve().then(() => plugin.activate(ctx));
        void activating.catch(() => {});
        await withTimeout(activating, activationTimeoutMs, `plugin "${rec.id}" activation`);
        rec.state = "active";
        activated.push({ rec, plugin, runtime });
        coreLog.info(`plugin "${rec.id}" active`, { plugin: rec.id, order: rec.order });
      } catch (error) {
        rec.state = "failed";
        rec.error = errorMessage(error);
        service.detach(rec.id);
        coreLog.error(`plugin "${rec.id}" failed to activate: ${rec.error}`, { plugin: rec.id });
        // 5.2 step 5: abort, then dispose, so a late activate cannot register hooks.
        if (runtime !== undefined) {
          runtime.abort.abort();
          await runtime.dispose();
        }
      }
    }

    // 5.2 step 6: core.ready once every plugin has settled, then run.interrupted.
    await bus.emitAs({ plugin: "core" }, "core.ready", {});
    for (const run of interrupted) {
      await bus.emitAs({ plugin: "core" }, "run.interrupted", { run });
    }

    doReload = async (): Promise<ReloadResult> => {
      let nextFile: ValetConfig;
      let nextOverlay: SettingsOverlay;
      try {
        nextFile = loadConfig(valetHome).config;
        nextOverlay = loadOverlay(valetHome);
      } catch (error) {
        return { ok: false, changed: [], restartRequired: [], errors: [errorMessage(error)] };
      }
      const next = withEnabled(nextFile, nextOverlay);
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
      const outcome = await service.reloadPlugins(nextFile, nextOverlay);
      restartRequired.push(...outcome.restartRequired);
      for (const r of outcome.restartRequired)
        coreLog.warn(`plugin "${r.plugin}" config change needs a restart: ${r.reason}`, { plugin: r.plugin });
      for (const id of outcome.changed) coreLog.info(`plugin "${id}" config reloaded`, { plugin: id });
      if (outcome.changed.length > 0 || restartRequired.length > 0) {
        bus.signalAs({ plugin: "core" }, "core.config.changed", {
          changed: outcome.changed,
          restartRequired: restartRequired.map((r) => r.plugin),
        });
      }
      return {
        ok: outcome.errors.length === 0,
        changed: outcome.changed,
        restartRequired,
        errors: outcome.errors,
      };
    };

    const enabledOf = (id: string) => config.plugins[id]?.enabled ?? true;

    const doUpdate = async (id: string, patch: SettingsPatch): Promise<PluginSettings> => {
      const rec = byId.get(id);
      if (rec === undefined || rec.manifest === undefined)
        throw new SettingsError(404, `unknown plugin "${id}"`);
      const before = service.restartOf(id);
      await service.update(id, patch);
      config = withEnabled(fileConfig, service.userOverlay);
      if (patch.scope !== "project") {
        const running = rec.state !== "disabled";
        const reason = service.restartOf(id);
        if (enabledOf(id) !== running) {
          service.setRestart(id, running ? "disabled; stops on restart" : "enabled; loads on restart");
        } else if (/^(enabled|disabled);/.test(reason ?? "")) {
          service.setRestart(id, undefined);
        }
        const after = service.restartOf(id);
        if (patch.config !== undefined || patch.enabled !== undefined) {
          const applied = patch.config !== undefined && after === undefined && rec.state === "active";
          coreLog.info(`plugin "${id}" settings saved`, { plugin: id, applied });
          if (applied || after !== undefined || before !== after)
            bus.signalAs({ plugin: "core" }, "core.config.changed", {
              changed: applied ? [id] : [],
              restartRequired: after === undefined ? [] : [id],
            });
        }
      }
      return service.get(
        id,
        enabledOf(id),
        patch.scope === "project" ? patch.project : undefined,
      ) as PluginSettings;
    };

    let closing = false;
    const kernel: ValetKernel = {
      valetHome,
      configPath,
      get config() {
        return config;
      },
      settingsService: service,
      reload() {
        return service.enqueue(() => doReload());
      },
      settings(project) {
        return service.list(enabledOf, project);
      },
      updateSettings(id, patch) {
        return service.enqueue(() => doUpdate(id, patch));
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
            const restart = service.restartOf(r.id);
            return {
              id: r.id,
              ...(r.manifest?.name === undefined ? {} : { name: r.manifest.name }),
              ...(r.manifest?.version === undefined ? {} : { version: r.manifest.version }),
              state: r.state as PluginStatus["state"],
              ...(r.error === undefined ? {} : { error: r.error }),
              ...(r.order === undefined ? {} : { order: r.order }),
              ...(restart === undefined ? {} : { restartRequired: restart }),
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
        service.close();
        // 5.2 step 7: core.shutdown, then deactivate in reverse order (5s each).
        // Abort each ctx.signal before deactivate so the plugin can observe it.
        await bus.emitAs({ plugin: "core" }, "core.shutdown", {}).catch((error: unknown) => {
          coreLog.error("core.shutdown emit failed", { error: errorMessage(error) });
        });
        await deactivateAll(activated);
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
    service.close();
    // core.ready / run.interrupted can reject after plugins are active. Stop them before closing the store.
    try {
      await deactivateAll(activated);
    } catch (cleanupError) {
      coreLog.error("boot cleanup failed", { error: errorMessage(cleanupError) });
    }
    store.close();
    throw error;
  }
}
