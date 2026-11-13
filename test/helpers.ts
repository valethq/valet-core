import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot, type BootOptions, type PluginStatus, type ValetKernel } from "@valethq/core";

export const FX = join(import.meta.dir, "fixtures", "plugins");
export const fxRoot = (name: string) => join(FX, name);

export interface BootFxOptions extends BootOptions {
  /** Extra keys merged into the config.json written to the temp valet home. */
  config?: Record<string, unknown>;
}

/** Boots the kernel with a temp VALET_HOME and pluginPaths pointing at one fixture root. */
export async function bootFx(
  fixtureRoot: string,
  opts: BootFxOptions = {},
): Promise<{ kernel: ValetKernel; home: string }> {
  const home = mkdtempSync(join(tmpdir(), "valet-p3-"));
  const { config, ...rest } = opts;
  writeFileSync(join(home, "config.json"), JSON.stringify({ pluginPaths: [fixtureRoot], ...(config ?? {}) }));
  const kernel = await boot({ valetHome: home, dbPath: ":memory:", out: () => {}, ...rest });
  return { kernel, home };
}

export function state(kernel: ValetKernel, id: string): PluginStatus | undefined {
  return kernel.plugins().find((p) => p.id === id);
}

/** Read a JSON file a fixture plugin wrote into ctx.paths.data. */
export function data<T = Record<string, unknown>>(home: string, id: string, file: string): T {
  return JSON.parse(readFileSync(join(home, "data", id, file), "utf8")) as T;
}

export function markerWritten(home: string, id: string): boolean {
  return existsSync(join(home, "data", id, "marker.json"));
}
