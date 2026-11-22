import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { hasFts5, openDatabase, runCoreMigrations } from "../src/store/index";

const CORE_TABLES = [
  "projects",
  "sessions",
  "session_bindings",
  "runs",
  "messages",
  "parts",
  "principals",
  "identities",
  "blobs",
  "plugin_kv",
  "schema_migrations",
];

function tableNames(db: Database): string[] {
  const rows = db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return rows.map((r) => r.name);
}

describe("core migrations", () => {
  test("apply on an empty database and create the 8.2 schema", async () => {
    const db = openDatabase(":memory:");
    const applied = await runCoreMigrations(db);
    expect(applied).toEqual(["001_core", "002_acl"]);
    for (const table of CORE_TABLES) expect(tableNames(db)).toContain(table);
    const indexes = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%_session'")
      .all() as { name: string }[];
    expect(indexes.map((i) => i.name).sort()).toEqual(["messages_session", "runs_session"]);
    db.close();
  });

  test("are no-ops on re-run", async () => {
    const db = openDatabase(":memory:");
    await runCoreMigrations(db);
    expect(await runCoreMigrations(db)).toEqual([]);
    db.close();
  });

  test("survive a reopen against a file database", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-mig-"));
    const path = join(dir, "valet.sqlite");
    const first = openDatabase(path);
    await runCoreMigrations(first);
    first
      .query("INSERT INTO projects (id, name, workspace_dir, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run("prj_1", "p", "/w", 1, 1);
    first.close();

    const second = openDatabase(path);
    expect(await runCoreMigrations(second)).toEqual([]);
    const row = second.query("SELECT name FROM projects WHERE id = 'prj_1'").get() as { name: string } | null;
    expect(row?.name).toBe("p");
    expect(second.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    second.close();
  });

  test("a failed migration is not recorded and rolls back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "valet-migbad-"));
    await Bun.write(
      join(dir, "002_bad.ts"),
      'export function up(db) { db.exec("CREATE TABLE bad_t (x)"); throw new Error("boom"); }\n',
    );
    const db = openDatabase(":memory:");
    await expect(runCoreMigrations(db, dir)).rejects.toThrow("boom");
    expect(tableNames(db)).not.toContain("bad_t");
    const recorded = db.query("SELECT id FROM schema_migrations").all() as { id: string }[];
    expect(recorded.map((r) => r.id)).not.toContain("002_bad");
    db.close();
  });

  test("reports whether FTS5 is available", () => {
    const db = openDatabase(":memory:");
    expect(typeof hasFts5(db)).toBe("boolean");
    db.close();
  });
});
