import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface HttpConfig {
  host?: string;
  port?: number;
  allowedOrigins?: string[];
}
export interface Listen {
  host: string;
  port: number;
  allowedOrigins: string[];
  /** Where the settings came from, for the boot log. */
  source: "config" | "legacy server block" | "defaults";
}

const DEFAULTS = { host: "127.0.0.1", port: 7417, allowedOrigins: [] as string[] };

/** The core config file's `server` block, which this plugin took over from the built-in listener. */
export function legacyServer(valetHome: string): HttpConfig | undefined {
  const toml = join(valetHome, "config.toml");
  const json = join(valetHome, "config.json");
  const path = existsSync(toml) ? toml : existsSync(json) ? json : undefined;
  if (path === undefined) return undefined;
  const text = readFileSync(path, "utf8");
  const raw = (path === toml ? Bun.TOML.parse(text) : JSON.parse(text)) as { server?: HttpConfig };
  return raw.server;
}

function check(c: HttpConfig, from: string): void {
  if (c.host !== undefined && (typeof c.host !== "string" || c.host === ""))
    throw new Error(`${from}: host must be a non-empty string`);
  if (c.port !== undefined && (!Number.isInteger(c.port) || c.port < 0 || c.port > 65535))
    throw new Error(`${from}: port must be an integer 0-65535`);
  if (
    c.allowedOrigins !== undefined &&
    (!Array.isArray(c.allowedOrigins) || c.allowedOrigins.some((o) => typeof o !== "string"))
  )
    throw new Error(`${from}: allowedOrigins must be a string array`);
}

/**
 * spec-gap: the upgrade "migrates" the `server` block by reading it while this plugin's own config is unset, instead
 * of rewriting config.json; the block stays in place for the built-in listener as the recovery path.
 */
export function resolveListen(own: HttpConfig | undefined, valetHome: string): Listen {
  const mine = own ?? {};
  const hasOwn = mine.host !== undefined || mine.port !== undefined || mine.allowedOrigins !== undefined;
  if (hasOwn) {
    check(mine, "plugins.valet-http.config");
    return { ...DEFAULTS, ...mine, source: "config" };
  }
  const legacy = legacyServer(valetHome);
  if (legacy !== undefined) {
    check(legacy, "server");
    return { ...DEFAULTS, ...legacy, source: "legacy server block" };
  }
  return { ...DEFAULTS, source: "defaults" };
}
