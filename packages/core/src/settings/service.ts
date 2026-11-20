import { join } from "node:path";
import type { Logger, PluginSettings, SettingSource } from "@valethq/sdk";
import { sameConfig, type ValetConfig } from "../config";
import type { PluginRecord } from "../loader";
import { DocError, type Node } from "./doc";
import { migrateLayer } from "./migrate";
import {
  buildModel,
  fillPending,
  isReadonly,
  type Model,
  type PathErrors,
  parseValues,
  type ResolveResult,
  resolveBlock,
  scopesOf,
  validateValues,
} from "./model";
import {
  backupOnce,
  loadBackup,
  parseOverlay,
  patchOverlay,
  projectDataDir,
  projectIdsWithSettings,
  projectSettingsPath,
  readText,
  type SettingsOverlay,
  type SettingsPatch,
  settingsPath,
  writeOverlay,
} from "./overlay";
import { hasRef, tokenize } from "./refs";
import { CmdCache, resolveStatic } from "./resolve";
import { DirWatcher } from "./watch";

type Block = Record<string, unknown>;

export class SettingsError extends Error {
  constructor(
    readonly status: 400 | 404 | 422,
    message: string,
    /** Failures keyed by path (or `<projectId>:<path>`). */
    readonly errors?: PathErrors,
  ) {
    super(message);
    this.name = "SettingsError";
  }
}

/** What core needs from a running plugin's context to apply config. */
export interface ConfigHooks {
  listeners(): number;
  runChecks(next: Block, prev: Block): Promise<void>;
  runListeners(next: Block, prev: Block): Promise<void>;
}

export interface SettingsDeps {
  home: string;
  configPath: string;
  log: Logger;
  kv: { get(plugin: string, key: string): unknown; delete(plugin: string, key: string): void };
  projectExists(id: string): boolean;
  /** A watched config file or settings.json changed on disk: the kernel reloads (inside the queue). */
  onLayerFileChange(): Promise<unknown>;
  /** Called after a save or reload changed what plugins run with. */
  onChanged(changed: string[], restartRequired: string[]): void;
  /** Watch files for changes (off in some tests). */
  watch?: boolean;
  cmdTimeoutMs?: number;
}

interface Applied {
  values: Block;
  res: ResolveResult;
}

interface Entry {
  rec: PluginRecord;
  model?: Model;
  /** Stored layers, after migration. */
  file: Block;
  user: Block;
  projects: Map<string, Block>;
  desired: Applied;
  applied: Applied;
  /** Ref failures and warnings on the desired block. */
  issues: PathErrors;
  /** cmd: failures seen on the last read. */
  readIssues: PathErrors;
  projectIssues: Map<string, PathErrors>;
  hooks?: ConfigHooks;
  restart?: string;
  version: number;
  cache?: { gen: number; version: number; block: Block };
  projectCache: Map<string, { gen: number; version: number; block: Block }>;
}

const isRecord = (v: unknown): v is Block => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const firstLine = (errors: PathErrors) =>
  Object.entries(errors)
    .map(([p, m]) => (p ? `${p}: ${m}` : m))
    .join("; ");

const EMPTY: ResolveResult = {
  block: {},
  pending: [],
  issues: {},
  fatal: {},
  resolved: new Map(),
  watches: new Set(),
};

export interface ReloadOutcome {
  changed: string[];
  restartRequired: { plugin: string; reason: string }[];
  errors: string[];
}

/** Settings v3 (12.1): layers, migration, refs, desired/applied blocks, project views and the settings queue. */
export class SettingsService {
  private entries = new Map<string, Entry>();
  private fileConfig: ValetConfig;
  private overlay: SettingsOverlay;
  private projectOverlays = new Map<string, SettingsOverlay>();
  private userDirty = false;
  private projectDirty = new Set<string>();
  private kvMoves: { plugin: string; key: string }[] = [];
  private lastText = new Map<string, string | undefined>();
  private queue: Promise<unknown> = Promise.resolve();
  private gen = 0;
  private warnedFileKeys = new Set<string>();
  readonly cmd: CmdCache;
  private watcher?: DirWatcher;

