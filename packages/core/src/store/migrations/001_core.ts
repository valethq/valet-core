import type { Database } from "bun:sqlite";

/** 8.2 core schema, verbatim. */
export function up(db: Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  workspace_dir TEXT NOT NULL,
  settings TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT, color TEXT,
  parent_session_id TEXT REFERENCES sessions(id),
  status TEXT NOT NULL DEFAULT 'idle',
  settings TEXT NOT NULL DEFAULT '{}',
  provider_state TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_message_at INTEGER
);
CREATE TABLE IF NOT EXISTS session_bindings (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL, conversation_id TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (platform, conversation_id)
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  trigger_message_id TEXT, status TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT, model TEXT, usage TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER, ended_at INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  author_principal_id TEXT REFERENCES principals(id),
  run_id TEXT REFERENCES runs(id),
  status TEXT NOT NULL,
  origin TEXT,
  meta TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (session_id, seq)
);
CREATE TABLE IF NOT EXISTS parts (
  id TEXT PRIMARY KEY, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL, type TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (message_id, idx)
);
CREATE TABLE IF NOT EXISTS principals (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, role TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS identities (
  platform TEXT NOT NULL, external_id TEXT NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id), PRIMARY KEY (platform, external_id)
);
CREATE TABLE IF NOT EXISTS blobs (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, mime TEXT, size INTEGER NOT NULL, name TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS plugin_kv (plugin TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (plugin, key));
CREATE INDEX IF NOT EXISTS messages_session ON messages(session_id, seq);
CREATE INDEX IF NOT EXISTS runs_session ON runs(session_id, started_at);
`);
}
