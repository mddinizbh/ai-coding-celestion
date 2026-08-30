#!/usr/bin/env node

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizeCandidatePackage } from "../../explorer-l0/src/candidate-package.mjs";
import { acceptBaseline, exportPackage, openStore, persistCandidate } from "../../explorer-l0/src/store.mjs";
import { frontierFromPackage } from "../../explorer-l0/src/frontier-export.mjs";
import { matchFrontiers } from "../../explorer-l1/src/matcher.mjs";
import { listSystemEdges, openSystemStore, persistSystemEdges } from "../../explorer-l1/src/system-store.mjs";
import { bindJourney } from "../../explorer-l2/src/journey-bind.mjs";
import { listJourneys, openJourneyStore, persistJourneyBind, showJourney } from "../../explorer-l2/src/journey-store.mjs";
import { materializeSlice } from "../src/slice-materializer.mjs";
import { createSliceMetrics } from "../src/slice-metrics.mjs";
import { openSliceStore } from "../src/slice-store.mjs";
import { projectContextPack } from "../src/context-pack.mjs";
import { runGc } from "../src/slice-gc.mjs";
import { exitCodeForError } from "../src/slice-errors.mjs";

const SYSTEM = "demo-system";
const NS = SYSTEM;
const REV = "0123456789abcdef0123456789abcdef01234567";
const SHA = "a".repeat(64);

function artifactEvidence(repo) {
  return {
    kind: "artifact",
    manifest_id: `manifest:${repo}`,
    artifact_path: ".explorer/endpoints.md",
    content_sha256: SHA,
    range: { start_line: 1, end_line: 2 },
  };
}

function manifest(repo) {
  return {
    id: `manifest:${repo}`,
    namespace: NS,
    logical_repo: repo,
    source_revision: REV,
    engine: { name: "graphify", profile: "default" },
    adapter: { version: "1.0.0", name: "llm-explorer" },
    acquisition_mode: "reused",
    artifacts: [{ path: ".explorer/endpoints.md", content_sha256: SHA, role: "native", declared_revision: REV, status: "complete" }],
    freshness: { source_revision: REV },
  };
}

function coverage() {
  const zero = "0".repeat(64);
  return {
    id: "coverage:e2e",
    threshold: {
      minimum_repository_verified_percentage: 0,
      require_schema_valid: true,
      require_repeatability_pass: true,
      require_mutation_equivalent: true,
      require_producer_reconciliation_pass: true,
    },
    mutation: { pre: { summary_hash: zero }, post: { summary_hash: zero }, equivalent: true },
    producer_baseline: { declared_counts: {}, indexed_counts: {}, deltas: [] },
    freshness: { source_revision: REV },
  };
}

function endpointRecord(repo, overrides) {
  return {
    type: "Endpoint",
    natural_key: overrides.natural_key,
    name: overrides.name,
    summary: overrides.summary,
    attributes: overrides.attributes,
    status: "comprovado",
    evidence: [artifactEvidence(repo)],
  };
}

function packageFor(repo, records) {
  return canonicalizeCandidatePackage({
    namespace: NS,
    logical_repo: repo,
    source_revision: REV,
    artifact_manifest: manifest(repo),
    records,
    relations: [],
    coverage_report: coverage(),
  });
}

function acceptPackage(store, pkg) {
  const persisted = persistCandidate(store, pkg);
  acceptBaseline(store, { candidate_id: persisted.candidate_id, approver: "e2e" });
  return persisted.candidate_id;
}

function l0Reader(store) {
  return {
    getAcceptedBaseline: (q) => store.getAcceptedBaseline(q),
    getAcceptedPackage: (q) => exportPackage(store, { ...q, accepted: true }),
  };
}

function countSlices(store) {
  return store._db.prepare("SELECT COUNT(*) AS c FROM context_slices").get().c;
}

