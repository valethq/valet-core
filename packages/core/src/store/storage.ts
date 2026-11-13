import type { Database } from "bun:sqlite";
import type { PluginStorage } from "@valethq/sdk";
import { ensureMigrationsTable, migrationApplied, recordMigration } from "./migrate";

/**
 * Per-plugin storage (8.4). KV rows are namespaced by plugin id, so one plugin's
 * view cannot read another's keys. Plugin tables are a `p_<namespace>_` convention,
 * not a sandbox: `sql.db` is the shared database handle (decision 3).
 */
export function createPluginStorage(db: Database, pluginId: string): PluginStorage {
  return {
    kv: {
      get<T>(key: string): T | undefined {
        const row = db
          .query<{ value: string }, [string, string]>(
            "SELECT value FROM plugin_kv WHERE plugin = ? AND key = ?",
          )
          .get(pluginId, key);
        return row === null ? undefined : (JSON.parse(row.value) as T);
      },
      set(key: string, value: unknown): void {
        db.query(
          `INSERT INTO plugin_kv (plugin, key, value, updated_at) VALUES (?, ?, ?, ?)
           ON CONFLICT (plugin, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        ).run(pluginId, key, JSON.stringify(value), Date.now());
      },
      delete(key: string): void {
        db.query("DELETE FROM plugin_kv WHERE plugin = ? AND key = ?").run(pluginId, key);
      },
      list(prefix = ""): string[] {
        const rows = db
          .query<{ key: string }, [string, string]>(
            "SELECT key FROM plugin_kv WHERE plugin = ? AND key LIKE ? ESCAPE '\\' ORDER BY key",
          )
          .all(pluginId, `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
        return rows.map((r) => r.key);
      },
    },
    sql: {
      /** Plugin migrations run inside schema_migrations under a "plugin:<id>:" prefix. */
      migrate(migrations: { id: string; up: string }[]): void {
        ensureMigrationsTable(db);
        for (const migration of migrations) {
          const id = `plugin:${pluginId}:${migration.id}`;
          if (migrationApplied(db, id)) continue;
          db.transaction(() => {
            db.exec(migration.up);
            recordMigration(db, id);
          })();
        }
      },
      db,
    },
  };
}
