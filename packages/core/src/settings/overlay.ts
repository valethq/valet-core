import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ConfigError, type ValetConfig } from "../config";

type Block = Record<string, unknown>;

/** A settings layer file: `<valetHome>/settings.json` (user) or `project-data/<id>/settings.json` (project). */
export interface SettingsOverlay {
  plugins: Record<string, { enabled?: boolean; config?: Block }>;
}

/** A PATCH body: `config` keys set to null drop the layer's value. */
export interface SettingsPatch {
  scope?: "user" | "project";
  project?: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export const settingsPath = (home: string): string => join(home, "settings.json");
export const projectDataDir = (home: string): string => join(home, "project-data");
export const projectSettingsPath = (home: string, projectId: string): string =>
  join(projectDataDir(home), projectId, "settings.json");

const isRecord = (v: unknown): v is Block => typeof v === "object" && v !== null && !Array.isArray(v);

/** The file's text, or undefined when it doesn't exist. */
export function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** Parses a layer file's text. `allowEnabled` is false for project files, which never hold `enabled`. */
export function parseOverlay(path: string, text: string | undefined, allowEnabled = true): SettingsOverlay {
  if (text === undefined) return { plugins: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${path}: cannot parse JSON: ${(error as Error).message}`);
  }
  const plugins = isRecord(raw) ? raw.plugins : undefined;
  if (plugins !== undefined && !isRecord(plugins))
    throw new ConfigError(`${path}: "plugins" must be an object`);
  const out: SettingsOverlay = { plugins: {} };
  for (const [id, entry] of Object.entries(plugins ?? {})) {
    if (!isRecord(entry)) throw new ConfigError(`${path}: "plugins.${id}" must be an object`);
    if (entry.enabled !== undefined && (!allowEnabled || typeof entry.enabled !== "boolean"))
      throw new ConfigError(
        `${path}: "plugins.${id}.enabled" ${allowEnabled ? "must be a boolean" : "is not allowed"}`,
      );
    if (entry.config !== undefined && !isRecord(entry.config))
      throw new ConfigError(`${path}: "plugins.${id}.config" must be an object`);
    out.plugins[id] = {
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
      ...(entry.config === undefined ? {} : { config: entry.config }),
    };
  }
  return out;
}

export const loadOverlay = (home: string): SettingsOverlay =>
  parseOverlay(settingsPath(home), readText(settingsPath(home)));

export const overlayText = (overlay: SettingsOverlay): string => `${JSON.stringify(overlay, null, 2)}\n`;

/**
 * Written whole to a temp file and renamed over the old one, so a crash never leaves half a file. An empty project
 * file is deleted with its directory. Returns the text written (undefined when deleted), for watcher dedupe.
 */
export function writeOverlay(
  path: string,
  overlay: SettingsOverlay,
  deleteWhenEmpty = false,
): string | undefined {
  if (deleteWhenEmpty && Object.keys(overlay.plugins).length === 0) {
    if (existsSync(path)) rmSync(path);
    const dir = dirname(path);
    if (existsSync(dir) && readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
    return undefined;
  }
  mkdirSync(dirname(path), { recursive: true });
  const text = overlayText(overlay);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
  return text;
}

/** Copies settings.json to settings.json.bak before the first migration rewrite. */
export function backupOnce(home: string): void {
  const path = settingsPath(home);
  if (existsSync(path) && !existsSync(`${path}.bak`)) copyFileSync(path, `${path}.bak`);
}

export const loadBackup = (home: string): SettingsOverlay | undefined => {
  const path = `${settingsPath(home)}.bak`;
  try {
    return existsSync(path) ? parseOverlay(path, readFileSync(path, "utf8")) : undefined;
  } catch {
    return undefined;
  }
};

/** Project ids with a settings file under project-data/. */
export function projectIdsWithSettings(home: string): string[] {
  const dir = projectDataDir(home);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, "settings.json")))
    .map((e) => e.name)
    .sort();
}

/** A new overlay with the patch applied; an entry left empty is dropped. `fileEnabled` is the config file's flag. */
export function patchOverlay(
  overlay: SettingsOverlay,
  id: string,
  patch: Pick<SettingsPatch, "config" | "enabled">,
  fileEnabled: boolean | undefined,
): SettingsOverlay {
  const entry = structuredClone(overlay.plugins[id] ?? {});
  if (patch.config !== undefined) {
    const config = entry.config ?? {};
    for (const [key, value] of Object.entries(patch.config)) {
      if (value === null) delete config[key];
      else config[key] = value;
    }
    if (Object.keys(config).length > 0) entry.config = config;
    else delete entry.config;
  }
  if (patch.enabled !== undefined) {
    if (patch.enabled === (fileEnabled ?? true)) delete entry.enabled;
    else entry.enabled = patch.enabled;
  }
  const plugins = { ...overlay.plugins };
  if (entry.enabled === undefined && entry.config === undefined) delete plugins[id];
  else plugins[id] = entry;
  return { plugins };
}

/** The file config with the overlay's enabled flags on top (config blocks are layered per plugin by the kernel). */
export function withEnabled(file: ValetConfig, overlay: SettingsOverlay): ValetConfig {
  const plugins: ValetConfig["plugins"] = {};
  for (const id of new Set([...Object.keys(file.plugins), ...Object.keys(overlay.plugins)])) {
    const base = file.plugins[id] ?? {};
    const enabled = overlay.plugins[id]?.enabled ?? base.enabled;
    plugins[id] = { ...base, ...(enabled === undefined ? {} : { enabled }) };
  }
  return { ...file, plugins };
}
