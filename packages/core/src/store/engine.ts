import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { Database } from "bun:sqlite";

// spec-gap: the task pins <valetHome>/valet.sqlite; the 8.1 sketch says valet.db.
export function defaultDbPath(valetHome: string): string {
  return join(valetHome, "valet.sqlite");
}

/** 8.1: WAL, synchronous=NORMAL, foreign_keys=ON, busy_timeout=5000. ":memory:" skips WAL (kept in-memory). */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  if (path !== ":memory:") db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/** 8.2: whether the bundled SQLite can serve part-text FTS (the fallback is LIKE over parts). */
export function hasFts5(db: Database): boolean {
  try {
    db.exec("CREATE VIRTUAL TABLE temp._fts5_probe USING fts5(x)");
    db.exec("DROP TABLE temp._fts5_probe");
    return true;
  } catch {
    return false;
  }
}
