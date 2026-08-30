/**
 * Slice source reader — reads accepted L0 baselines (read-only), computes
 * policy-specific scope closure, and assembles the canonical derivation-key
 * struct consumed by slice-canonical.mjs `derivationKey()`.
 *
 * Plan-locked rules (persistent-context-slice-engine-v2, Scope #3):
 *  - journey@1 scope   = journey seed's edge IDs + bind.
 *  - impact@1 scope    = ALL edges + ALL current binds of system_namespace.
 *  - drill-down@1 scope= L0 seed: no edge/bind; L1 seed: edge only;
 *                        L2 seed: edge IDs + bind.
 *  - Repo set = UNION(seed repos + in-scope edge endpoints + in-scope L2
 *    bind members). Every repo without an accepted baseline BLOCKS with
 *    SliceMaterializationError({code:"MISSING_BASELINE"}).
 *  - L1 edge_set_hash computed ONLY over in-scope edges (slice-canonical
 *    excludes score/created_at by construction via EDGE_HASH_FIELDS).
 *  - L0 handle is read-only: no writes, no candidate fallback, no default
 *    namespace.
 */

import { frontierFactsWithOrigins } from "../../explorer-l0/src/frontier-export.mjs";
import { ID_VERSION } from "../../explorer-l0/src/layered-id.mjs";
import { edgeSetHash, sortById } from "./slice-canonical.mjs";
import { normalizeOptions, optionsHash, getPolicy } from "./slice-policies.mjs";
import { SliceMaterializationError } from "./slice-errors.mjs";

/**
 * Engine version stamps the derivation key struct (plan Must-have #3).
 * Bumped in ADR 0009 alongside id_version=2 so all v1 Slice cache entries
 * miss safely and are re-materialized with the v2 identity contract.
 */
const ENGINE_VERSION = "context-slice-engine/v2-idv2";
const SLICE_SCHEMA_VERSION = 2;

/**
 * Read-only snapshot of accepted L0 baselines for a set of repos. Throws
 * SliceMaterializationError({code:"MISSING_BASELINE"}) if ANY repo lacks an
 * accepted baseline — before any cache lookup or derivation key.
 *
 * @param {{
 *   namespace: string,
 *   logicalRepos: Iterable<string>,
 *   l0Store: {
 *     getAcceptedBaseline: (q: {namespace: string, logical_repo: string}) => {candidate_id: string} | null,
 *     getAcceptedPackage: (q: {namespace: string, logical_repo: string}) => object,
 *   },
 * }} input
 * @returns {{
 *   baselines: {namespace: string, logical_repo: string, candidate_id: string, source_revision: string, canonical_graph_hash: string}[],
 *   frontierFacts: Map<string, string[]>,
 * }}
 */
export function readAcceptedL0Snapshot({ namespace, logicalRepos, l0Store }) {
  if (typeof namespace !== "string" || !namespace) {
    throw new Error("namespace must be a non-empty string");
  }
  const baselines = [];
  const frontierFacts = new Map();
  for (const repo of logicalRepos) {
    const b = l0Store.getAcceptedBaseline({ namespace, logical_repo: repo });
    if (!b) {
      throw new SliceMaterializationError(
        `no accepted L0 baseline for ${namespace}/${repo}`,
        { code: "MISSING_BASELINE" },
      );
    }
    const pkg = l0Store.getAcceptedPackage({ namespace, logical_repo: repo });
    baselines.push({
      namespace,
      logical_repo: repo,
      candidate_id: String(b.candidate_id || ""),
      source_revision: String(pkg.source_revision || ""),
      canonical_graph_hash: String(pkg.graph_index?.canonical_graph_hash || ""),
    });
    for (const { fact, source_record_ids } of frontierFactsWithOrigins(pkg)) {
      frontierFacts.set(fact.id, source_record_ids);
    }
  }
  return { baselines, frontierFacts };
}

/**
 * Compute the policy-specific scope closure.
 *
 * @param {{
 *   policyName: string,
 *   seeds: object[],
 *   systemNamespace: string,
 *   l1Store: { listSystemEdges: (q: {system_namespace: string}) => object[] },
 *   l2Store: {
 *     listJourneys: (systemNamespace: string) => object[],
 *     showJourney: (q: {system_namespace: string, journey_id: string, bind_id?: string}) => object | null,
 *   },
 * }} input
 * @returns {{
 *   edgeIds: Set<string>,
 *   bindIds: Set<string>,
 *   repoSet: Set<string>,
 *   l2Bindings: {journey_id: string, bind_id: string, journey_hash: string}[],
 *   edges: object[],
 * }}
 */
