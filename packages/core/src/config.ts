import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { expandHome } from "./paths";

/** Section 12: ~/.valet/config.json, with VALET_HOME overriding the location. */
export interface ValetConfig {
  server: { host: string; port: number; allowedOrigins: string[] };
  pluginPaths: string[];
  plugins: Record<string, { enabled?: boolean; config?: Record<string, unknown> }>;
  /** spec-gap: "name@major" -> the plugin id (or provider key) that wins a cardinality-"one" scope. */
  scopes: Record<string, string>;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function defaultValetHome(): string {
  return process.env.VALET_HOME ?? join(homedir(), ".valet");
}

/** The repo's own plugins/ directory, scanned by default (5.2). */
export function repoPluginsDir(): string {
  return join(import.meta.dir, "../../../plugins");
}

export function defaultConfig(valetHome: string): ValetConfig {
  return {
    server: { host: "127.0.0.1", port: 7417, allowedOrigins: [] },
    pluginPaths: [join(valetHome, "plugins"), repoPluginsDir()],
    plugins: {},
    scopes: {},
  };
}

/** Structural equality for config values (key order ignored). */
export function sameConfig(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => sameConfig(v, b[i]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((k) => sameConfig(a[k], b[k]));
  }
  return a === b;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, what: string): never {
  throw new ConfigError(`${path}: ${what}`);
}

/** Reads <valetHome>/config.toml (else config.json) over the defaults and validates the shape (12). Missing file = defaults. */
export function loadConfig(valetHome: string): { configPath: string; config: ValetConfig } {
  const config = defaultConfig(valetHome);
  const tomlPath = join(valetHome, "config.toml");
  const jsonPath = join(valetHome, "config.json");
  const isToml = existsSync(tomlPath);
  const configPath = isToml || !existsSync(jsonPath) ? tomlPath : jsonPath;
  if (!isToml && !existsSync(jsonPath)) return { configPath, config };

  let raw: unknown;
  try {
    const text = readFileSync(configPath, "utf8");
    raw = isToml ? Bun.TOML.parse(text) : JSON.parse(text);
  } catch (error) {
    throw new ConfigError(
      `${configPath}: cannot parse ${isToml ? "TOML" : "JSON"}: ${(error as Error).message}`,
    );
  }
  if (!isRecord(raw)) fail(configPath, "expected a table at the top level");

  if (raw.server !== undefined) {
    if (!isRecord(raw.server)) fail(configPath, '"server" must be an object');
    const s = raw.server;
    if (s.host !== undefined) {
      if (typeof s.host !== "string") fail(configPath, '"server.host" must be a string');
      config.server.host = s.host;
    }
    if (s.port !== undefined) {
      if (!Number.isInteger(s.port) || (s.port as number) <= 0 || (s.port as number) > 65535) {
        fail(configPath, '"server.port" must be an integer 1-65535');
      }
      config.server.port = s.port as number;
    }
    if (s.allowedOrigins !== undefined) {
      if (!Array.isArray(s.allowedOrigins) || s.allowedOrigins.some((o) => typeof o !== "string")) {
        fail(configPath, '"server.allowedOrigins" must be a string array');
      }
      config.server.allowedOrigins = s.allowedOrigins as string[];
    }
  }

  if (raw.pluginPaths !== undefined) {
    if (!Array.isArray(raw.pluginPaths) || raw.pluginPaths.some((p) => typeof p !== "string")) {
      fail(configPath, '"pluginPaths" must be a string array');
    }
    config.pluginPaths = raw.pluginPaths as string[];
  }
  config.pluginPaths = config.pluginPaths.map((p) => resolve(expandHome(p)));

  if (raw.plugins !== undefined) {
    if (!isRecord(raw.plugins)) fail(configPath, '"plugins" must be an object');
    for (const [id, entry] of Object.entries(raw.plugins)) {
      if (!isRecord(entry)) fail(configPath, `"plugins.${id}" must be an object`);
      if (entry.enabled !== undefined && typeof entry.enabled !== "boolean") {
        fail(configPath, `"plugins.${id}.enabled" must be a boolean`);
      }
      if (entry.config !== undefined && !isRecord(entry.config)) {
        fail(configPath, `"plugins.${id}.config" must be an object`);
      }
      config.plugins[id] = {
        ...(entry.enabled === undefined ? {} : { enabled: entry.enabled }),
        ...(entry.config === undefined ? {} : { config: entry.config }),
      };
    }
  }

  if (raw.scopes !== undefined) {
    if (!isRecord(raw.scopes) || Object.values(raw.scopes).some((v) => typeof v !== "string")) {
      fail(configPath, '"scopes" must be an object of "name@major" -> plugin id');
    }
    config.scopes = raw.scopes as Record<string, string>;
  }

  return { configPath, config };
}