async function run() {
  const root = mkdtempSync(join(tmpdir(), "context-slice-e2e-"));
  let l0Store;
  let l1Store;
  let l2Store;
  let sliceStore;
  try {
    l0Store = openStore(join(root, "l0.sqlite"));
    l1Store = openSystemStore(join(root, "l1.sqlite"));
    l2Store = openJourneyStore(join(root, "l2.sqlite"));
    sliceStore = openSliceStore(join(root, "slice.sqlite"));

    const svcA = packageFor("svc-a", [
      endpointRecord("svc-a", {
        natural_key: "client-get-debits",
        name: "Client Get Debits",
        summary: "calls debits service",
        attributes: { direction: "outbound", method: "GET", path: "/api/debits/{id}", config_key: "B_URL", file: "Client.kt", line: 3 },
      }),
    ]);
    const svcB = packageFor("svc-b", [
      endpointRecord("svc-b", {
        natural_key: "get:/api/debits/{id}",
        name: "List Debits",
        summary: "serves debits",
        attributes: { method: "GET", path: "/api/debits/{id}", file: "Controller.kt", line: 8 },
      }),
    ]);
    acceptPackage(l0Store, svcA);
    acceptPackage(l0Store, svcB);

    const edges = matchFrontiers(frontierFromPackage(svcA), frontierFromPackage(svcB), {
      config_target_repo: { B_URL: "svc-b" },
    });
    if (edges.length !== 1) throw new Error(`expected exactly one L1 edge, got ${edges.length}`);
    persistSystemEdges(l1Store, SYSTEM, edges);

    const spec = {
      id: "debits-flow",
      system_namespace: SYSTEM,
      members: ["svc-a", "svc-b"],
      steps: [
        { id: "consult", trigger: "http-sync", from: "svc-a", to: "svc-b", contract_prefix: "GET /api/debits" },
        { id: "missing-payment", trigger: "http-sync", from: "svc-a", to: "svc-b", contract_key: "POST /api/pay" },
      ],
    };
    const bind = bindJourney(spec, edges);
    const persistedBind = persistJourneyBind(l2Store, { spec, bind });

    const request = {
      systemNamespace: SYSTEM,
      policy: { name: "journey", version: 1 },
      seeds: [{ kind: "l2_journey", system_namespace: SYSTEM, journey_id: bind.journey_id }],
    };
    const metrics = createSliceMetrics();
    const first = await materializeSlice({
      request,
      l0Store: l0Reader(l0Store),
      l1Store: { listSystemEdges: (q) => listSystemEdges(l1Store, q) },
      l2Store: { listJourneys: (systemNamespace) => listJourneys(l2Store, systemNamespace), showJourney: (q) => showJourney(l2Store, q) },
      store: sliceStore,
      metrics,
    });
    const second = await materializeSlice({
      request,
      l0Store: l0Reader(l0Store),
      l1Store: { listSystemEdges: (q) => listSystemEdges(l1Store, q) },
      l2Store: { listJourneys: (systemNamespace) => listJourneys(l2Store, systemNamespace), showJourney: (q) => showJourney(l2Store, q) },
      store: sliceStore,
      metrics,
    });
    const pack = projectContextPack({
      slice: first.slice,
      sliceHash: first.sliceHash,
      derivationKey: first.derivationKey,
      budget: { max_nodes: 1, max_edges: 0, max_chars: 100000 },
      metrics,
    });
    const gc = runGc({ db: sliceStore._db, filters: { olderThan: null, exceptHash: [], keepCurrent: false }, dryRun: true });

    const failureStore = openSliceStore(":memory:");
    let failureCode = 0;
    try {
      await materializeSlice({
        request: {
          systemNamespace: SYSTEM,
          policy: { name: "journey", version: 1 },
          seeds: [{ kind: "l0_fact", namespace: NS, logical_repo: "missing", fact_id: "l0:ff:http_inbound:0000000000000000" }],
        },
        l0Store: { getAcceptedBaseline: () => null, getAcceptedPackage: () => { throw new Error("should not read package"); } },
        l1Store: { listSystemEdges: () => [] },
        l2Store: { listJourneys: () => [], showJourney: () => null },
        store: failureStore,
      });
    } catch (err) {
      failureCode = exitCodeForError(err);
    }
    const failureRows = countSlices(failureStore);
    failureStore.close();

    const output = {
      ok: true,
      cache_miss: first.status === "materialized",
      cache_hit: second.status === "cache_hit",
      same_slice_hash: first.sliceHash === second.sliceHash,
      slice_hash: first.sliceHash,
      journey_status: bind.status,
      steps_bound: bind.steps_bound,
      steps_gap: bind.steps_gap,
      gap_explicit: first.slice.misses.some((m) => m.miss_reason === "no_matching_edge"),
      pack_truncated: pack.truncated,
      gc_dry_run: gc.mode === "dry-run" && gc.deleted_count === 0 && gc.eligible.length === 1,
      persisted_bind_id: persistedBind.bind_id,
      metrics: metrics.summary(),
      failure_missing_baseline: { exit_code: failureCode, slice_rows: failureRows },
    };

    const required = [output.cache_miss, output.cache_hit, output.same_slice_hash, output.gap_explicit, output.pack_truncated, output.gc_dry_run, failureCode === 2, failureRows === 0];
    if (!required.every(Boolean)) throw new Error(`context slice e2e failed: ${JSON.stringify(output)}`);
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (sliceStore) sliceStore.close();
    if (l2Store) l2Store.close();
    if (l1Store) l1Store.close();
    if (l0Store) l0Store.close();
    rmSync(root, { recursive: true, force: true });
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