export function computePolicyScope({ policyName, seeds, systemNamespace, l1Store, l2Store }) {
  getPolicy(policyName, 1); // validates policy name@version
  const allEdges = l1Store.listSystemEdges({ system_namespace: systemNamespace });
  const edgeById = new Map(allEdges.map((e) => [e.edge_id, e]));

  const edgeIds = new Set();
  const bindIds = new Set();
  const repoSet = new Set();
  const l2Bindings = [];

  // Seed l0_fact repos always enter repoSet regardless of policy.
  for (const seed of seeds) {
    if (seed.kind === "l0_fact") repoSet.add(seed.logical_repo);
  }

  if (policyName === "impact") {
    for (const e of allEdges) {
      edgeIds.add(e.edge_id);
      repoSet.add(e.from.logical_repo);
      repoSet.add(e.to.logical_repo);
    }
    for (const b of l2Store.listJourneys(systemNamespace)) {
      addBind(b, { l2Store, systemNamespace, bindIds, l2Bindings, repoSet });
    }
  } else {
    for (const seed of seeds) {
      if (policyName === "journey" && seed.kind === "l2_journey") {
        addJourneySeed(seed, { l2Store, edgeIds, bindIds, l2Bindings, repoSet, edgeById });
      } else if (policyName === "drill-down") {
        if (seed.kind === "l1_edge") {
          addEdgeSeed(seed, { edgeIds, repoSet, edgeById });
        } else if (seed.kind === "l2_journey") {
          addJourneySeed(seed, { l2Store, edgeIds, bindIds, l2Bindings, repoSet, edgeById });
        }
        // l0_fact: repo only (already added), no edge/bind.
      }
    }
  }

  const edges = allEdges.filter((e) => edgeIds.has(e.edge_id));
  return { edgeIds, bindIds, repoSet, l2Bindings, edges };
}

/**
 * Resolve a journey seed to its current bind, adding its edges + bind +
 * member repos to the scope.
 * @param {object} seed
 * @param {object} ctx
 */
function addJourneySeed(seed, ctx) {
  const detail = ctx.l2Store.showJourney({
    system_namespace: seed.system_namespace,
    journey_id: seed.journey_id,
    ...(seed.bind_id ? { bind_id: seed.bind_id } : {}),
  });
  if (!detail) return;
  ctx.bindIds.add(detail.bind_id);
  ctx.l2Bindings.push({
    journey_id: detail.journey_id,
    bind_id: detail.bind_id,
    journey_hash: detail.journey_hash,
    step_edges: detail.step_edges || [],
  });
  for (const step of detail.step_edges || []) {
    if (step.step_status === "bound" && step.edge_id && step.edge_id !== "__gap__") {
      ctx.edgeIds.add(step.edge_id);
      const e = ctx.edgeById.get(step.edge_id);
      if (e) {
        ctx.repoSet.add(e.from.logical_repo);
        ctx.repoSet.add(e.to.logical_repo);
      }
    }
  }
  for (const m of detail.members || []) {
    if (typeof m === "string") ctx.repoSet.add(m);
    else if (m.logical_repo) ctx.repoSet.add(m.logical_repo);
  }
}

/** drill-down L1 seed: add only the edge (no bind). */
function addEdgeSeed(seed, ctx) {
  const e = ctx.edgeById.get(seed.edge_id);
  if (!e) return;
  ctx.edgeIds.add(e.edge_id);
  ctx.repoSet.add(e.from.logical_repo);
  ctx.repoSet.add(e.to.logical_repo);
}

/** impact bind (from listJourneys): add bind + member repos. */
function addBind(b, ctx) {
  const detail = ctx.l2Store.showJourney({
    system_namespace: ctx.systemNamespace,
    journey_id: b.journey_id,
    bind_id: b.bind_id,
  });
  ctx.bindIds.add(b.bind_id);
  ctx.l2Bindings.push({
    journey_id: b.journey_id,
    bind_id: b.bind_id,
    journey_hash: b.journey_hash,
    step_edges: detail?.step_edges || [],
  });
  if (detail) {
    for (const m of detail.members || []) {
      if (typeof m === "string") ctx.repoSet.add(m);
      else if (m.logical_repo) ctx.repoSet.add(m.logical_repo);
    }
  }
}

/**
 * Assemble the canonical derivation-key struct. Validates that every in-scope
 * edge has both endpoints covered by accepted baselines (throws
 * MISSING_BASELINE otherwise). `l2_bindings` is ALWAYS an array (possibly
 * empty), ordered by (journey_id, bind_id) via raw code-unit compare.
 *
 * @param {{
 *   policyName: string,
 *   policyVersion: number,
 *   options: object,
 *   seeds: object[],
 *   l0Snapshot: { baselines: object[], frontierFacts: Map },
 *   scope: { edges: object[], l2Bindings: object[] },
 *   systemNamespace: string,
 * }} input
 * @returns {object}  struct consumable by derivationKey()
 */
export function buildDerivationInputs({
  policyName,
  policyVersion,
  options,
  seeds,
  l0Snapshot,
  scope,
  systemNamespace,
}) {
  const baselineRepos = new Set(l0Snapshot.baselines.map((b) => b.logical_repo));
  for (const e of scope.edges || []) {
    if (!baselineRepos.has(e.from.logical_repo) || !baselineRepos.has(e.to.logical_repo)) {
      throw new SliceMaterializationError(
        `edge ${e.edge_id} endpoint not covered by accepted baselines`,
        { code: "MISSING_BASELINE" },
      );
    }
  }

  const normalized = normalizeOptions(policyName, options);
  const optHash = optionsHash(policyName, policyVersion, normalized);
  const l2Bindings = sortById(scope.l2Bindings || [], (b) =>
    `${b.journey_id}\u0000${b.bind_id}`,
  );

  return {
    id_version: ID_VERSION,
    engine_version: ENGINE_VERSION,
    slice_schema_version: SLICE_SCHEMA_VERSION,
    system_namespace: systemNamespace,
    policy: { name: policyName, version: policyVersion, options_hash: optHash },
    seeds: seeds || [],
    l0_baselines: l0Snapshot.baselines,
    l1: {
      system_namespace: systemNamespace,
      edge_set_hash: edgeSetHash(scope.edges || []),
    },
    l2_bindings: l2Bindings,
  };
}
