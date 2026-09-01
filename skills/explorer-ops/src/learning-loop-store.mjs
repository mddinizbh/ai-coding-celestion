/**
 * Private learning-loop persistence primitives.
 * Additive only. No public lifecycle or CLI exposure (Task 4 responsibility).
 */
import { OpsStoreError } from "./store.mjs";
import { stableStringify } from "../../explorer-l0/src/stable-json.mjs";
import { sha256Text } from "../../explorer-l0/src/stable-json.mjs";
import { makeGapKey } from "../../explorer-audit/src/canonical-observation.mjs";

export function createLearningLoopPersistence(db) {
  if (!db || typeof db.prepare !== "function") {
    throw new OpsStoreError("db must be a DatabaseSync instance");
  }

  function insertOrCompareRun(rec) {
    const {
      run_id,
      namespace,
      phase,
      status,
      logical_repos,
      source_revision,
      started_at,
    } = rec;
    if (typeof run_id !== "string" || run_id === "") {
      throw new OpsStoreError("run_id is required");
    }
    if (typeof phase !== "string" || phase === "") {
      throw new OpsStoreError("phase is required");
    }
    if (typeof status !== "string" || status === "") {
      throw new OpsStoreError("status is required");
    }
    if (typeof started_at !== "string" || started_at === "") {
      throw new OpsStoreError("started_at is required for deterministic retry identity");
    }
    const detail_json = stableStringify({ source_revision: source_revision ?? null });
    const logical_repos_json = logical_repos ? JSON.stringify(logical_repos) : null;
    const existing = db.prepare(
      "SELECT namespace, phase, status, logical_repos, detail_json, started_at FROM ops_runs WHERE run_id = ?",
    ).get(run_id);
    if (existing) {
      const match =
        existing.namespace === (namespace ?? null) &&
        existing.phase === phase &&
        existing.status === status &&
        existing.logical_repos === logical_repos_json &&
        existing.detail_json === detail_json &&
        existing.started_at === started_at;
      if (match) {
        return { created: false };
      }
      throw new OpsStoreError(`divergent run for ${run_id}`);
    }
    db.prepare(
      `INSERT INTO ops_runs (run_id, started_at, namespace, phase, status, logical_repos, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(run_id, started_at, namespace ?? null, phase, status, logical_repos_json, detail_json, started_at);
    return { created: true };
  }

  function insertOrCompareObservation(observation) {
    const isConfirmed =
      observation.confirmation_status === "AUTO_CONFIRMED" ||
      observation.confirmation_status === "HUMAN_CONFIRMED";
    if (isConfirmed) {
      if (!observation.gap_reason || !observation.gap_scope || !observation.gap_key) {
        throw new OpsStoreError("gap_reason, gap_scope and gap_key are required for AUTO_CONFIRMED/HUMAN_CONFIRMED");
      }
    }
    const signal_key_json = stableStringify(observation.signal_key);
    const gap_scope_json = observation.gap_scope ? stableStringify(observation.gap_scope) : null;
    const payloadObj = {
      run_id: observation.run_id,
      observation_id: observation.observation_id,
      capability: observation.capability,
      signal_key: observation.signal_key,
      target_signature: observation.target_signature,
      logical_repo: observation.logical_repo,
      relative_file: observation.relative_file,
      source_anchor: observation.source_anchor,
      source_revision: observation.source_revision,
      line: observation.line,
      evidence_snippet: observation.evidence_snippet,
      coverage_classification: observation.coverage_classification,
      confirmation_status: observation.confirmation_status,
      gap_reason: observation.gap_reason ?? null,
      gap_scope: observation.gap_scope ?? null,
      gap_key: observation.gap_key ?? null,
    };
    if (typeof observation.observed_at !== "string" || observation.observed_at === "") {
      throw new OpsStoreError("observed_at is required for deterministic retry identity");
    }
    const canonical_payload_json = stableStringify(payloadObj);
    const canonical_payload_hash = sha256Text(canonical_payload_json);
    const existing = db
      .prepare("SELECT canonical_payload_json FROM ops_observations WHERE run_id = ? AND observation_id = ?")
      .get(observation.run_id, observation.observation_id);
    if (existing) {
      if (existing.canonical_payload_json === canonical_payload_json) {
        return { created: false };
      }
      throw new OpsStoreError(`divergent observation payload for ${observation.run_id}/${observation.observation_id}`);
    }
    db.prepare(
      `INSERT INTO ops_observations (
        run_id, observation_id, capability, signal_key_json, target_signature,
        logical_repo, relative_file, source_anchor, source_revision, line,
        evidence_snippet, coverage_classification, confirmation_status,
        gap_reason, gap_scope_json, gap_key,
        canonical_payload_json, canonical_payload_hash, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      observation.run_id,
      observation.observation_id,
      observation.capability,
      signal_key_json,
      observation.target_signature,
      observation.logical_repo,
      observation.relative_file,
      observation.source_anchor,
      observation.source_revision,
      observation.line,
      observation.evidence_snippet,
      observation.coverage_classification,
      observation.confirmation_status,
      observation.gap_reason ?? null,
      gap_scope_json,
      observation.gap_key ?? null,
      canonical_payload_json,
      canonical_payload_hash,
      observation.observed_at,
    );
    return { created: true };
  }

  function ensureCoverageGap({ gap_key, reason, scope, capability, target_signature, observed_at }) {
    if (typeof observed_at !== "string" || observed_at === "") {
      throw new OpsStoreError("observed_at is required for deterministic retry identity");
    }
    const computed = makeGapKey({ reason, scope, capability, target_signature });
    if (computed !== gap_key) {
      throw new OpsStoreError("gap_key does not match recomputed value");
    }
    const scope_json = stableStringify(scope);
    db.prepare(
      `INSERT OR IGNORE INTO ops_coverage_gaps (
        gap_key, reason, scope_json, capability, target_signature, status,
        first_seen, last_seen, occurrences, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ).run(gap_key, reason, scope_json, capability, target_signature, "open", observed_at, observed_at, 0, observed_at);
  }

  function insertGapOccurrence({ run_id, gap_key, observation_id, source_revision, observed_at }) {
    if (typeof observed_at !== "string" || observed_at === "") {
      throw new OpsStoreError("observed_at is required for deterministic retry identity");
    }
    const info = db
      .prepare(
        `INSERT OR IGNORE INTO ops_gap_occurrences (run_id, gap_key, observation_id, source_revision, observed_at)
         VALUES (?,?,?,?,?)`,
      )
      .run(run_id, gap_key, observation_id, source_revision, observed_at);
    return { created: info.changes > 0 };
  }

  function rebuildGapProjection(gap_key) {
    const occs = db
      .prepare("SELECT observed_at FROM ops_gap_occurrences WHERE gap_key = ? ORDER BY observed_at ASC")
      .all(gap_key);
    if (occs.length === 0) {
      return;
    }
    const first_seen = occs[0].observed_at;
    const last_seen = occs[occs.length - 1].observed_at;
    const occurrences = occs.length;
    db.prepare(
      "UPDATE ops_coverage_gaps SET first_seen = ?, last_seen = ?, occurrences = ? WHERE gap_key = ?",
    ).run(first_seen, last_seen, occurrences, gap_key);
  }

  function appendGapHistory({
    gap_key,
    run_id,
    from_status,
    to_status,
    source_revision,
    transition_reason,
    evidence_ref,
    created_at,
  }) {
    if (typeof created_at !== "string" || created_at === "") {
      throw new OpsStoreError("created_at is required for deterministic retry identity");
    }
    db.prepare(
      `INSERT INTO ops_gap_status_history (
        gap_key, run_id, from_status, to_status, source_revision, transition_reason, evidence_ref, created_at
      ) VALUES (?,?,?,?,?,?,?,?)`,
    ).run(gap_key, run_id ?? null, from_status ?? null, to_status, source_revision ?? null, transition_reason, evidence_ref ?? null, created_at);
  }

  function markAffectedGapsStale({ run_id, scope, source_revision, observed_at }) {
    if (typeof observed_at !== "string" || observed_at === "") {
      throw new OpsStoreError("observed_at is required for deterministic retry identity");
    }
    const scope_json = stableStringify(scope);
    const gaps = db
      .prepare("SELECT gap_key, status FROM ops_coverage_gaps WHERE scope_json = ? AND status = 'open'")
      .all(scope_json);
    for (const g of gaps) {
      db.prepare("UPDATE ops_coverage_gaps SET status = 'stale' WHERE gap_key = ?").run(g.gap_key);
      appendGapHistory({
        gap_key: g.gap_key,
        run_id,
        from_status: "open",
        to_status: "stale",
        source_revision,
        transition_reason: "revision-superseded",
        evidence_ref: null,
        created_at: observed_at,
      });
    }
  }

  function getCoverageGap(gap_key) {
    return db.prepare("SELECT * FROM ops_coverage_gaps WHERE gap_key = ?").get(gap_key) || null;
  }

  function updateGapStatus({ gap_key, expected_statuses, to_status, created_at }) {
    const current = getCoverageGap(gap_key);
    if (!current || !expected_statuses.includes(current.status)) {
      throw new OpsStoreError("unexpected status");
    }
    if (typeof created_at !== "string" || created_at === "") {
      throw new OpsStoreError("created_at is required for deterministic retry identity");
    }
    db.prepare("UPDATE ops_coverage_gaps SET status = ? WHERE gap_key = ?").run(to_status, gap_key);
    appendGapHistory({
      gap_key,
      run_id: null,
      from_status: current.status,
      to_status,
      source_revision: null,
      transition_reason: "manual-update",
      evidence_ref: null,
      created_at,
    });
  }

  function listContextGaps({ scope, limit = 50 }) {
    const scope_json = stableStringify(scope);
    return db
      .prepare("SELECT * FROM ops_coverage_gaps WHERE scope_json = ? ORDER BY last_seen DESC LIMIT ?")
      .all(scope_json, limit);
  }

  return {
    insertOrCompareRun,
    insertOrCompareObservation,
    ensureCoverageGap,
    insertGapOccurrence,
    rebuildGapProjection,
    appendGapHistory,
    markAffectedGapsStale,
    getCoverageGap,
    updateGapStatus,
    listContextGaps,
  };
}
