import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

interface MigrationModule {
  up(db: Database): void;
}

export function ensureMigrationsTable(db: Database): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
}

export function migrationApplied(db: Database, id: string): boolean {
  return db.query("SELECT 1 AS ok FROM schema_migrations WHERE id = ?").get(id) !== null;
}

export function recordMigration(db: Database, id: string): void {
  db.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, Date.now());
}

/**
 * Core migrations: numbered files `NNN_name.ts` in `migrations/`, each exporting
 * `up(db)`. Applied in order, each in a transaction, tracked in schema_migrations.
 * Re-running applies only the pending ones.
 */
export async function runCoreMigrations(
  db: Database,
  dir = join(import.meta.dir, "migrations"),
): Promise<string[]> {
  ensureMigrationsTable(db);
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.+\.ts$/.test(f))
    .sort();
  const applied: string[] = [];
  for (const file of files) {
    const id = file.replace(/\.ts$/, "");
    if (migrationApplied(db, id)) continue;
    const mod = (await import(join(dir, file))) as MigrationModule;
    db.transaction(() => {
      mod.up(db);
      recordMigration(db, id);
    })();
    applied.push(id);
  }
  return applied;
}
