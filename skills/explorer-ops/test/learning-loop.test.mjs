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

// Task 4 builders (exact from brief)
function makeStore() {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-api-"));
  return openOpsStore(join(dir, "ops.sqlite"));
}

function reviewObservation(overrides = {}) {
  return persistedObservation(Object.assign({gap_reason: undefined, gap_scope: undefined, gap_key: undefined, coverage_classification: "MAYBE_COVERED", confirmation_status: "NEEDS_REVIEW"}, overrides));
}

function coveredObservation(overrides = {}) {
  return persistedObservation(Object.assign({observation_id: "obs-covered", gap_reason: undefined, gap_scope: undefined, gap_key: undefined, coverage_classification: "COVERED", confirmation_status: "NOT_APPLICABLE"}, overrides));
}

function confirmedObservation(overrides = {}) {
  return persistedObservation(Object.assign({coverage_classification: "POSSIBLE_OMISSION", confirmation_status: "AUTO_CONFIRMED"}, overrides));
}

function outcomeInput(overrides = {}) {
  const run_id = overrides.run_id ?? "run-1";
  return {
    run: {run_id, namespace: "ns", phase: "audit", status: "ok", logical_repos: ["checkout"], source_revision: overrides.source_revision ?? "rev-1", started_at: overrides.started_at ?? "2026-09-01T10:00:00.000Z"},
    observations: overrides.observations ?? [],
  };
}

function seededOpenGapStore() {
  const store = makeStore();
  const observation = confirmedObservation();
  store.recordOutcome(outcomeInput({observations: [observation]}));
  return {store, gap_key: observation.gap_key};
}

function seededContextStore(count) {
  const store = makeStore();
  const observations = Array.from({length: count}, (_, index) => confirmedObservation({
    observation_id: `obs-${index}`,
    to_contract_key: `GET /invoices/${index}`,
    source_anchor: `Client#fetch${index}`,
  }));
  store.recordOutcome(outcomeInput({observations}));
  return store;
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

// Task 4 tests (failing RED before impl)
test("recordOutcome reuses identical retry without a second occurrence", () => {
  const store = makeStore();
  const input = outcomeInput({run_id: "run-1", observations: [confirmedObservation({observation_id: "obs-1"})]});
  const first = store.recordOutcome(input);
  const retry = store.recordOutcome(input);
  assert.equal(first.gap_occurrences_created, 1);
  assert.equal(retry.gap_occurrences_created, 0);
  assert.equal(store._db.prepare("SELECT COUNT(*) AS n FROM ops_gap_occurrences").get().n, 1);
  store.close();
});

test("divergent retry rolls back every row from that call", () => {
  const store = makeStore();
  store.recordOutcome(outcomeInput({run_id: "run-1", observations: [reviewObservation({observation_id: "obs-1", line: 10})]}));
  assert.throws(
    () => store.recordOutcome(outcomeInput({run_id: "run-1", observations: [reviewObservation({observation_id: "obs-1", line: 11}), reviewObservation({observation_id: "obs-2", line: 20})]})),
    OpsStoreError,
  );
  assert.equal(store._db.prepare("SELECT COUNT(*) AS n FROM ops_observations").get().n, 1);
  store.close();
});

test("only automatic or human confirmation creates gaps", () => {
  const store = makeStore();
  const confirmed = confirmedObservation({observation_id: "obs-auto"});
  store.recordOutcome(outcomeInput({run_id: "run-1", observations: [coveredObservation(), reviewObservation({observation_id: "obs-review", line: 8}), confirmed]}));
  const keys = store._db.prepare("SELECT gap_key FROM ops_coverage_gaps ORDER BY gap_key").all().map((row) => row.gap_key);
  assert.deepEqual(keys, [confirmed.gap_key]);
  store.close();
});

test("resolveGap rejects closure without evidence or human decision", () => {
  const {store, gap_key} = seededOpenGapStore();
  assert.throws(() => store.resolveGap({gap_key, resolution: "resolved"}), OpsStoreError);
  assert.equal(store.resolveGap({gap_key, resolution: "resolved", accepted_evidence_ref: "src/Client.kt#Client.call"}).status, "resolved");
  store.close();
});

test("loadContext returns a bounded open and stale summary", () => {
  const store = seededContextStore(60);
  const result = store.loadContext({scope: {namespace: "ns", logical_repos: ["checkout"]}, objective: "audit coverage", limit: 50});
  assert.equal(result.gaps.length, 50);
  assert.ok(result.gaps.every((gap) => gap.status === "open" || gap.status === "stale"));
  assert.equal(Object.hasOwn(result, "history"), false);
  store.close();
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

test("updateGapStatus uses exact brief signature and performs status update only (no history)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ops-loop-"));
  const store = openOpsStore(join(dir, "ops.sqlite"));
  const persistence = createLearningLoopPersistence(store._db);
  // seed a gap via ensure + occurrence (Task 4 path)
  store.log({run_id: "run-us", phase: "audit", status: "ok"});
  const obs = persistedObservation({run_id: "run-us", observation_id: "obs-us", observed_at: "2026-09-01T13:00:00.000Z"});
  persistence.insertOrCompareObservation(obs);
  const gapKey = obs.gap_key;
  persistence.ensureCoverageGap({gap_key: gapKey, reason: obs.gap_reason, scope: obs.gap_scope, capability: obs.capability, target_signature: obs.target_signature, observed_at: obs.observed_at});
  persistence.insertGapOccurrence({run_id: obs.run_id, gap_key: gapKey, observation_id: obs.observation_id, source_revision: obs.source_revision, observed_at: obs.observed_at});
  // initial status open
  const before = persistence.getCoverageGap(gapKey);
  assert.equal(before.status, "open");
  const histBefore = store._db.prepare("SELECT COUNT(*) as c FROM ops_gap_status_history WHERE gap_key = ?").get(gapKey).c;
  // exact 3-field call per brief
  persistence.updateGapStatus({gap_key: gapKey, expected_statuses: ["open"], to_status: "stale"});
  const after = persistence.getCoverageGap(gapKey);
  assert.equal(after.status, "stale");
  const histAfter = store._db.prepare("SELECT COUNT(*) as c FROM ops_gap_status_history WHERE gap_key = ?").get(gapKey).c;
  assert.equal(histAfter, histBefore); // no history row added by primitive
  store.close();
});

