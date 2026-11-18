import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, type ValetConfig } from "./config";

type Block = Record<string, unknown>;

/** <valetHome>/settings.json: what the control plane saved, layered over the config file (12.1). */
export interface SettingsOverlay {
  plugins: Record<string, { enabled?: boolean; config?: Block }>;
}

/** Where a plugin's effective config key came from. */
export type SettingSource = "default" | "file" | "settings";

/** A PATCH body: `config` keys set to null go back to the file or default value. */
export interface SettingsPatch {
  config?: Record<string, unknown>;
  enabled?: boolean;
}

export const settingsPath = (home: string): string => join(home, "settings.json");

const isRecord = (v: unknown): v is Block => typeof v === "object" && v !== null && !Array.isArray(v);

export function loadOverlay(home: string): SettingsOverlay {
  const path = settingsPath(home);
  if (!existsSync(path)) return { plugins: {} };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ConfigError(`${path}: cannot parse JSON: ${(error as Error).message}`);
  }
  const plugins = isRecord(raw) ? raw.plugins : undefined;
  if (plugins !== undefined && !isRecord(plugins))
    throw new ConfigError(`${path}: "plugins" must be an object`);
  const out: SettingsOverlay = { plugins: {} };
  for (const [id, entry] of Object.entries(plugins ?? {})) {
    if (!isRecord(entry)) throw new ConfigError(`${path}: "plugins.${id}" must be an object`);
    if (entry.enabled !== undefined && typeof entry.enabled !== "boolean")
      throw new ConfigError(`${path}: "plugins.${id}.enabled" must be a boolean`);
    if (entry.config !== undefined && !isRecord(entry.config))
      throw new ConfigError(`${path}: "plugins.${id}.config" must be an object`);
    out.plugins[id] = {
      ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
      ...(entry.config === undefined ? {} : { config: entry.config }),
    };
  }
  return out;
}

/** Written whole to a temp file and renamed over the old one, so a crash never leaves half a file. */
export function saveOverlay(home: string, overlay: SettingsOverlay): void {
  const path = settingsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(overlay, null, 2)}\n`);
  renameSync(tmp, path);
}

/** The file config with the overlay's enabled flags and top-level config keys on top. */
export function layer(file: ValetConfig, overlay: SettingsOverlay): ValetConfig {
  const plugins: ValetConfig["plugins"] = {};
  for (const id of new Set([...Object.keys(file.plugins), ...Object.keys(overlay.plugins)])) {
    const base = file.plugins[id] ?? {};
    const top = overlay.plugins[id] ?? {};
    const enabled = top.enabled ?? base.enabled;
    const config =
      base.config === undefined && top.config === undefined ? undefined : { ...base.config, ...top.config };
    plugins[id] = {
      ...(enabled === undefined ? {} : { enabled }),
      ...(config === undefined ? {} : { config }),
    };
  }
  return { ...file, plugins };
}

const properties = (schema: Block | undefined): Record<string, Block> =>
  isRecord(schema?.properties) ? (schema.properties as Record<string, Block>) : {};

/** Fills in the schema's top-level `default` values for keys the block leaves out. */
export function withDefaults(schema: Block | undefined, block: Block): Block {
  const out = { ...block };
  for (const [key, prop] of Object.entries(properties(schema))) {
    if (!(key in out) && isRecord(prop) && "default" in prop) out[key] = structuredClone(prop.default);
  }
  return out;
}

export function sourcesOf(
  schema: Block | undefined,
  file: Block | undefined,
  overlay: Block | undefined,
): Record<string, SettingSource> {
  const out: Record<string, SettingSource> = {};
  for (const [key, prop] of Object.entries(properties(schema)))
    if (isRecord(prop) && "default" in prop) out[key] = "default";
  for (const key of Object.keys(file ?? {})) out[key] = "file";
  for (const key of Object.keys(overlay ?? {})) out[key] = "settings";
  return out;
}

/** A new overlay with the patch applied; an entry left empty is dropped. `fileEnabled` is the config file's flag. */
export function patchOverlay(
  overlay: SettingsOverlay,
  id: string,
  patch: SettingsPatch,
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