  constructor(
    private readonly deps: SettingsDeps,
    fileConfig: ValetConfig,
  ) {
    this.fileConfig = fileConfig;
    this.overlay = parseOverlay(settingsPath(deps.home), this.remember(settingsPath(deps.home)));
    this.remember(join(deps.home, "config.toml"));
    this.remember(join(deps.home, "config.json"));
    for (const pid of projectIdsWithSettings(deps.home)) {
      const path = projectSettingsPath(deps.home, pid);
      try {
        this.projectOverlays.set(pid, parseOverlay(path, this.remember(path), false));
      } catch (e) {
        deps.log.warn(`ignoring ${path}: ${message(e)}`);
      }
    }
    this.cmd = new CmdCache(deps.home, (ref) => this.cmdChanged(ref), deps.cmdTimeoutMs);
  }

  /** The user overlay (for enabled flags). */
  get userOverlay(): SettingsOverlay {
    return this.overlay;
  }

  /** Runs `fn` on the settings queue: saves, reloads and watcher events, one at a time. */
  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- boot ----

  /**
   * Compiles a plugin's settings and builds its desired block from the stored layers. Returns why the plugin
   * can't load (bad document, invalid config, failed required ref), or undefined.
   */
  prepare(rec: PluginRecord): string | undefined {
    const manifest = rec.manifest;
    if (manifest === undefined) return undefined;
    let model: Model | undefined;
    let modelError: string | undefined;
    try {
      model = buildModel(manifest);
    } catch (e) {
      modelError = e instanceof DocError ? e.message : `invalid settings document: ${message(e)}`;
    }
    const entry: Entry = {
      rec,
      ...(model ? { model } : {}),
      file: {},
      user: {},
      projects: new Map(),
      desired: { values: {}, res: EMPTY },
      applied: { values: {}, res: EMPTY },
      issues: {},
      readIssues: {},
      projectIssues: new Map(),
      version: 0,
      projectCache: new Map(),
    };
    this.entries.set(rec.id, entry);
    if (model === undefined) return modelError;
    this.loadLayers(entry);
    let errors = this.recompute(entry);
    if (Object.keys(errors).length > 0) {
      const restored = this.restoreFromBackup(entry);
      if (restored) errors = this.recompute(entry);
    }
    entry.applied = entry.desired;
    for (const pid of entry.projects.keys()) this.checkProject(entry, pid);
    if (Object.keys(errors).length > 0) return `invalid plugin config: ${firstLine(errors)}`;
    return undefined;
  }

  /** Writes back migrated layers, moves kv rows, and starts the watchers. */
  finishBoot(): void {
    this.flushMigrations();
    if (this.deps.watch !== false) {
      this.watcher = new DirWatcher((path) => this.fileChanged(path));
      this.watcher.file(settingsPath(this.deps.home));
      this.watcher.file(join(this.deps.home, "config.toml"));
      this.watcher.file(join(this.deps.home, "config.json"));
      this.watcher.tree(projectDataDir(this.deps.home));
      this.watcher.tree(join(this.deps.home, "secrets"));
      this.refreshRefWatches();
    }
  }

  close(): void {
    this.watcher?.close();
  }

  attach(id: string, hooks: ConfigHooks): void {
    const e = this.entries.get(id);
    if (e) e.hooks = hooks;
  }

  detach(id: string): void {
    const e = this.entries.get(id);
    if (e) delete e.hooks;
  }

  // ---- reads ----

  /** ctx.config: the applied block, `cmd:` leaves filled from the cache. */
  read(id: string): Block {
    const e = this.entries.get(id);
    if (e === undefined) return {};
    if (e.cache && e.cache.gen === this.gen && e.cache.version === e.version) return e.cache.block;
    const issues: PathErrors = {};
    const r = e.applied.res;
    const block = fillPending(
      r.block,
      r.pending,
      r.resolved,
      (ref, line, ttl) => this.cmd.read(ref, line, ttl),
      issues,
    );
    e.readIssues = issues;
    e.cache = { gen: this.gen, version: e.version, block };
    return block;
  }

  /** ctx.configFor: the project layer over the applied block; ctx.config when there is no valid override. */
  readFor(id: string, projectId: string): Block {
    const e = this.entries.get(id);
    const layer = e?.projects.get(projectId);
    if (e === undefined || layer === undefined || e.projectIssues.has(projectId)) return this.read(id);
    const hit = e.projectCache.get(projectId);
    if (hit && hit.gen === this.gen && hit.version === e.version) return hit.block;
    const parsed = parseValues(e.model as Model, layer, {});
    const r = e.applied.res;
    const block = fillPending(
      { ...r.block, ...parsed },
      r.pending,
      r.resolved,
      (ref, line, ttl) => this.cmd.read(ref, line, ttl),
      {},
      new Set(Object.keys(parsed)),
    );
    e.projectCache.set(projectId, { gen: this.gen, version: e.version, block });
    return block;
  }

