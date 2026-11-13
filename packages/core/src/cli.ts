#!/usr/bin/env bun
import { CORE_API_VERSION } from "@valethq/sdk";
import { defaultValetHome, loadConfig } from "./config";
import { createControlServer } from "./control/index";
import { boot } from "./kernel";
import { discoverPlugins, resolvePlugins } from "./loader";
import { createLogger } from "./log";

function flagValue(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function start(args: string[]): Promise<number> {
  const valetHome = flagValue(args, "--home") ?? defaultValetHome();
  try {
    const kernel = await boot({ valetHome });
    // 5.2 step 6: the control plane starts only after core.ready, and stops first on shutdown.
    const control = createControlServer(kernel);
    control.start();
    const active = kernel.plugins().filter((p) => p.state === "active").length;
    const failed = kernel.plugins().filter((p) => p.state === "failed").length;
    kernel.log.info(`valet ${CORE_API_VERSION} ready: ${active} plugins active, ${failed} failed`, {
      valetHome,
      controlPlane: control.baseUrl(),
      plugins: kernel.plugins(),
    });
    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = (): void => {
        if (stopping) return;
        stopping = true;
        control.stop();
        void kernel.shutdown().then(resolve);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
    return 0;
  } catch (error) {
    console.error(`valet start failed: ${errorMessage(error)}`);
    return 1;
  }
}

/** Prints config path and plugin discovery results without starting the server. */
function doctor(args: string[]): number {
  const valetHome = flagValue(args, "--home") ?? defaultValetHome();
  let failures = 0;
  try {
    const { configPath, config } = loadConfig(valetHome);
    console.log(`config: ${configPath}`);
    console.log(`valet home: ${valetHome}`);
    const silent = createLogger({ out: () => {} });
    const records = discoverPlugins(config, silent);
    resolvePlugins(records, config, silent);
    if (records.length === 0) {
      console.log("plugins: none discovered");
      return 0;
    }
    console.log("plugins:");
    const sorted = records
      .slice()
      .sort(
        (a, b) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
          a.id.localeCompare(b.id),
      );
    for (const rec of sorted) {
      const version = rec.manifest?.version ?? "?";
      if (rec.state === "failed") {
        failures += 1;
        console.log(`  failed   ${rec.id}@${version}  ${rec.error}`);
      } else if (rec.state === "disabled") {
        console.log(`  disabled ${rec.id}@${version}`);
      } else {
        console.log(`  ok       ${rec.id}@${version}  load order ${rec.order}`);
      }
    }
  } catch (error) {
    console.error(`valet doctor failed: ${errorMessage(error)}`);
    return 1;
  }
  return failures > 0 ? 1 : 0;
}

async function main(): Promise<number> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "start":
      return start(args);
    case "doctor":
      return doctor(args);
    case "import-openclaw":
      console.log("import-openclaw: not implemented in M0");
      return 2;
    default:
      console.error("usage: valet <start|doctor|import-openclaw> [--home <dir>]");
      return 2;
  }
}

if (import.meta.main) {
  process.exit(await main());
}
