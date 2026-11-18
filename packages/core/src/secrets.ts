import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Logger, Secrets } from "@valethq/sdk";

/**
 * 5.3: a secret resolves from <valetHome>/secrets/<name> (a file, expected mode
 * 0600) and then the environment variable <NAME> upper-cased.
 */
export function createSecrets(valetHome: string, log: Logger): Secrets {
  return {
    async get(name: string): Promise<string | undefined> {
      const path = join(valetHome, "secrets", name);
      if (existsSync(path)) {
        const mode = statSync(path).mode & 0o777;
        if (mode !== 0o600) {
          log.warn(`secret "${name}" has mode ${mode.toString(8)}, expected 600`, { path });
        }
        return (await Bun.file(path).text()).trim();
      }
      // spec-gap: "-" becomes "_" so "discord-token" can arrive as DISCORD_TOKEN.
      return process.env[envName(name)];
    },
    async require(name: string): Promise<string> {
      const value = await this.get(name);
      if (value === undefined) throw new Error(`missing secret "${name}"`);
      return value;
    },
  };
}

const SECRET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export const isSecretName = (name: string): boolean => SECRET_NAME.test(name);

const envName = (name: string): string => name.toUpperCase().replaceAll("-", "_");

/** Where a secret resolves from, without its value (12.2). */
export function secretSource(valetHome: string, name: string): "file" | "env" | null {
  if (existsSync(join(valetHome, "secrets", name))) return "file";
  return process.env[envName(name)] === undefined ? null : "env";
}

/** Names of the secret files; environment variables are never listed. */
export function listSecretFiles(valetHome: string): string[] {
  const dir = join(valetHome, "secrets");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && isSecretName(e.name))
    .map((e) => e.name)
    .sort();
}

/** Writes <valetHome>/secrets/<name> with mode 0600 (the directory 0700), replacing it whole. */
export function writeSecret(valetHome: string, name: string, value: string): void {
  if (!isSecretName(name)) throw new Error(`invalid secret name "${name}"`);
  const dir = join(valetHome, "secrets");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Removes the secret file; false when there was none. */
export function deleteSecret(valetHome: string, name: string): boolean {
  if (!isSecretName(name)) throw new Error(`invalid secret name "${name}"`);
  const path = join(valetHome, "secrets", name);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
