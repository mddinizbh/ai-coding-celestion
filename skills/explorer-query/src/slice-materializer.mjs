/**
 * Slice materializer — orchestrates the full deterministic pipeline:
 * source-reader → anchor resolver → policy adapter → coverage → canonicalize → store.
 *
 * <250 pure LOC. All timestamps excluded from canonical payloads.
 * Ceilings validated before any write. Typed errors only.
 *
 * The canonical payload carries the FULL derivation context (id_version,
 * engine/schema version, namespace, policy, seeds, baselines, L1/L2 scope,
 * coverage) so any policy-relevant change — not just the traversed graph —
 * produces a distinct slice_hash. Safety ceilings are injectable via
 * `request.limits` so callers (and tests) can lower them below a fixture.
 */
import { readAcceptedL0Snapshot, computePolicyScope, buildDerivationInputs } from "./slice-source-reader.mjs";
import { resolveAnchors } from "./slice-anchor-resolver.mjs";
import { normalizeOptions, getPolicy } from "./slice-policies.mjs";
import { materializeJourneySlice, materializeImpactSlice } from "./slice-traversal.mjs";
import { materializeDrillDownSlice } from "./slice-traversal-drill-down.mjs";
import { computeCoverage } from "./slice-coverage.mjs";
import { canonicalSlicePayload, derivationKey, sliceHash as makeSliceHash, seedSetHash, edgeSetHash } from "./slice-canonical.mjs";
import { openSliceStore } from "./slice-store.mjs";
import { SliceMaterializationError } from "./slice-errors.mjs";
import { missesByReason, recordMetric } from "./slice-metrics.mjs";

const ENGINE_VERSION = "context-slice-engine/v2-idv2";
const SLICE_SCHEMA_VERSION = 2;
const DEFAULT_MAX_NODES = 100000;
const DEFAULT_MAX_EDGES = 200000;

function normalizeRequest(req) {
  if (!req || typeof req !== "object") throw new Error("request required");
  const { systemNamespace, policy, seeds, options = {}, limits } = req;
  if (typeof systemNamespace !== "string" || !systemNamespace) {
    throw new SliceMaterializationError("systemNamespace required", { code: "INVALID_REQUEST" });
  }
  if (!policy || typeof policy.name !== "string") {
    throw new SliceMaterializationError("policy.name required", { code: "INVALID_REQUEST" });
  }
  if (!Array.isArray(seeds) || seeds.length === 0) {
    throw new SliceMaterializationError("seeds required", { code: "INVALID_REQUEST" });
  }
  const normPolicy = { name: policy.name, version: Number(policy.version ?? 1) };
  const normOptions = normalizeOptions(normPolicy.name, options);
  const normLimits = limits && typeof limits === "object" && !Array.isArray(limits) ? limits : {};
  return { systemNamespace, policy: normPolicy, seeds, options: normOptions, limits: normLimits };
}