  restartOf(id: string): string | undefined {
    return this.entries.get(id)?.restart;
  }

  setRestart(id: string, reason: string | undefined): void {
    const e = this.entries.get(id);
    if (!e) return;
    if (reason === undefined) delete e.restart;
    else e.restart = reason;
  }

  /** PluginSettings for every plugin with a manifest; `project` adds that project's layer. */
  list(enabledOf: (id: string) => boolean, project?: string): PluginSettings[] {
    return [...this.entries.values()].map((e) => this.describe(e, enabledOf(e.rec.id), project));
  }

  get(id: string, enabled: boolean, project?: string): PluginSettings | undefined {
    const e = this.entries.get(id);
    return e === undefined ? undefined : this.describe(e, enabled, project);
  }

  private describe(e: Entry, enabled: boolean, project?: string): PluginSettings {
    const m = e.rec.manifest;
    const model = e.model;
    const proj = project === undefined ? undefined : e.projects.get(project);
    const projValues = proj && model ? parseValues(model, proj, {}) : undefined;
    const sources: Record<string, SettingSource> = {};
    for (const k of Object.keys(model?.defaults ?? {})) sources[k] = "default";
    for (const k of Object.keys(e.file)) sources[k] = "file";
    for (const k of Object.keys(e.user)) sources[k] = "settings";
    for (const k of Object.keys(projValues ?? {})) sources[k] = "project";
    const issues: PathErrors = { ...e.issues, ...e.readIssues };
    if (project !== undefined) Object.assign(issues, e.projectIssues.get(project));
    return {
      plugin: e.rec.id,
      ...(m?.name === undefined ? {} : { name: m.name }),
      ...(m?.description === undefined ? {} : { description: m.description }),
      ...(m?.version === undefined ? {} : { version: m.version }),
      provides: m?.provides ?? [],
      state: e.rec.state,
      enabled,
      ...(m?.settings === undefined ? {} : { settings: m.settings }),
      ...(model?.types === undefined || Object.keys(model.types).length === 0 ? {} : { types: model.types }),
      ...(model?.schema === undefined ? {} : { schema: model.schema }),
      values: { ...e.desired.values, ...projValues },
      sources,
      layers: {
        ...(Object.keys(e.file).length > 0 ? { file: e.file } : {}),
        ...(Object.keys(e.user).length > 0 ? { user: e.user } : {}),
        ...(proj === undefined ? {} : { project: proj }),
      },
      liveConfig: (e.hooks?.listeners() ?? 0) > 0,
      ...(Object.keys(issues).length > 0 ? { issues: this.scrubAll(e, issues) } : {}),
      ...(e.restart === undefined ? {} : { restartRequired: e.restart }),
    };
  }

  // ---- saves ----