// Task 4 Fix Round 1/5 - complete state/limit/closure/identity matrix
test("recordOutcome rejects observation/run identity mismatch before any write", () => {
  const store = makeStore();
  const badObs = confirmedObservation({observation_id: "obs-mismatch", run_id: "run-other", source_revision: "rev-x"});
  assert.throws(() => store.recordOutcome(outcomeInput({run_id: "run-1", observations: [badObs]})), OpsStoreError);
  assert.equal(store._db.prepare("SELECT COUNT(*) AS n FROM ops_observations").get().n, 0);
  store.close();
});

test("new confirmed observation creates open gap", () => {
  const store = makeStore();
  const obs = confirmedObservation({observation_id: "obs-new", run_id: "run-new", source_revision: "rev-new", started_at: "2026-09-01T11:00:00.000Z"});
  const res = store.recordOutcome(outcomeInput({run_id: "run-new", source_revision: "rev-new", started_at: "2026-09-01T11:00:00.000Z", observations: [obs]}));
  assert.equal(res.gap_occurrences_created, 1);
  const gap = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(obs.gap_key);
  assert.equal(gap.status, "open");
  store.close();
});

test("new revision without occurrence marks affected gap stale (does not resolve)", () => {
  const {store, gap_key} = seededOpenGapStore();
  // new run with different revision, no occurrence for the gap
  const res = store.recordOutcome(outcomeInput({run_id: "run-stale", source_revision: "rev-stale", started_at: "2026-09-01T12:00:00.000Z", observations: []}));
  const gap = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(gap_key);
  assert.equal(gap.status, "stale");
  store.close();
});

