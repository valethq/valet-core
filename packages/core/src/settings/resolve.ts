import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { expandHome } from "../paths";
import { envName, isSecretName } from "../secrets";

export interface Resolved {
  value: string;
  /** Set when the source file is readable by group or others. */
  warning?: string;
  /** A file to watch for changes. */
  watch?: string;
}

const modeWarning = (path: string): string | undefined => {
  const mode = statSync(path).mode & 0o777;
  return (mode & 0o077) === 0 ? undefined : `${path} has mode ${mode.toString(8)}, expected 600`;
};

/** Resolves `secret:`, `file:` and `env:` synchronously. Throws with the ref text, never a value. */
export function resolveStatic(home: string, resolver: string, arg: string, ref: string): Resolved {
  if (resolver === "env") {
    const sep = arg.indexOf(":-");
    const name = sep < 0 ? arg : arg.slice(0, sep);
    const value = process.env[name];
    if (value !== undefined) return { value };
    if (sep >= 0) return { value: arg.slice(sep + 2) };
    throw new Error(`${ref} is not set`);
  }
  if (resolver === "secret") {
    if (!isSecretName(arg)) throw new Error(`${ref}: invalid secret name`);
    const path = join(home, "secrets", arg);
    if (existsSync(path)) {
      const warning = modeWarning(path);
      return { value: readFileSync(path, "utf8").trim(), watch: path, ...(warning ? { warning } : {}) };
    }
    const value = process.env[envName(arg)];
    if (value !== undefined) return { value };
    throw new Error(`${ref} not found`);
  }
  if (resolver === "file") {
    const path = expandHome(arg);
    if (!isAbsolute(path)) throw new Error(`${ref}: path must be absolute or start with ~`);
    if (!existsSync(path)) throw new Error(`${ref} not found`);
    const warning = modeWarning(path);
    return {
      value: readFileSync(path, "utf8").replace(/\r?\n$/, ""),
      watch: path,
      ...(warning ? { warning } : {}),
    };
  }
  throw new Error(`${ref}: unknown resolver`);
}

const CMD_TIMEOUT_MS = 10_000;

interface CmdEntry {
  value?: string;
  failed?: string;
  /** When the last run finished; -Infinity once dropped. */
  at: number;
  inflight?: Promise<void>;
}

/**
 * `cmd:` refs: run on read in the background, cached per ref text for the input's TTL. Failures are cached for the
 * TTL too, and the last good value is kept through failures and drops.
 */
export class CmdCache {
  private entries = new Map<string, CmdEntry>();

  constructor(
    private readonly home: string,
    private readonly onChange: (ref: string) => void,
    private readonly timeoutMs = CMD_TIMEOUT_MS,
  ) {}

  /** The cached value (or last good one), starting a run when the entry is missing or older than `ttl`. */
  read(ref: string, line: string, ttl: number): { value?: string; error?: string } {
    let e = this.entries.get(ref);
    if (e === undefined) {
      e = { at: Number.NEGATIVE_INFINITY };
      this.entries.set(ref, e);
    }
    if (e.inflight === undefined && Date.now() - e.at >= ttl) this.run(ref, line, e);
    return { ...(e.value === undefined ? {} : { value: e.value }), ...(e.failed ? { error: e.failed } : {}) };
  }

  /** The cached value without starting a run. */
  peek(ref: string): string | undefined {
    return this.entries.get(ref)?.value;
  }

  /** Marks the entry stale without running it; the next read does. */
  drop(ref: string): void {
    const e = this.entries.get(ref);
    if (e) e.at = Number.NEGATIVE_INFINITY;
  }

  /** Forgets every entry whose ref is not in `live`. */
  retain(live: ReadonlySet<string>): void {
    for (const ref of this.entries.keys()) if (!live.has(ref)) this.entries.delete(ref);
  }

  /** Resolves once every in-flight run has finished (tests, shutdown). */
  async settle(): Promise<void> {
    await Promise.all([...this.entries.values()].map((e) => e.inflight));
  }

  /** Current failures by ref text. */
  failures(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [ref, e] of this.entries) if (e.failed) out.set(ref, e.failed);
    return out;
  }

  private run(ref: string, line: string, e: CmdEntry): void {
    e.inflight = (async () => {
      let out: string | undefined;
      let error: string | undefined;
      try {
        const proc = Bun.spawn(["/bin/sh", "-c", line], {
          cwd: this.home,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
        });
        let expire: (v: undefined) => void = () => {};
        const timeout = new Promise<undefined>((done) => {
          expire = done;
        });
        const timer = setTimeout(() => expire(undefined), this.timeoutMs);
        const result = await Promise.race([
          Promise.all([new Response(proc.stdout).text(), proc.exited]),
          timeout,
        ]);
        clearTimeout(timer);
        if (result === undefined) {
          proc.kill("SIGKILL");
          error = `${ref} timed out after ${this.timeoutMs}ms`;
        } else if (result[1] !== 0) error = `${ref} exited with ${result[1]}`;
        else out = result[0].trim();
      } catch (err) {
        error = `${ref} failed to start: ${(err as Error).message}`;
      }
      e.at = Date.now();
      e.inflight = undefined;
      if (error !== undefined) {
        e.failed = error;
        return;
      }
      e.failed = undefined;
      const changed = e.value !== out;
      e.value = out;
      if (changed) this.onChange(ref);
    })();
  }
}
