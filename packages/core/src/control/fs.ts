import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export class FsError extends Error {
  constructor(
    readonly code: "bad_request" | "not_found" | "conflict",
    message: string,
  ) {
    super(message);
  }
}

export interface DirListing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
}

const expandHome = (input: string): string =>
  input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;

/** An absolute, symlink-resolved directory path, or an FsError. */
export async function normalizeDir(input: string): Promise<string> {
  const expanded = expandHome(input.trim());
  if (expanded === "" || !isAbsolute(expanded)) throw new FsError("bad_request", "path must be absolute");
  const resolved = resolve(expanded);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new FsError("not_found", `no such directory: ${resolved}`);
  }
  if (!(await stat(real)).isDirectory()) throw new FsError("bad_request", `not a directory: ${real}`);
  return real;
}

/** Subdirectories of `input` (default: home), sorted, dotfolders hidden unless asked for. */
export async function listDirs(input: string | null, showHidden = false): Promise<DirListing> {
  const path = await normalizeDir(input === null || input === "" ? homedir() : input);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    throw new FsError("bad_request", `cannot read ${path}`);
  }
  const dirs: DirListing["dirs"] = [];
  for (const e of entries) {
    if (!showHidden && e.name.startsWith(".")) continue;
    const full = join(path, e.name);
    const isDir =
      e.isDirectory() || (e.isSymbolicLink() && (await stat(full).catch(() => null))?.isDirectory());
    if (isDir === true) dirs.push({ name: e.name, path: full });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), dirs };
}

/** Creates one new folder named `name` inside the existing directory `parent`. Never overwrites. */
export async function makeDir(parent: string, name: string): Promise<string> {
  const base = await normalizeDir(parent);
  const clean = name.trim();
  if (clean === "" || clean === "." || clean === ".." || clean.includes("/") || basename(clean) !== clean) {
    throw new FsError("bad_request", "folder name must be a single path segment");
  }
  const target = join(base, clean);
  try {
    await mkdir(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new FsError("conflict", `${target} already exists`);
    throw new FsError("bad_request", `cannot create ${target}`);
  }
  return target;
}