test("confirmed recurrence reopens stale gap with history", () => {
  const store = makeStore();
  const obs = confirmedObservation({observation_id: "obs-s1", run_id: "run-s1", source_revision: "rev-s1", started_at: "2026-09-01T09:00:00.000Z"});
  store.recordOutcome(outcomeInput({run_id: "run-s1", source_revision: "rev-s1", started_at: "2026-09-01T09:00:00.000Z", observations: [obs]}));
  // force stale via new-rev run with no occurrence
  store.recordOutcome(outcomeInput({run_id: "run-s2", source_revision: "rev-s2", started_at: "2026-09-01T10:00:00.000Z", observations: []}));
  const gapBefore = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(obs.gap_key);
  assert.equal(gapBefore.status, "stale");
  // new confirmed occurrence reopens
  const rec = confirmedObservation({observation_id: "obs-s3", run_id: "run-s3", source_revision: "rev-s3", started_at: "2026-09-01T11:00:00.000Z", gap_key: obs.gap_key});
  store.recordOutcome(outcomeInput({run_id: "run-s3", source_revision: "rev-s3", started_at: "2026-09-01T11:00:00.000Z", observations: [rec]}));
  const gapAfter = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(obs.gap_key);
  assert.equal(gapAfter.status, "open");
  const hist = store._db.prepare("SELECT from_status, to_status FROM ops_gap_status_history WHERE gap_key = ? ORDER BY id DESC LIMIT 1").get(obs.gap_key);
  assert.deepEqual({from_status: hist.from_status, to_status: hist.to_status}, {from_status: "stale", to_status: "open"});
  store.close();
});

test("confirmed recurrence reopens resolved gap with history", () => {
  const store = makeStore();
  const obs = confirmedObservation({observation_id: "obs-r1", run_id: "run-r1", source_revision: "rev-r1", started_at: "2026-09-01T09:00:00.000Z"});
  store.recordOutcome(outcomeInput({run_id: "run-r1", source_revision: "rev-r1", started_at: "2026-09-01T09:00:00.000Z", observations: [obs]}));
  store.resolveGap({gap_key: obs.gap_key, resolution: "resolved", accepted_evidence_ref: "src/Client.kt#Client.call"});
  const gapBefore = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(obs.gap_key);
  assert.equal(gapBefore.status, "resolved");
  const rec = confirmedObservation({observation_id: "obs-r2", run_id: "run-r2", source_revision: "rev-r2", started_at: "2026-09-01T12:00:00.000Z", gap_key: obs.gap_key});
  store.recordOutcome(outcomeInput({run_id: "run-r2", source_revision: "rev-r2", started_at: "2026-09-01T12:00:00.000Z", observations: [rec]}));
  const gapAfter = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(obs.gap_key);
  assert.equal(gapAfter.status, "open");
  const hist = store._db.prepare("SELECT from_status, to_status FROM ops_gap_status_history WHERE gap_key = ? ORDER BY id DESC LIMIT 1").get(obs.gap_key);
  assert.deepEqual({from_status: hist.from_status, to_status: hist.to_status}, {from_status: "resolved", to_status: "open"});
  store.close();
});

test("confirmed recurrence reopens superseded gap with history", () => {
  const store = makeStore();
  const obs = confirmedObservation({observation_id: "obs-u1", run_id: "run-u1", source_revision: "rev-u1", started_at: "2026-09-01T09:00:00.000Z"});
  store.recordOutcome(outcomeInput({run_id: "run-u1", source_revision: "rev-u1", started_at: "2026-09-01T09:00:00.000Z", observations: [obs]}));
  store.resolveGap({gap_key: obs.gap_key, resolution: "superseded", accepted_evidence_ref: "src/Client.kt#Client.call", replacement_gap_key: "gap-replacement"});
  const gapBefore = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(obs.gap_key);
  assert.equal(gapBefore.status, "superseded");
  const rec = confirmedObservation({observation_id: "obs-u2", run_id: "run-u2", source_revision: "rev-u2", started_at: "2026-09-01T13:00:00.000Z", gap_key: obs.gap_key});
  store.recordOutcome(outcomeInput({run_id: "run-u2", source_revision: "rev-u2", started_at: "2026-09-01T13:00:00.000Z", observations: [rec]}));
  const gapAfter = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(obs.gap_key);
  assert.equal(gapAfter.status, "open");
  const hist = store._db.prepare("SELECT from_status, to_status FROM ops_gap_status_history WHERE gap_key = ? ORDER BY id DESC LIMIT 1").get(obs.gap_key);
  assert.deepEqual({from_status: hist.from_status, to_status: hist.to_status}, {from_status: "superseded", to_status: "open"});
  store.close();
});

test("resolveGap rejects superseded without evidence or human_closure", () => {
  const {store, gap_key} = seededOpenGapStore();
  const before = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(gap_key).status;
  const histBefore = store._db.prepare("SELECT COUNT(*) as c FROM ops_gap_status_history WHERE gap_key = ?").get(gap_key).c;
  assert.throws(() => store.resolveGap({gap_key, resolution: "superseded", replacement_gap_key: "gap-x"}), OpsStoreError);
  const after = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(gap_key).status;
  const histAfter = store._db.prepare("SELECT COUNT(*) as c FROM ops_gap_status_history WHERE gap_key = ?").get(gap_key).c;
  assert.equal(after, before);
  assert.equal(histAfter, histBefore);
  store.close();
});

