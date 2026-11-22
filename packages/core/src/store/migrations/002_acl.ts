import type { Database } from "bun:sqlite";

/** Run subjects and identity link challenges (ACL). */
export function up(db: Database): void {
  db.exec(`
ALTER TABLE runs ADD COLUMN subject TEXT;
CREATE TABLE IF NOT EXISTS link_challenges (
  code_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES principals(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
`);
}
