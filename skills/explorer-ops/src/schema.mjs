/** Journal of Explorer runs and challenges. SQLite is canonical. */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ops_runs (
  run_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  namespace TEXT,
  phase TEXT NOT NULL,
  status TEXT NOT NULL,
  logical_repos TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT,
  code TEXT NOT NULL,
  detail TEXT NOT NULL,
  how_we_attacked TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ops_runs_ns ON ops_runs(namespace, created_at);
CREATE INDEX IF NOT EXISTS idx_ops_challenges_code ON ops_challenges(code);
`;
