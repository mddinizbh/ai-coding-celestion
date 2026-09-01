import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openOpsStore, OpsStoreError } from "../src/store.mjs";
import { createLearningLoopPersistence } from "../src/learning-loop-store.mjs";
import { canonicalizeSignal, makeGapKey } from "../../explorer-audit/src/canonical-observation.mjs";

function persistedObservation(overrides = {}) {
  const canonical = canonicalizeSignal({
    capability: "cross-repo-http",
    fields: {
      from_logical_repo: "checkout",
      to_contract_key: overrides.to_contract_key ?? "GET /invoices/{param}",
    },
  });
  const base = {
    run_id: "run-1",
    observation_id: "obs-1",
    capability: "cross-repo-http",
    signal_key: canonical.signal_key,
    target_signature: canonical.target_signature,
    logical_repo: "checkout",
    relative_file: "src/Client.kt",
    source_anchor: "Client#fetch",
    source_revision: "rev-1",
    line: 10,
    evidence_snippet: "RestTemplate.getForObject",
    coverage_classification: "POSSIBLE_OMISSION",
    confirmation_status: "AUTO_CONFIRMED",
    gap_reason: "missing-frontier-fact",
    gap_scope: {namespace: "ns", logical_repos: ["checkout"]},
    observed_at: "2026-09-01T10:00:00.000Z",
  };
  const merged = Object.assign({}, base, overrides, {signal_key: canonical.signal_key, target_signature: canonical.target_signature});
  if (merged.confirmation_status === "AUTO_CONFIRMED" || merged.confirmation_status === "HUMAN_CONFIRMED") {
    merged.gap_key = makeGapKey({reason: merged.gap_reason, scope: merged.gap_scope, capability: merged.capability, target_signature: merged.target_signature});
  }
  return merged;
}

function seedTwoRunsForOneGap(store, persistence) {
  store.log({run_id: "run-1", namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"]});
  store.log({run_id: "run-2", namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"]});
  const first = persistedObservation({run_id: "run-1", observation_id: "obs-1", source_revision: "rev-1", observed_at: "2026-09-01T10:00:00.000Z"});
  const second = persistedObservation({run_id: "run-2", observation_id: "obs-2", source_revision: "rev-2", observed_at: "2026-09-01T11:00:00.000Z"});
  persistence.insertOrCompareObservation(first);
  persistence.insertOrCompareObservation(second);
  persistence.ensureCoverageGap({gap_key: first.gap_key, reason: first.gap_reason, scope: first.gap_scope, capability: first.capability, target_signature: first.target_signature, observed_at: first.observed_at});
  persistence.insertGapOccurrence({run_id: first.run_id, gap_key: first.gap_key, observation_id: first.observation_id, source_revision: first.source_revision, observed_at: first.observed_at});
  persistence.insertGapOccurrence({run_id: second.run_id, gap_key: second.gap_key, observation_id: second.observation_id, source_revision: second.source_revision, observed_at: second.observed_at});
  return first.gap_key;
}

test("additive tables created without dropping existing", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  const tables = store._db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  assert.ok(tables.includes("ops_observations"));
  assert.ok(tables.includes("ops_runs"));
  assert.ok(tables.includes("ops_gap_occurrences"));
  assert.ok(tables.includes("ops_coverage_gaps"));
  assert.ok(tables.includes("ops_gap_status_history"));
  store.close();
});

test("same observation payload is idempotent and divergent payload collides", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  store.log({run_id: "run-1", phase: "audit", status: "ok"});
  const persistence = createLearningLoopPersistence(store._db);
  const observation = persistedObservation({run_id: "run-1", observation_id: "obs-1", line: 10});
  assert.equal(persistence.insertOrCompareObservation(observation).created, true);
  assert.equal(persistence.insertOrCompareObservation(observation).created, false);
  assert.throws(
    () => persistence.insertOrCompareObservation(Object.assign({}, observation, {line: 11})),
    OpsStoreError,
  );
  store.close();
});

test("projection is rebuilt only from GapOccurrence", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  const persistence = createLearningLoopPersistence(store._db);
  const gapKey = seedTwoRunsForOneGap(store, persistence);
  persistence.rebuildGapProjection(gapKey);
  const gapRow = store._db.prepare("SELECT first_seen, last_seen, occurrences FROM ops_coverage_gaps WHERE gap_key = ?").get(gapKey);
  assert.deepEqual({...gapRow}, {first_seen: "2026-09-01T10:00:00.000Z", last_seen: "2026-09-01T11:00:00.000Z", occurrences: 2});
  store.close();
});

test("primitives compose inside caller-owned transaction and rollback removes rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  store.log({run_id: "run-tx", phase: "audit", status: "ok"});
  const persistence = createLearningLoopPersistence(store._db);
  const obs = persistedObservation({run_id: "run-tx", observation_id: "obs-tx", observed_at: "2026-09-01T12:00:00.000Z"});
  store._db.exec("BEGIN IMMEDIATE");
  try {
    assert.equal(persistence.insertOrCompareObservation(obs).created, true);
    const gapKey = makeGapKey({reason: obs.gap_reason, scope: obs.gap_scope, capability: obs.capability, target_signature: obs.target_signature});
    persistence.ensureCoverageGap({gap_key: gapKey, reason: obs.gap_reason, scope: obs.gap_scope, capability: obs.capability, target_signature: obs.target_signature, observed_at: obs.observed_at});
    persistence.insertGapOccurrence({run_id: obs.run_id, gap_key: gapKey, observation_id: obs.observation_id, source_revision: obs.source_revision, observed_at: obs.observed_at});
    const before = store._db.prepare("SELECT COUNT(*) as c FROM ops_observations WHERE run_id = 'run-tx'").get().c;
    assert.equal(before, 1);
    store._db.exec("ROLLBACK");
    const after = store._db.prepare("SELECT COUNT(*) as c FROM ops_observations WHERE run_id = 'run-tx'").get().c;
    assert.equal(after, 0);
  } finally {
    store.close();
  }
});

test("divergent insertOrCompareRun throws OpsStoreError not SQLite error", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  const persistence = createLearningLoopPersistence(store._db);
  const run1 = {run_id: "run-div", namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"], source_revision: "rev-a", started_at: "2026-09-01T09:00:00.000Z"};
  assert.equal(persistence.insertOrCompareRun(run1).created, true);
  assert.throws(
    () => persistence.insertOrCompareRun({...run1, source_revision: "rev-b"}),
    OpsStoreError,
  );
  store.close();
});

test("missing deterministic timestamps are rejected with OpsStoreError", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  const persistence = createLearningLoopPersistence(store._db);
  assert.throws(() => persistence.insertOrCompareRun({run_id: "r1", phase: "p", status: "ok", started_at: ""}), OpsStoreError);
  const obs = persistedObservation({run_id: "r1", observation_id: "o1"});
  delete obs.observed_at;
  assert.throws(() => persistence.insertOrCompareObservation(obs), OpsStoreError);
  store.close();
});
