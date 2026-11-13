import { existsSync, statSync } from "node:fs";
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
      return process.env[name.toUpperCase().replaceAll("-", "_")];
    },
    async require(name: string): Promise<string> {
      const value = await this.get(name);
      if (value === undefined) throw new Error(`missing secret "${name}"`);
      return value;
    },
  };
}