  /** PATCH /api/core/settings/:plugin, already on the queue. */
  async update(id: string, patch: SettingsPatch): Promise<void> {
    const e = this.entries.get(id);
    if (e === undefined || e.rec.manifest === undefined)
      throw new SettingsError(404, `unknown plugin "${id}"`);
    if (patch.scope === "project") return this.updateProject(e, patch);
    const config = patch.config ?? {};
    const keys = Object.keys(config);
    if (keys.length > 0) {
      const model = this.modelOf(e);
      this.checkReadonly(model, config, e.desired.values);
      const nextUser = { ...e.user };
      for (const [k, v] of Object.entries(config)) {
        if (v === null) delete nextUser[k];
        else nextUser[k] = v;
      }
      const values = this.mergeValues(e, e.file, nextUser);
      const errors = validateValues(model, values, keys);
      if (Object.keys(errors).length > 0) throw new SettingsError(400, firstLine(errors), errors);
      const res = resolveBlock(model, values, this.resolver);
      const fatal = Object.fromEntries(
        Object.entries(res.fatal).filter(([p]) => keys.some((k) => under(p, k))),
      );
      if (Object.keys(fatal).length > 0) throw new SettingsError(400, firstLine(fatal), fatal);
      this.checkProjectsFor(e, model, values, keys);
      try {
        await e.hooks?.runChecks(res.block, e.applied.res.block);
      } catch (err) {
        throw new SettingsError(422, this.scrub(e, message(err), res));
      }
      e.user = nextUser;
      e.desired = { values, res };
      e.issues = { ...res.issues };
    }
    if (keys.length > 0 || patch.enabled !== undefined) {
      const fileEnabled = this.fileConfig.plugins[id]?.enabled;
      this.writeUser(
        patchOverlay(
          this.overlay,
          id,
          { config, ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }) },
          fileEnabled,
        ),
      );
      this.dropCmdRefs(Object.values(config));
    }
    if (keys.length > 0) await this.applyDesired(e);
    this.pruneCmd();
    this.refreshRefWatches();
  }

  private async updateProject(e: Entry, patch: SettingsPatch): Promise<void> {
    const pid = patch.project;
    if (typeof pid !== "string" || pid === "") throw new SettingsError(400, "project scope needs a project");
    if (!this.deps.projectExists(pid)) throw new SettingsError(404, `unknown project "${pid}"`);
    if (patch.enabled !== undefined) throw new SettingsError(400, "enabled can't be set per project");
    const model = this.modelOf(e);
    const config = patch.config ?? {};
    const keys = Object.keys(config);
    const errors: PathErrors = {};
    for (const [k, v] of Object.entries(config)) {
      if (!model.doc?.settings.has(k)) errors[k] = "unknown setting";
      else if (!scopesOf(model, k).includes("project")) errors[k] = "this setting can't be set per project";
      else if (v !== null)
        for (const p of refPaths(v, k)) errors[p] = "refs are not allowed in the project layer";
    }
    if (Object.keys(errors).length > 0) throw new SettingsError(400, firstLine(errors), errors);
    const current = e.projects.get(pid) ?? {};
    this.checkReadonly(model, config, { ...e.desired.values, ...current });
    const next = { ...current };
    for (const [k, v] of Object.entries(config)) {
      if (v === null) delete next[k];
      else next[k] = v;
    }
    const bases = [e.desired.values];
    if (!sameConfig(e.desired.values, e.applied.values)) bases.push(e.applied.values);
    for (const base of bases) {
      const parsedErrors: PathErrors = {};
      const parsed = parseValues(model, next, parsedErrors);
      const errs = { ...parsedErrors, ...validateValues(model, { ...base, ...parsed }, keys) };
      if (Object.keys(errs).length > 0) throw new SettingsError(400, firstLine(errs), errs);
    }
    try {
      const parsed = parseValues(model, next, {});
      await e.hooks?.runChecks({ ...e.applied.res.block, ...parsed }, this.readFor(e.rec.id, pid));
    } catch (err) {
      throw new SettingsError(400, this.scrub(e, message(err)));
    }
    const overlay = structuredClone(this.projectOverlays.get(pid) ?? { plugins: {} });
    if (Object.keys(next).length > 0) overlay.plugins[e.rec.id] = { config: next };
    else delete overlay.plugins[e.rec.id];
    this.writeProject(pid, overlay);
    if (Object.keys(next).length > 0) e.projects.set(pid, next);
    else e.projects.delete(pid);
    e.projectIssues.delete(pid);
    e.projectCache.delete(pid);
    this.checkProject(e, pid);
  }

  /** Drops a deleted project's file and overrides. */
  forgetProject(pid: string): void {
    if (!this.projectOverlays.has(pid)) return;
    this.writeProject(pid, { plugins: {} });
    for (const e of this.entries.values()) {
      e.projects.delete(pid);
      e.projectIssues.delete(pid);
      e.projectCache.delete(pid);
    }
  }

  // ---- reloads ----

  /**
   * Re-reads the layers for every plugin. A plugin whose new block is invalid keeps its applied block and reports
   * the error; the rest apply live where they can.
   */
  async reloadPlugins(nextFile: ValetConfig, nextOverlay: SettingsOverlay): Promise<ReloadOutcome> {
    const out: ReloadOutcome = { changed: [], restartRequired: [], errors: [] };
    const oldLayers = [...this.entries.values()].map((e) => ({ ...e.file, ...e.user }));
    this.fileConfig = nextFile;
    this.overlay = nextOverlay;
    for (const p of [
      settingsPath(this.deps.home),
      join(this.deps.home, "config.toml"),
      join(this.deps.home, "config.json"),
    ])
      this.remember(p);
    this.dropCmdRefs(oldLayers);
    for (const e of this.entries.values()) {
      if (e.model === undefined) continue;
      const prev = { file: e.file, user: e.user, desired: e.desired, issues: e.issues };
      this.loadLayers(e);
      this.dropCmdRefs([e.file, e.user]);
      const errors = this.recompute(e);
      if (Object.keys(errors).length > 0) {
        Object.assign(e, prev);
        for (const [p, m] of Object.entries(errors)) out.errors.push(`plugin "${e.rec.id}": ${p}: ${m}`);
        continue;
      }
      for (const pid of e.projects.keys()) this.checkProject(e, pid);
      if (e.rec.state !== "active") continue;
      const applied = await this.applyDesired(e);
      if (applied === true) out.changed.push(e.rec.id);
      else if (applied === false && e.restart !== undefined)
        out.restartRequired.push({ plugin: e.rec.id, reason: e.restart });
    }
    this.flushMigrations();
    this.pruneCmd();
    this.refreshRefWatches();
    return out;
  }

  /** Re-resolves `secret:`/`file:`/`env:` refs for every plugin (a watched file or secret changed). */
  async reresolve(): Promise<void> {
    const changed: string[] = [];
    const restart: string[] = [];
    for (const e of this.entries.values()) {
      if (e.model === undefined || !hasStaticRefs(e.desired.res)) continue;
      const res = resolveBlock(e.model, e.desired.values, this.resolver);
      if (Object.keys(res.fatal).length > 0) {
        e.issues = { ...res.issues, ...res.fatal };
        continue;
      }
      e.desired = { values: e.desired.values, res };
      e.issues = { ...res.issues };
      if (e.rec.state !== "active") continue;
      const applied = await this.applyDesired(e);
      if (applied === true) changed.push(e.rec.id);
      else if (applied === false) restart.push(e.rec.id);
    }
    if (changed.length > 0 || restart.length > 0) this.deps.onChanged(changed, restart);
    this.refreshRefWatches();
  }

  // ---- internals ----

  private readonly resolver = (r: string, a: string, ref: string) => resolveStatic(this.deps.home, r, a, ref);

  private modelOf(e: Entry): Model {
    if (e.model === undefined)
      throw new SettingsError(400, `plugin "${e.rec.id}" has an invalid settings document`);
    return e.model;
  }

  /** Migrated file, user and project layers for one plugin. */
  private loadLayers(e: Entry): void {
    const model = e.model as Model;
    const id = e.rec.id;
    const fileRaw = this.fileConfig.plugins[id]?.config ?? {};
    const file = migrateLayer(model, fileRaw);
    for (const w of file.warnings) {
      const key = `${id}:${w}`;
      if (this.warnedFileKeys.has(key)) continue;
      this.warnedFileKeys.add(key);
      this.deps.log.warn(`config file, plugin "${id}": ${w} (in memory; edit the file to keep it)`, {
        plugin: id,
      });
    }
    e.file = file.layer;
    const userRaw = this.overlay.plugins[id]?.config ?? {};
    const user = migrateLayer(model, userRaw, (key) => this.deps.kv.get(id, key));
    e.user = user.layer;
    if (user.changed) {
      for (const w of user.warnings)
        this.deps.log.warn(`settings.json, plugin "${id}": ${w}`, { plugin: id });
      this.setUserConfig(id, user.layer);
      for (const key of user.kvMoved) this.kvMoves.push({ plugin: id, key });
    }
    e.projects.clear();
    for (const [pid, overlay] of this.projectOverlays) {
      const raw = overlay.plugins[id]?.config;
      if (raw === undefined) continue;
      const p = migrateLayer(model, raw);
      if (p.changed) {
        for (const w of p.warnings)
          this.deps.log.warn(`project ${pid}, plugin "${id}": ${w}`, { plugin: id });
        overlay.plugins[id] = { config: p.layer };
        this.projectDirty.add(pid);
      }
      e.projects.set(pid, p.layer);
    }
  }

  private setUserConfig(id: string, config: Block): void {
    const plugins = { ...this.overlay.plugins };
    const entry = { ...(plugins[id] ?? {}) };
    if (Object.keys(config).length > 0) entry.config = config;
    else delete entry.config;
    if (entry.config === undefined && entry.enabled === undefined) delete plugins[id];
    else plugins[id] = entry;
    this.overlay = { plugins };
    this.userDirty = true;
  }

  /** Known keys only: unknown ones stay stored but are logged and left out of the block. */
  private known(e: Entry, layer: Block, where: string): Block {
    const settings = e.model?.doc?.settings;
    if (settings === undefined) return layer;
    const out: Block = {};
    for (const [k, v] of Object.entries(layer)) {
      if (settings.has(k)) out[k] = v;
      else {
        const key = `${e.rec.id}:${where}:${k}`;
        if (!this.warnedFileKeys.has(key)) {
          this.warnedFileKeys.add(key);
          this.deps.log.warn(`${where}: plugin "${e.rec.id}" has no setting "${k}"; ignored`, {
            plugin: e.rec.id,
          });
        }
      }
    }
    return out;
  }

  private mergeValues(e: Entry, file: Block, user: Block): Block {
    const model = e.model as Model;
    const merged = {
      ...model.defaults,
      ...this.known(e, file, "config file"),
      ...this.known(e, user, "settings.json"),
    };
    return parseValues(model, merged, {});
  }

  /** Recomputes the desired block from the stored layers. Returns validation and required-ref failures. */
  private recompute(e: Entry): PathErrors {
    const model = e.model as Model;
    const merged = {
      ...model.defaults,
      ...this.known(e, e.file, "config file"),
      ...this.known(e, e.user, "settings.json"),
    };
    const errors: PathErrors = {};
    const values = parseValues(model, merged, errors);
    Object.assign(errors, validateValues(model, values));
    if (Object.keys(errors).length > 0) {
      e.desired = { values, res: EMPTY };
      return errors;
    }
    const res = resolveBlock(model, values, this.resolver);
    e.desired = { values, res };
    e.issues = { ...res.issues };
    return res.fatal;
  }

  /** A plugin that fails on a migrated-away key gets its settings.json entry back from the backup. */
  private restoreFromBackup(e: Entry): boolean {
    const backup = loadBackup(this.deps.home)?.plugins[e.rec.id]?.config;
    if (backup === undefined || sameConfig(backup, e.user)) return false;
    const values = this.mergeValues(e, e.file, backup);
    if (Object.keys(validateValues(e.model as Model, values)).length > 0) return false;
    this.deps.log.warn(`plugin "${e.rec.id}": settings restored from settings.json.bak`, {
      plugin: e.rec.id,
    });
    e.user = backup;
    this.setUserConfig(e.rec.id, backup);
    return true;
  }

  /** Validates a project's override over the applied block; an invalid one is dropped (kept stored) with issues. */
  private checkProject(e: Entry, pid: string): void {
    const layer = e.projects.get(pid);
    e.projectCache.delete(pid);
    if (layer === undefined || e.model === undefined) {
      e.projectIssues.delete(pid);
      return;
    }
    const errors: PathErrors = {};
    for (const [k, v] of Object.entries(layer)) {
      if (!scopesOf(e.model, k).includes("project") || !e.model.doc?.settings.has(k))
        errors[k] = "this setting can't be set per project";
      else for (const p of refPaths(v, k)) errors[p] = "refs are not allowed in the project layer";
    }
    const parsed = parseValues(e.model, layer, errors);
    Object.assign(errors, validateValues(e.model, { ...e.applied.values, ...parsed }, Object.keys(layer)));
    if (Object.keys(errors).length > 0) {
      if (!e.projectIssues.has(pid))
        this.deps.log.warn(
          `project ${pid}: overrides for "${e.rec.id}" are invalid and ignored: ${firstLine(errors)}`,
          {
            plugin: e.rec.id,
          },
        );
      e.projectIssues.set(pid, errors);
    } else e.projectIssues.delete(pid);
  }

  /** A user save must keep every (healthy) project override valid for the keys it touched. */
  private checkProjectsFor(e: Entry, model: Model, values: Block, keys: string[]): void {
    const errors: PathErrors = {};
    for (const [pid, layer] of e.projects) {
      if (e.projectIssues.has(pid)) continue;
      const parsed = parseValues(model, layer, {});
      for (const [p, m] of Object.entries(validateValues(model, { ...values, ...parsed }, keys)))
        errors[`${pid}:${p}`] = m;
    }
    if (Object.keys(errors).length > 0) throw new SettingsError(400, firstLine(errors), errors);
  }

  private checkReadonly(model: Model, config: Block, current: Block): void {
    const errors: PathErrors = {};
    for (const [k, v] of Object.entries(config)) {
      const node = model.doc?.settings.get(k)?.node;
      if (node) readonlyDiff(node, current[k], v === null ? undefined : v, k, errors);
    }
    if (Object.keys(errors).length > 0) throw new SettingsError(400, firstLine(errors), errors);
  }

  /**
   * Runs the plugin's listeners on the desired block. True when applied, false when it needs a restart, undefined
   * when nothing changed.
   */
  private async applyDesired(e: Entry): Promise<boolean | undefined> {
    const next = e.desired;
    const prev = e.applied;
    if (sameConfig(next.res.block, prev.res.block) && sameConfig(next.values, prev.values)) {
      if (!/^(enabled|disabled);/.test(e.restart ?? "")) delete e.restart;
      return undefined;
    }
    if (e.rec.state !== "active" || e.hooks === undefined) {
      e.restart =
        e.rec.state === "active"
          ? "plugin does not support live config changes"
          : "loads with these settings on restart";
      if (e.rec.state !== "active") {
        e.applied = next;
        e.version++;
      }
      return false;
    }
    if (e.hooks.listeners() === 0) {
      e.restart = "plugin does not support live config changes";
      return false;
    }
    try {
      await e.hooks.runListeners(next.res.block, prev.res.block);
    } catch (err) {
      e.restart = this.scrub(e, message(err), next.res);
      this.deps.log.warn(`plugin "${e.rec.id}" kept its previous config: ${e.restart}`, { plugin: e.rec.id });
      return false;
    }
    e.applied = next;
    e.version++;
    e.projectCache.clear();
    for (const pid of e.projects.keys()) this.checkProject(e, pid);
    delete e.restart;
    return true;
  }

  private cmdChanged(ref: string): void {
    this.gen++;
    for (const e of this.entries.values()) {
      if (!e.applied.res.pending.some((p) => p.raw.includes(ref))) continue;
      if (e.hooks === undefined || e.hooks.listeners() === 0) continue;
      const hooks = e.hooks;
      void this.enqueue(async () => {
        try {
          await hooks.runListeners(e.applied.res.block, e.applied.res.block);
        } catch (err) {
          e.restart = this.scrub(e, message(err));
        }
      });
    }
  }

  /** Drops cmd: cache entries for refs stored in these values (a save or a watched edit of their file). */
  private dropCmdRefs(values: unknown[]): void {
    const walk = (v: unknown): void => {
      if (typeof v === "string" && v.includes("${cmd:")) {
        try {
          for (const t of tokenize(v)) if ("ref" in t && t.resolver === "cmd") this.cmd.drop(t.ref);
        } catch {
          // Malformed text holds no cacheable ref.
        }
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (isRecord(v)) Object.values(v).forEach(walk);
    };
    values.forEach(walk);
    this.gen++;
  }

  /** Forgets cmd: cache entries that no plugin's desired or applied block still holds. */
  private pruneCmd(): void {
    const live = new Set<string>();
    for (const e of this.entries.values())
      for (const p of [...e.desired.res.pending, ...e.applied.res.pending])
        for (const t of tokenize(p.raw)) if ("ref" in t && t.resolver === "cmd") live.add(t.ref);
    this.cmd.retain(live);
  }

  private scrub(e: Entry, msg: string, res?: ResolveResult): string {
    const pairs: [string, string][] = [];
    for (const r of [e.applied.res, e.desired.res, res])
      for (const [ref, v] of r?.resolved ?? []) pairs.push([v, ref]);
    for (const p of e.applied.res.pending) {
      for (const t of tokenize(p.raw)) {
        if (!("ref" in t) || t.resolver !== "cmd") continue;
        const v = this.cmd.peek(t.ref);
        if (v !== undefined) pairs.push([v, t.ref]);
      }
    }
    let out = msg;
    for (const [v, ref] of pairs.sort((a, b) => b[0].length - a[0].length)) {
      if (v === "") continue;
      // Short values are masked only as whole tokens, so a 2-char secret doesn't mangle every word holding it.
      out =
        v.length >= 4
          ? out.replaceAll(v, ref)
          : out.replace(new RegExp(`(?<![A-Za-z0-9])${RegExp.escape(v)}(?![A-Za-z0-9])`, "g"), ref);
    }
    return out;
  }

  private scrubAll(e: Entry, issues: PathErrors): PathErrors {
    return Object.fromEntries(Object.entries(issues).map(([p, m]) => [p, this.scrub(e, m)]));
  }

  private remember(path: string): string | undefined {
    const text = readText(path);
    this.lastText.set(path, text);
    return text;
  }

  private writeUser(overlay: SettingsOverlay): void {
    const path = settingsPath(this.deps.home);
    this.lastText.set(path, writeOverlay(path, overlay));
    this.overlay = overlay;
  }

  private writeProject(pid: string, overlay: SettingsOverlay): void {
    const path = projectSettingsPath(this.deps.home, pid);
    this.lastText.set(path, writeOverlay(path, overlay, true));
    if (Object.keys(overlay.plugins).length > 0) this.projectOverlays.set(pid, overlay);
    else this.projectOverlays.delete(pid);
  }

  private flushMigrations(): void {
    if (this.userDirty) {
      backupOnce(this.deps.home);
      this.writeUser(this.overlay);
      this.userDirty = false;
    }
    for (const pid of this.projectDirty) {
      const overlay = this.projectOverlays.get(pid);
      if (overlay) this.writeProject(pid, overlay);
    }
    this.projectDirty.clear();
    for (const { plugin, key } of this.kvMoves.splice(0)) this.deps.kv.delete(plugin, key);
  }

  private refreshRefWatches(): void {
    if (this.watcher === undefined) return;
    const files = new Set<string>();
    for (const e of this.entries.values()) for (const w of e.desired.res.watches) files.add(w);
    this.watcher.setFiles(files, [
      settingsPath(this.deps.home),
      join(this.deps.home, "config.toml"),
      join(this.deps.home, "config.json"),
    ]);
  }

  private fileChanged(path: string): void {
    const home = this.deps.home;
    const isLayer =
      path === settingsPath(home) || path === join(home, "config.toml") || path === join(home, "config.json");
    const projectDir = `${projectDataDir(home)}/`;
    void this.enqueue(async () => {
      if (isLayer || path.startsWith(projectDir)) {
        const text = readText(path);
        if (this.lastText.has(path) && this.lastText.get(path) === text) return;
        this.lastText.set(path, text);
        if (isLayer) {
          await this.deps.onLayerFileChange();
          return;
        }
        const rel = path.slice(projectDir.length).split("/");
        if (rel.length === 2 && rel[1] === "settings.json")
          this.projectFileChanged(rel[0] as string, path, text);
        return;
      }
      await this.reresolve();
    }).catch((e: unknown) => this.deps.log.warn(`settings watch on ${path} failed: ${message(e)}`));
  }

  private projectFileChanged(pid: string, path: string, text: string | undefined): void {
    let overlay: SettingsOverlay;
    try {
      overlay = parseOverlay(path, text, false);
    } catch (e) {
      this.deps.log.warn(`ignoring ${path}: ${message(e)}`);
      return;
    }
    if (Object.keys(overlay.plugins).length > 0) this.projectOverlays.set(pid, overlay);
    else this.projectOverlays.delete(pid);
    for (const e of this.entries.values()) {
      const raw = overlay.plugins[e.rec.id]?.config;
      if (raw === undefined || e.model === undefined) e.projects.delete(pid);
      else e.projects.set(pid, migrateLayer(e.model, raw).layer);
      this.checkProject(e, pid);
    }
  }
}

