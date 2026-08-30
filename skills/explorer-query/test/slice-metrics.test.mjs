import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSliceMetrics, missesByReason, recordMetric } from "../src/slice-metrics.mjs";
import { exitCodeForError, SliceMaterializationError } from "../src/slice-errors.mjs";
import { projectContextPack } from "../src/context-pack.mjs";
import { materializeSlice } from "../src/slice-materializer.mjs";
import { openSliceStore } from "../src/slice-store.mjs";
import { frontierFactsWithOrigins } from "../../explorer-l0/src/frontier-export.mjs";

function makeMaterializerFixture() {
  const pkg = {
    namespace: "test",
    logical_repo: "repo",
    source_revision: "rev",
    graph_index: { canonical_graph_hash: "a".repeat(64) },
    records: [{ type: "endpoint", natural_key: "get:/m", attributes: { method: "GET", path: "/m" } }],
  };
  const factId = frontierFactsWithOrigins(pkg)[0].fact.id;
  const store = openSliceStore(":memory:");
  return {
    store,
    factId,
    l0Store: { getAcceptedBaseline: () => ({ candidate_id: "c1" }), getAcceptedPackage: () => pkg },
    l1Store: { listSystemEdges: () => [] },
    l2Store: { listJourneys: () => [], showJourney: () => null },
  };
}

describe("slice metrics collector", () => {
  it("records hit/miss/count summaries deterministically", () => {
    const metrics = createSliceMetrics();
    metrics.record("cache_miss");
    metrics.record("cache_hit");
    metrics.record("nodes", 2);
    metrics.record("edges", 1);
    metrics.record("misses_by_reason", { unresolved_dispatch: 1 });
    assert.deepEqual(metrics.summary(), {
      cache_hit: 1,
      cache_miss: 1,
      edges: 1,
      misses_by_reason: { unresolved_dispatch: 1 },
      nodes: 2,
    });
  });

  it("collector failure is a typed semantic error", () => {
    assert.throws(
      () => recordMetric(createSliceMetrics({ onRecord: () => { throw new Error("boom"); } }), "cache_miss"),
      (err) => err instanceof SliceMaterializationError && err.code === "METRICS_FAILED" && exitCodeForError(err) === 2,
    );
  });

  it("aggregates misses by closed reason", () => {
    assert.deepEqual(missesByReason([{ miss_reason: "policy_boundary" }, { reason: "policy_boundary" }]), {
      policy_boundary: 2,
    });
  });

  it("projectContextPack emits pack_truncated metric", () => {
    const metrics = createSliceMetrics();
    const slice = {
      engine_version: "context-slice-engine/v2-idv2",
      schema_version: 2,
      system_namespace: "test",
      policy: { name: "journey", version: 1, options_hash: "a".repeat(64) },
      seeds: [{ kind: "l0_fact", namespace: "test", logical_repo: "repo", fact_id: "ff", record_id: "n1" }],
      nodes: [{ id: "n1", kind: "method", label: "n1", layer: "l0", status: "comprovado" }],
      edges: [],
      misses: [],
    };
    const pack = projectContextPack({
      slice,
      sliceHash: "b".repeat(64),
      derivationKey: "c".repeat(64),
      budget: { max_nodes: 1, max_edges: 0, max_chars: 1000 },
      metrics,
    });
    assert.equal(pack.truncated, false);
    assert.equal(metrics.summary().pack_truncated, 0);
  });

  it("materializeSlice emits cache and count metrics from the real pipeline", async () => {
    const fixture = makeMaterializerFixture();
    const metrics = createSliceMetrics();
    try {
      const request = {
        systemNamespace: "test",
        policy: { name: "journey", version: 1 },
        seeds: [{ kind: "l0_fact", namespace: "test", logical_repo: "repo", fact_id: fixture.factId }],
      };
      const first = await materializeSlice({ ...fixture, request, store: fixture.store, metrics });
      const second = await materializeSlice({ ...fixture, request, store: fixture.store, metrics });
      assert.equal(first.status, "materialized");
      assert.equal(second.status, "cache_hit");
      assert.deepEqual(metrics.summary(), {
        cache_hit: 1,
        cache_miss: 1,
        edges: 0,
        materialization_ms: metrics.summary().materialization_ms,
        misses_by_reason: {},
        nodes: 1,
        slice_query_scan_rows: 0,
      });
      assert.equal(typeof metrics.summary().materialization_ms, "number");
    } finally {
      fixture.store.close();
    }
  });
});
