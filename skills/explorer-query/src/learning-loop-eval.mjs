import { mkdtempSync, rmSync, readFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { detectObservations } from "../../explorer-audit/src/detect-observations.mjs";
import { canonicalizeSignal, makeObservationId, makeGapKey } from "../../explorer-audit/src/canonical-observation.mjs";
import { openOpsStore } from "../../explorer-ops/src/store.mjs";
import { createLearningLoopPersistence } from "../../explorer-ops/src/learning-loop-store.mjs";
import { createLearningLoopApi } from "../../explorer-ops/src/learning-loop-api.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "../test/fixtures/learning-loop");

export function ratio(numerator, denominator) {
  return denominator === 0 ? "N/A" : numerator / denominator;
}

export function metricsFromCounts(counts) {
  return {
    edge_precision: ratio(counts.tp_edge, counts.tp_edge + counts.fp_edge),
    edge_recall: ratio(counts.tp_edge, counts.tp_edge + counts.fn_edge),
    omission_precision: ratio(counts.tp_omission, counts.tp_omission + counts.fp_omission),
    omission_recall: ratio(counts.tp_omission, counts.tp_omission + counts.fn_omission),
  };
}

export function assertPerfectGate(metrics) {
  for (const [name, value] of Object.entries(metrics)) {
    if (value !== "N/A" && value !== 1) throw new Error(`${name} expected 1, received ${value}`);
  }
}

function copyAndInitGit(srcDir, destDir) {
  cpSync(srcDir, destDir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: destDir, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: destDir, stdio: "ignore" });
  execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: destDir, stdio: "ignore" });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: destDir, encoding: "utf8" }).trim();
}

function replaceFixtureHead(facts, head) {
  return facts.map(f => {
    if (f.source_revision === "fixture-head") return { ...f, source_revision: head };
    return f;
  });
}

function computePredicted(observation) {
  const isEdge = observation.coverage_classification === "COVERED";
  const status = observation.final_confirmation_status || observation.confirmation_status;
  const isOmission = ["AUTO_CONFIRMED", "HUMAN_CONFIRMED"].includes(status);
  return { isEdge, isOmission };
}

function buildCounts(familyOutcomes, expectedOutcomes) {
  let tp_edge = 0, fp_edge = 0, fn_edge = 0, tp_omission = 0, fp_omission = 0, fn_omission = 0;
  const byAnchor = new Map(expectedOutcomes.map(o => [o.source_anchor, o]));
  for (const obs of familyOutcomes) {
    const exp = byAnchor.get(obs.source_anchor);
    if (!exp) continue;
    const pred = computePredicted(obs);
    if (pred.isEdge && exp.expected_edge) tp_edge++;
    else if (pred.isEdge && !exp.expected_edge) fp_edge++;
    else if (!pred.isEdge && exp.expected_edge) fn_edge++;
    if (pred.isOmission && exp.expected_omission) tp_omission++;
    else if (pred.isOmission && !exp.expected_omission) fp_omission++;
    else if (!pred.isOmission && exp.expected_omission) fn_omission++;
  }
  return { tp_edge, fp_edge, fn_edge, tp_omission, fp_omission, fn_omission };
}

function queryGapOccurrence(db, run_id, gap_key) {
  const row = db.prepare("SELECT 1 FROM ops_gap_occurrences WHERE run_id = ? AND gap_key = ?").get(run_id, gap_key);
  return !!row;
}