test("resolveGap rejects superseded without replacement_gap_key", () => {
  const {store, gap_key} = seededOpenGapStore();
  const before = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(gap_key).status;
  const histBefore = store._db.prepare("SELECT COUNT(*) as c FROM ops_gap_status_history WHERE gap_key = ?").get(gap_key).c;
  assert.throws(() => store.resolveGap({gap_key, resolution: "superseded", accepted_evidence_ref: "src/Client.kt#Client.call"}), OpsStoreError);
  const after = store._db.prepare("SELECT status FROM ops_coverage_gaps WHERE gap_key = ?").get(gap_key).status;
  const histAfter = store._db.prepare("SELECT COUNT(*) as c FROM ops_gap_status_history WHERE gap_key = ?").get(gap_key).c;
  assert.equal(after, before);
  assert.equal(histAfter, histBefore);
  store.close();
});

test("resolveGap accepts human_closure for resolved and superseded", () => {
  const store = makeStore();
  const obs1 = confirmedObservation({observation_id: "obs-h1", run_id: "run-h1", source_revision: "rev-h1", started_at: "2026-09-01T09:00:00.000Z"});
  store.recordOutcome(outcomeInput({run_id: "run-h1", source_revision: "rev-h1", started_at: "2026-09-01T09:00:00.000Z", observations: [obs1]}));
  const r1 = store.resolveGap({gap_key: obs1.gap_key, resolution: "resolved", human_closure: {actor: "reviewer", reason: "covered by integration test"}});
  assert.equal(r1.status, "resolved");
  // reopen with matching run/rev for recurrence
  const obs2 = confirmedObservation({observation_id: "obs-h2", run_id: "run-h2", source_revision: "rev-h2", started_at: "2026-09-01T14:00:00.000Z", gap_key: obs1.gap_key});
  store.recordOutcome(outcomeInput({run_id: "run-h2", source_revision: "rev-h2", started_at: "2026-09-01T14:00:00.000Z", observations: [obs2]}));
  const r2 = store.resolveGap({gap_key: obs1.gap_key, resolution: "superseded", human_closure: {actor: "architect", reason: "replaced by new contract"}, replacement_gap_key: "gap-new-contract"});
  assert.equal(r2.status, "superseded");
  store.close();
});

test("resolveGap rejects invalid evidence_ref (absolute, .., no anchor, prose)", () => {
  const {store, gap_key} = seededOpenGapStore();
  assert.throws(() => store.resolveGap({gap_key, resolution: "resolved", accepted_evidence_ref: "/Users/foo/src/Client.kt#call"}), OpsStoreError);
  assert.throws(() => store.resolveGap({gap_key, resolution: "resolved", accepted_evidence_ref: "../src/Client.kt#call"}), OpsStoreError);
  assert.throws(() => store.resolveGap({gap_key, resolution: "resolved", accepted_evidence_ref: "src/Client.kt"}), OpsStoreError);
  assert.throws(() => store.resolveGap({gap_key, resolution: "resolved", accepted_evidence_ref: "just some prose without path"}), OpsStoreError);
  store.close();
});

test("loadContext default 20, rejects <1/non-integer, caps >50 to 50, only open/stale, no history", () => {
  const store = seededContextStore(60);
  // default
  const d = store.loadContext({scope: {namespace: "ns", logical_repos: ["checkout"]}, objective: "audit"});
  assert.equal(d.gaps.length, 20);
  // reject
  assert.throws(() => store.loadContext({scope: {namespace: "ns", logical_repos: ["checkout"]}, objective: "a", limit: 0}), OpsStoreError);
  assert.throws(() => store.loadContext({scope: {namespace: "ns", logical_repos: ["checkout"]}, objective: "a", limit: "foo"}), OpsStoreError);
  // cap
  const c = store.loadContext({scope: {namespace: "ns", logical_repos: ["checkout"]}, objective: "a", limit: 100});
  assert.equal(c.gaps.length, 50);
  // only open/stale + no history key
  assert.ok(c.gaps.every(g => g.status === "open" || g.status === "stale"));
  assert.equal(Object.hasOwn(c, "history"), false);
  store.close();
});
