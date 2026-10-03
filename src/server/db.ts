import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Bump when the schema or derived-data logic changes; the index is rebuilt
// from the transcripts (it holds no data that can't be re-derived).
export const SCHEMA_VERSION = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,           -- relative to the Claude dir
  kind TEXT NOT NULL,              -- 'transcript' | 'subagent'
  session_id TEXT NOT NULL,
  agent_id TEXT,
  ino INTEGER, size INTEGER, mtime_ms INTEGER,
  offset INTEGER NOT NULL DEFAULT 0,
  last_ts TEXT,
  missing INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  project_dir TEXT NOT NULL,
  transcript_path TEXT NOT NULL,
  cwd TEXT, git_branch TEXT, version TEXT,
  ai_title TEXT, agent_name TEXT, first_prompt TEXT, last_prompt TEXT,
  leaf_uuid TEXT, permission_mode TEXT,
  models TEXT NOT NULL DEFAULT '[]',
  first_ts TEXT, last_ts TEXT,
  cost_cli REAL, cost_est REAL NOT NULL DEFAULT 0,
  record_count INTEGER NOT NULL DEFAULT 0,
  request_count INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 0,
  error_count INTEGER NOT NULL DEFAULT 0,
  has_transcript INTEGER NOT NULL DEFAULT 1,
  mtime_ms INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_last ON sessions(last_ts);

CREATE TABLE IF NOT EXISTS subagents (
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  agent_type TEXT, description TEXT, tool_use_id TEXT,
  file_path TEXT,
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  file_path TEXT NOT NULL,
  offset INTEGER NOT NULL,
  length INTEGER NOT NULL,
  uuid TEXT, parent_uuid TEXT, logical_parent_uuid TEXT,
  type TEXT NOT NULL, subtype TEXT,
  ts TEXT,
  is_sidechain INTEGER NOT NULL DEFAULT 0,
  is_meta INTEGER NOT NULL DEFAULT 0,
  is_prompt INTEGER NOT NULL DEFAULT 0,
  request_id TEXT, tool_use_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  content_bytes INTEGER NOT NULL DEFAULT 0,
  extra TEXT
);
CREATE INDEX IF NOT EXISTS records_session ON records(session_id, id);
CREATE INDEX IF NOT EXISTS records_file ON records(file_path);

CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_key TEXT NOT NULL DEFAULT '',
  request_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  model TEXT, effort TEXT, speed TEXT,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0,
  thinking INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0,
  cw5m INTEGER NOT NULL DEFAULT 0, cw1h INTEGER NOT NULL DEFAULT 0,
  stop_reason TEXT, ts TEXT, end_ts TEXT, latency_ms INTEGER,
  cost REAL,
  first_record_id INTEGER NOT NULL,
  last_record_id INTEGER NOT NULL,
  block_count INTEGER NOT NULL DEFAULT 0,
  tool_use_count INTEGER NOT NULL DEFAULT 0,
  is_error INTEGER NOT NULL DEFAULT 0,
  UNIQUE (session_id, agent_key, request_id)
);
CREATE INDEX IF NOT EXISTS requests_file ON requests(file_path);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  agent_id TEXT,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL, mcp_server TEXT, input_summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', denial_kind TEXT,
  start_ts TEXT, end_ts TEXT,
  use_record_id INTEGER, result_record_id INTEGER,
  request_id TEXT,
  persisted_output TEXT,
  UNIQUE (session_id, tool_use_id)
);
CREATE INDEX IF NOT EXISTS tool_calls_file ON tool_calls(file_path);

CREATE TABLE IF NOT EXISTS hooks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  agent_id TEXT,
  file_path TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  ts TEXT, hook_name TEXT NOT NULL, hook_event TEXT, command TEXT,
  exit_code INTEGER, duration_ms INTEGER, ok INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS hooks_session ON hooks(session_id, id);
CREATE INDEX IF NOT EXISTS hooks_file ON hooks(file_path);

-- Cross-session insights. Both tables are caches over the rest of the index
-- (R10): dropping them costs time, never data.

CREATE TABLE IF NOT EXISTS session_aggregates (
  session_id TEXT PRIMARY KEY,
  payload_version INTEGER NOT NULL,
  -- The session's record_count when this was computed. Transcripts are
  -- append-only, so a changed count is the only thing that can invalidate it.
  fingerprint INTEGER NOT NULL,
  computed_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS insight_cache (
  key TEXT PRIMARY KEY,
  computed_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
`;

export type DB = Database.Database;

export function openDb(dataDir: string, filename = 'index.sqlite'): DB {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, filename);
  let db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
  if (row && Number(row.value) !== SCHEMA_VERSION) {
    // Derived data only: drop and rebuild rather than migrate.
    db.close();
    for (const suffix of ['', '-wal', '-shm']) fs.rmSync(file + suffix, { force: true });
    db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  db.exec(SCHEMA);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  return db;
}

export function openMemoryDb(): DB {
  const db = new Database(':memory:');
  db.exec(SCHEMA);
  return db;
}