export function runFixture(family) {
  const familyDir = join(FIXTURE_ROOT, family);
  const sourceDir = join(familyDir, "source");
  const frontierPath = join(familyDir, "frontier-facts.json");
  const expectedPath = join(familyDir, "expected.json");
  const expected = JSON.parse(readFileSync(expectedPath, "utf8"));
  const rawFrontier = JSON.parse(readFileSync(frontierPath, "utf8"));

  const tmp = mkdtempSync(join(tmpdir(), `ll-eval-${family}-`));
  try {
    const head = copyAndInitGit(sourceDir, tmp);
    const frontier = replaceFixtureHead(rawFrontier, head);
    const input = {
      namespace: "test-ns",
      run_id: `run-${family}`,
      repo_path: tmp,
      revision: head,
      logical_repo: family === "cross-repo-http" ? "checkout" : family,
      frontier_report: { facts: frontier, files_scanned: 10, files_total: 10, source_revision: head },
    };
    let observations = detectObservations(input);

    // special case intentional-omission: create explicit from marker
    if (family === "intentional-omission") {
      const src = readFileSync(join(tmp, "PolicyBoundary.java"), "utf8");
      const marker = src.match(/explorer-intentional-omission reason=([^\s]+) scope=([^\s]+)/);
      if (marker) {
        const canonical = canonicalizeSignal({ capability: "intentional-omission", fields: { reason: marker[1], scope: marker[2] } });
        const base = {
          run_id: input.run_id,
          capability: "intentional-omission",
          signal_key: canonical.signal_key,
          target_signature: canonical.target_signature,
          logical_repo: family,
          relative_file: "PolicyBoundary.java",
          source_anchor: "PolicyBoundary#generated",
          source_revision: head,
          line: 1,
          evidence_snippet: marker[0],
          coverage_classification: "POSSIBLE_OMISSION",
          confirmation_status: "NEEDS_REVIEW",
          gap_reason: "missing-frontier-fact",
          gap_scope: { namespace: "test-ns", logical_repos: [family] },
        };
        base.observation_id = makeObservationId({ capability: base.capability, target_signature: base.target_signature, source_evidence_identity: { logical_repo: base.logical_repo, relative_file: base.relative_file, source_anchor: base.source_anchor } });
        base.gap_key = makeGapKey({ reason: base.gap_reason, scope: base.gap_scope, capability: base.capability, target_signature: base.target_signature });
        observations = [base];
      }
    }

    // apply review_decision from expected, preserve detected, set final
    const reviewMap = new Map(expected.outcomes.map(o => [o.source_anchor, o]));
    const finalObservations = observations.map(obs => {
      const exp = reviewMap.get(obs.source_anchor);
      if (!exp) return obs;
      const detected = obs.confirmation_status;
      let finalStatus = detected;
      if (exp.review_decision) {
        finalStatus = exp.review_decision;
      }
      return {
        ...obs,
        detected_confirmation_status: detected,
        review_decision: exp.review_decision || null,
        final_confirmation_status: finalStatus,
        confirmation_status: finalStatus,
      };
    }).sort((a, b) => a.source_anchor.localeCompare(b.source_anchor));

    // persist via ops
    const dbPath = join(tmp, "ops.sqlite");
    const store = openOpsStore(dbPath);
    try {
      const persistence = createLearningLoopPersistence(store._db);
      const api = createLearningLoopApi(store._db, persistence);
      const started_at = new Date().toISOString();
      const run = { run_id: input.run_id, namespace: "test-ns", phase: "eval", status: "ok", logical_repos: [input.logical_repo], source_revision: head, started_at };
      api.recordOutcome({ run, observations: finalObservations });

      // inspect real GapOccurrence
      const withGap = finalObservations.map(obs => {
        const hasGap = obs.gap_key ? queryGapOccurrence(store._db, input.run_id, obs.gap_key) : false;
        return {
          source_anchor: obs.source_anchor,
          expected_edge: reviewMap.get(obs.source_anchor)?.expected_edge ?? false,
          expected_omission: reviewMap.get(obs.source_anchor)?.expected_omission ?? false,
          coverage_classification: obs.coverage_classification,
          detected_confirmation_status: obs.detected_confirmation_status,
          review_decision: obs.review_decision,
          final_confirmation_status: obs.final_confirmation_status,
          gap_occurrence: hasGap
        };
      }).sort((a, b) => a.source_anchor.localeCompare(b.source_anchor));

      const counts = buildCounts(withGap, expected.outcomes);
      const metrics = metricsFromCounts(counts);
      return { expected, outcomes: withGap, counts, metrics };
    } finally {
      if (typeof store.close === "function") store.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function runAllFixtures() {
  const families = ["java-call", "spring-controller", "spring-feign", "cross-repo-http", "kafka", "intentional-omission"];
  let total = { tp_edge: 0, fp_edge: 0, fn_edge: 0, tp_omission: 0, fp_omission: 0, fn_omission: 0 };
  for (const f of families) {
    const r = runFixture(f);
    total.tp_edge += r.counts.tp_edge;
    total.fp_edge += r.counts.fp_edge;
    total.fn_edge += r.counts.fn_edge;
    total.tp_omission += r.counts.tp_omission;
    total.fp_omission += r.counts.fp_omission;
    total.fn_omission += r.counts.fn_omission;
  }
  const metrics = metricsFromCounts(total);
  return { counts: total, metrics };
}
