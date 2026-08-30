/** SQL DDL for the Descobrir document store. */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS l0_candidate_packages (
  candidate_id TEXT PRIMARY KEY,
  namespace TEXT NOT NULL,
  logical_repo TEXT NOT NULL,
  source_revision TEXT NOT NULL,
  canonical_graph_hash TEXT NOT NULL,
  package_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (namespace, logical_repo, source_revision, canonical_graph_hash)
);

CREATE TABLE IF NOT EXISTS l0_accepted_baselines (
  namespace TEXT NOT NULL,
  logical_repo TEXT NOT NULL,
  candidate_id TEXT NOT NULL REFERENCES l0_candidate_packages(candidate_id),
  approver TEXT NOT NULL,
  accepted_at TEXT NOT NULL,
  PRIMARY KEY (namespace, logical_repo)
);

CREATE INDEX IF NOT EXISTS idx_l0_candidates_ns_repo
  ON l0_candidate_packages (namespace, logical_repo);
`;

/**
 * @param {object} pkg
 * @returns {string}
 */
export function candidateIdFor(pkg) {
  const hash = pkg.graph_index.canonical_graph_hash;
  return `candidate:${pkg.namespace}:${pkg.logical_repo}:${pkg.source_revision}:${hash}`;
}