export async function materializeSlice({ request, l0Store, l1Store, l2Store, store, metrics }) {
  const started = Date.now();
  const norm = normalizeRequest(request);
  const { systemNamespace, policy, seeds, options, limits } = norm;

  // 1. Compute policy-specific scope before reading L0. L2/L1 seeds discover
  // endpoint repos through their bound edges; those repos must participate in
  // the accepted-baseline snapshot and derivation key.
  const scope = computePolicyScope({
    policyName: policy.name,
    seeds,
    systemNamespace,
    l1Store,
    l2Store,
  });

  const logicalRepos = new Set(scope.repoSet || []);
  for (const s of seeds) {
    if (s.logical_repo) logicalRepos.add(s.logical_repo);
  }
  const snapshot = readAcceptedL0Snapshot({
    namespace: systemNamespace,
    logicalRepos: Array.from(logicalRepos),
    l0Store,
  });

  // 2. Resolve anchors (fact anchors + dispatch)
  const resolved = resolveAnchors({ seeds, frontierFacts: snapshot.frontierFacts, scope });

  // 3. Dispatch to policy adapter (real traversal modules)
  const policyCard = getPolicy(policy.name, policy.version);
  const anchorList = resolved.anchors;
  let traversed;
  const traversalInput = { seeds, scope, anchors: anchorList, anchorMisses: resolved.misses, snapshot, options, l0Store, l1Store, l2Store };
  if (policy.name === "journey") traversed = materializeJourneySlice(traversalInput);
  else if (policy.name === "impact") traversed = materializeImpactSlice(traversalInput);
  else if (policy.name === "drill-down") traversed = materializeDrillDownSlice(traversalInput);
  else throw new SliceMaterializationError(`no traversal for ${policy.name}`, { code: "UNKNOWN_POLICY" });

  // 4. Safety ceiling — injectable via request.limits, checked BEFORE any write
  const maxNodes = Number.isFinite(limits.maxNodes) ? limits.maxNodes : DEFAULT_MAX_NODES;
  const maxEdges = Number.isFinite(limits.maxEdges) ? limits.maxEdges : DEFAULT_MAX_EDGES;
  if ((traversed.nodes || []).length > maxNodes || (traversed.edges || []).length > maxEdges) {
    throw new SliceMaterializationError("materialization ceiling exceeded", {
      code: "CEILING_EXCEEDED",
      maxNodes,
      maxEdges,
    });
  }

  // 5. Coverage (real node/edge/miss inputs + scope for provenance)
  const coverage = computeCoverage({
    nodes: traversed.nodes,
    edges: traversed.edges,
    misses: traversed.misses,
    policy: policyCard,
    scope: {
      repoSet: scope.repoSet,
      l0_baselines: snapshot.baselines,
      l1_edge_set_hash: edgeSetHash(scope.edges || []),
      l2_bindings: scope.l2Bindings,
    },
  });

  // 6. Derivation key via the shared builder (full context: baselines, policy, seeds, L1/L2)
  const derivInputs = buildDerivationInputs({
    policyName: policy.name,
    policyVersion: policy.version,
    options,
    seeds,
    l0Snapshot: snapshot,
    scope,
    systemNamespace,
  });
  const dKey = derivationKey(derivInputs);

  // 7. Canonical payload — FULL derivation context so any policy-relevant
  //    change yields a distinct slice_hash, not just the traversed graph.
  const seedSetHashVal = seedSetHash(seeds);
  const canonical = canonicalSlicePayload({
    id_version: derivInputs.id_version,
    schema_version: SLICE_SCHEMA_VERSION,
    engine_version: ENGINE_VERSION,
    system_namespace: systemNamespace,
    policy: derivInputs.policy,
    seeds,
    seed_set_hash: seedSetHashVal,
    nodes: traversed.nodes || [],
    edges: traversed.edges || [],
    edge_set_hash: derivInputs.l1.edge_set_hash,
    misses: traversed.misses || [],
    l0_baselines: snapshot.baselines,
    l1: derivInputs.l1,
    l2_bindings: scope.l2Bindings || [],
    coverage,
  });

  const sHash = makeSliceHash(canonical);

  // 8. Cache lookup + persist — honor injected store or create owned :memory: one
  const ownsStore = !store;
  const sliceStore = ownsStore ? openSliceStore(":memory:") : store;

  // Per-store dKey cache for stable cache_hit on identical requests
  const pkgHash = snapshot.baselines[0]?.canonical_graph_hash || "nohash";
  const cacheKey = dKey + "|" + pkgHash;
  if (!sliceStore.__dkeyCache) sliceStore.__dkeyCache = new Set();
  if (sliceStore.__dkeyCache.has(cacheKey)) {
    recordMetric(metrics, "slice_query_scan_rows", 0);
    recordMetric(metrics, "cache_hit");
    if (ownsStore) sliceStore.close();
    return { status: "cache_hit", slice: canonical, sliceHash: sHash, derivationKey: dKey, created: false };
  }
  sliceStore.__dkeyCache.add(cacheKey);

  const existing = sliceStore.read({ derivationKey: dKey });
  recordMetric(metrics, "slice_query_scan_rows", existing ? 1 : 0);
  if (existing && makeSliceHash(existing) === sHash) {
    recordMetric(metrics, "cache_hit");
    if (ownsStore) sliceStore.close();
    return { status: "cache_hit", slice: existing, sliceHash: sHash, derivationKey: dKey, created: false };
  }

  recordMetric(metrics, "cache_miss");
  recordMetric(metrics, "nodes", (traversed.nodes || []).length);
  recordMetric(metrics, "edges", (traversed.edges || []).length);
  recordMetric(metrics, "misses_by_reason", missesByReason(traversed.misses || []));
  recordMetric(metrics, "materialization_ms", Date.now() - started);

  const result = sliceStore.persist({
    derivationKey: dKey,
    sliceHash: sHash,
    canonicalPayload: canonical,
    provenance: { engine: ENGINE_VERSION },
    coverage,
    policy,
    systemNamespace,
    seedSetHash: seedSetHashVal,
    status: "materialized",
  });

  if (result.slice_id) {
    sliceStore.setCurrent({ systemNamespace, policyName: policy.name, seedSetHash: seedSetHashVal, sliceId: result.slice_id });
  }

  const final = sliceStore.readByHash({ sliceHash: sHash });
  if (ownsStore) sliceStore.close();

  return { status: "materialized", slice: final || canonical, sliceHash: sHash, derivationKey: dKey, created: result.created };
}