/** Whether a block resolved, watched or failed any `secret:`/`file:`/`env:` ref (a failed one is an issue). */
const hasStaticRefs = (res: ResolveResult) =>
  res.resolved.size > 0 ||
  res.watches.size > 0 ||
  Object.keys(res.issues).length > 0 ||
  Object.keys(res.fatal).length > 0;

const under = (path: string, key: string) =>
  path === key || path.startsWith(`${key}.`) || path.startsWith(`${key}[`);

/** Paths of strings holding an unescaped `${` (refs), for the project layer's no-refs rule. */
function refPaths(v: unknown, path: string): string[] {
  if (typeof v === "string") return hasRef(v) ? [path] : [];
  if (Array.isArray(v)) return v.flatMap((x, i) => refPaths(x, `${path}[${i}]`));
  if (isRecord(v)) return Object.entries(v).flatMap(([k, x]) => refPaths(x, `${path}.${k}`));
  return [];
}

/** Readonly inputs (at the top or inside groups and variants) whose value a save would change. */
function readonlyDiff(node: Node, before: unknown, after: unknown, path: string, errors: PathErrors): void {
  if (isReadonly(node)) {
    if (!sameConfig(before, after)) errors[path] = "readonly";
    return;
  }
  const kids = node.inputs ?? node.cases?.flatMap((c) => c.inputs) ?? [];
  for (const c of kids) {
    const id = c.input.id as string;
    const b = isRecord(before) ? before[id] : undefined;
    const a = isRecord(after) ? after[id] : undefined;
    readonlyDiff(c, b, a, `${path}.${id}`, errors);
  }
  // spec-gap: list items match by position, map values by key; an item on only one side is not checked.
  if (node.item && Array.isArray(before) && Array.isArray(after)) {
    const n = Math.min(before.length, after.length);
    for (let i = 0; i < n; i++) readonlyDiff(node.item, before[i], after[i], `${path}[${i}]`, errors);
  }
  if (node.value && isRecord(before) && isRecord(after)) {
    for (const k of Object.keys(before))
      if (Object.hasOwn(after, k))
        readonlyDiff(node.value, before[k], after[k], `${path}[${JSON.stringify(k)}]`, errors);
  }
}
