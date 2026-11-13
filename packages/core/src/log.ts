import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Logger } from "@valethq/sdk";

export interface CoreLogger extends Logger {
  /** A logger tagged with a plugin id (12: "tagged with plugin id"). */
  forPlugin(pluginId: string): Logger;
}

export interface LoggerOptions {
  /** Enables file logging to <valetHome>/logs/valet.log. */
  valetHome?: string;
  /** Stdout sink for JSON lines; defaults to console.log. */
  out?: (line: string) => void;
  plugin?: string;
}

/** JSON-lines logger: one object per line to stdout and <valetHome>/logs/valet.log (12). */
export function createLogger(opts: LoggerOptions = {}): CoreLogger {
  const out = opts.out ?? ((line: string) => console.log(line));
  const filePath = opts.valetHome === undefined ? undefined : join(opts.valetHome, "logs", "valet.log");
  if (filePath !== undefined) mkdirSync(dirname(filePath), { recursive: true });

  const write = (level: string, msg: string, data: Record<string, unknown> | undefined): void => {
    let line: string;
    try {
      line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        ...(opts.plugin === undefined ? {} : { plugin: opts.plugin }),
        msg,
        ...(data ?? {}),
      });
    } catch {
      line = JSON.stringify({ ts: new Date().toISOString(), level, plugin: opts.plugin ?? null, msg });
    }
    out(line);
    if (filePath !== undefined) {
      try {
        appendFileSync(filePath, `${line}\n`);
      } catch {
        // spec-gap: a dead log file must not kill the kernel.
      }
    }
  };

  return {
    debug: (msg, data) => write("debug", msg, data),
    info: (msg, data) => write("info", msg, data),
    warn: (msg, data) => write("warn", msg, data),
    error: (msg, data) => write("error", msg, data),
    forPlugin: (pluginId) => createLogger({ ...opts, plugin: pluginId }),
  };
}
