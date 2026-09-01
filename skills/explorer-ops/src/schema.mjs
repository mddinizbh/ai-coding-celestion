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

CREATE TABLE IF NOT EXISTS ops_observations (
  run_id TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  capability TEXT NOT NULL CHECK (capability IN ('java-call','spring-controller','spring-feign','cross-repo-http','kafka','intentional-omission')),
  signal_key_json TEXT NOT NULL,
  target_signature TEXT NOT NULL,
  logical_repo TEXT NOT NULL,
  relative_file TEXT NOT NULL,
  source_anchor TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  line INTEGER NOT NULL,
  evidence_snippet TEXT NOT NULL,
  coverage_classification TEXT NOT NULL CHECK (coverage_classification IN ('COVERED','MAYBE_COVERED','POSSIBLE_OMISSION','UNKNOWN')),
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('NOT_APPLICABLE','AUTO_CONFIRMED','NEEDS_REVIEW','HUMAN_CONFIRMED','REJECTED')),
  gap_reason TEXT,
  gap_scope_json TEXT,
  gap_key TEXT,
  canonical_payload_json TEXT NOT NULL,
  canonical_payload_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, observation_id),
  FOREIGN KEY (run_id) REFERENCES ops_runs(run_id)
);

CREATE TABLE IF NOT EXISTS ops_coverage_gaps (
  gap_key TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  capability TEXT NOT NULL,
  target_signature TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','stale','resolved','superseded')),
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  occurrences INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ops_gap_occurrences (
  run_id TEXT NOT NULL,
  gap_key TEXT NOT NULL,
  observation_id TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (run_id, gap_key),
  FOREIGN KEY (run_id, observation_id)
    REFERENCES ops_observations(run_id, observation_id),
  FOREIGN KEY (gap_key) REFERENCES ops_coverage_gaps(gap_key)
);

CREATE TABLE IF NOT EXISTS ops_gap_status_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  gap_key TEXT NOT NULL,
  run_id TEXT,
  from_status TEXT CHECK (from_status IS NULL OR from_status IN ('open','stale','resolved','superseded')),
  to_status TEXT NOT NULL CHECK (to_status IN ('open','stale','resolved','superseded')),
  source_revision TEXT,
  transition_reason TEXT NOT NULL,
  evidence_ref TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (gap_key) REFERENCES ops_coverage_gaps(gap_key),
  FOREIGN KEY (run_id) REFERENCES ops_runs(run_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_observations_gap ON ops_observations(gap_key);
CREATE INDEX IF NOT EXISTS idx_ops_gap_occurrences_gap ON ops_gap_occurrences(gap_key);
CREATE INDEX IF NOT EXISTS idx_ops_coverage_gaps_status ON ops_coverage_gaps(status);
`;
