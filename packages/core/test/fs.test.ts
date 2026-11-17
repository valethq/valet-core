import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsError, listDirs, makeDir, normalizeDir } from "../src/control/fs";

const root = mkdtempSync(join(tmpdir(), "valet-fs-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

mkdirSync(join(root, "beta"));
mkdirSync(join(root, "Alpha"));
mkdirSync(join(root, ".hidden"));
writeFileSync(join(root, "file.txt"), "x");
symlinkSync(join(root, "beta"), join(root, "link"));

describe("normalizeDir", () => {
  test("resolves symlinks and trailing slashes", async () => {
    const real = await normalizeDir(`${join(root, "link")}/`);
    expect(real).toEndWith("/beta");
  });
  test("rejects relative, missing and non-directory paths", async () => {
    await expect(normalizeDir("beta")).rejects.toBeInstanceOf(FsError);
    await expect(normalizeDir(join(root, "nope"))).rejects.toThrow(/no such directory/);
    await expect(normalizeDir(join(root, "file.txt"))).rejects.toThrow(/not a directory/);
  });
});

describe("listDirs", () => {
  test("lists directories only, sorted, hiding dotfolders", async () => {
    const out = await listDirs(root);
    expect(out.dirs.map((d) => d.name)).toEqual(["Alpha", "beta", "link"]);
    expect(out.parent).not.toBeNull();
  });
  test("shows dotfolders on request", async () => {
    expect((await listDirs(root, true)).dirs.map((d) => d.name)).toContain(".hidden");
  });
  test("defaults to home and has no parent at the root", async () => {
    expect((await listDirs(null)).path).toBe((await listDirs(null)).home);
    expect((await listDirs("/")).parent).toBeNull();
  });
});

describe("makeDir", () => {
  test("creates a folder and refuses to overwrite", async () => {
    const made = await makeDir(root, "fresh");
    expect(made).toBe(join(root, "fresh"));
    await expect(makeDir(root, "fresh")).rejects.toMatchObject({ code: "conflict" });
  });
  test("rejects names that escape the parent", async () => {
    for (const bad of ["", ".", "..", "a/b", "../x"]) {
      await expect(makeDir(root, bad)).rejects.toMatchObject({ code: "bad_request" });
    }
  });
});
