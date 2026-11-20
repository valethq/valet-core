import { existsSync, type FSWatcher, mkdirSync, watch } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Directory watches, debounced per file: rename-over writes break file-level watches, so each watched file is
 * observed through its directory. `onChange` gets the file's path.
 */
export class DirWatcher {
  private dirs = new Map<string, FSWatcher>();
  private files = new Set<string>();
  private prefixes = new Set<string>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;

  constructor(
    private readonly onChange: (path: string) => void,
    private readonly debounceMs = 50,
  ) {}

  /** Watches one file through its directory. */
  file(path: string): void {
    this.files.add(path);
    this.dir(dirname(path), false);
  }

  /** Watches every file under `dir` (recursive), creating the directory if needed. */
  tree(dir: string): void {
    mkdirSync(dir, { recursive: true });
    this.prefixes.add(`${dir}/`);
    this.dir(dir, true);
  }

  /** Replaces the set of single files watched beside the fixed ones (e.g. `file:` ref targets). */
  setFiles(paths: Iterable<string>, keep: Iterable<string>): void {
    this.files = new Set([...keep, ...paths]);
    for (const p of this.files) this.dir(dirname(p), false);
  }

  close(): void {
    this.closed = true;
    for (const w of this.dirs.values()) w.close();
    for (const t of this.timers.values()) clearTimeout(t);
    this.dirs.clear();
    this.timers.clear();
  }

  private dir(dir: string, recursive: boolean): void {
    if (this.closed || this.dirs.has(dir) || !existsSync(dir)) return;
    try {
      const w = watch(dir, { recursive }, (_event, name) => {
        if (name === null) return;
        const path = join(dir, name.toString());
        if (!this.files.has(path) && ![...this.prefixes].some((p) => path.startsWith(p))) return;
        clearTimeout(this.timers.get(path));
        this.timers.set(
          path,
          setTimeout(() => {
            this.timers.delete(path);
            if (!this.closed) this.onChange(path);
          }, this.debounceMs),
        );
      });
      w.on("error", () => this.dirs.delete(dir));
      this.dirs.set(dir, w);
    } catch {
      // A directory that vanished or can't be watched is skipped; reload still re-reads it.
    }
  }
}
