/**
 * L1 contract matcher — config-binding first, then path contract.
 *
 * ADR 0009 (id_version=2): every SystemEdge.edge_id is `l1:edge:<32-hex>`
 * via the shared `makeL1EdgeId` builder. L1 edges ALWAYS reference
 * `l0:ff:*` FrontierFact ids on both endpoints — never `l0:method:*`,
 * `l0:endpoint:*`, or any other L0 record id (plan MUST NOT DO).
 */

import { MatchError } from "./errors.mjs";
import { compareRaw, makeL1EdgeId, assertL0FfEndpoints } from "../../explorer-l0/src/layered-id.mjs";
import { contractKey } from "./path-normalize.mjs";

/**
 * @deprecated Config maps are project data and now live per system namespace —
 * see `config-map.mjs` and `config/<system-namespace>.config-map.json`.
 * Re-exported here only so callers that never resolved a map keep the scoring
 * they had before. `stitchL1` always passes an explicitly resolved map.
 */
export { LEGACY_BUILTIN_CONFIG_MAP as DEFAULT_CONFIG_TARGET_REPO } from "./config-map.mjs";
import { LEGACY_BUILTIN_CONFIG_MAP } from "./config-map.mjs";

/**
 * @typedef {import("./frontier-extract.mjs").FrontierFact} FrontierFact
 */

/**
 * @typedef {{
 *   edge_id: string,
 *   from: { namespace: string, logical_repo: string, fact_id: string },
 *   to: { namespace: string, logical_repo: string, fact_id: string },
 *   contract_key: string,
 *   method: string,
 *   path: string,
 *   evidence_class: "contract-matched",
 *   match_kind: "config_binding" | "path_contract" | "topic_contract",
 *   trigger: "http-sync" | "queue" | "cron" | "webhook" | "internal",
 *   interaction: "http" | "webhook" | "topic",
 *   score: number,
 *   config_key?: string,
 *   evidence: object[],
 * }} SystemEdge
 */

/**
 * @param {FrontierFact[]} fromFacts  outbound side (e.g. acme-tax)
 * @param {FrontierFact[]} toFacts    inbound side (e.g. controller)
 * @param {{
 *   system_namespace?: string,
 *   config_target_repo?: Record<string, string>,
 *   min_score?: number,
 * }} [options]
 * @returns {SystemEdge[]}
 */
export function matchFrontiers(fromFacts, toFacts, options = {}) {
  if (!Array.isArray(fromFacts) || !Array.isArray(toFacts)) {
    throw new MatchError("fromFacts and toFacts must be arrays");
  }
  const configMap = {
    ...LEGACY_BUILTIN_CONFIG_MAP,
    ...(options.config_target_repo || {}),
  };
  const minScore = options.min_score ?? 0.5;

  const inbounds = toFacts.filter((f) => f.kind === "http_inbound" && f.contract_key);
  const outbounds = fromFacts.filter((f) => f.kind === "http_outbound" && f.contract_key);

  /** @type {Map<string, FrontierFact[]>} */
  const inboundByContract = new Map();
  for (const inn of inbounds) {
    const k = /** @type {string} */ (inn.contract_key);
    if (!inboundByContract.has(k)) inboundByContract.set(k, []);
    inboundByContract.get(k).push(inn);
  }

  /** @type {SystemEdge[]} */
  const edges = [];
  const seen = new Set();

  for (const out of outbounds) {
    const ck = /** @type {string} */ (out.contract_key);
    const exactCandidates = inboundByContract.get(ck) || [];
    const candidates = exactCandidates.length > 0
      ? exactCandidates.map((inn) => ({ inn, pathMatch: "exact" }))
      : inbounds
          .filter((inn) => compatibleHttpContract(out, inn))
          .map((inn) => ({ inn, pathMatch: "template" }));
    for (const { inn, pathMatch } of candidates) {
      // Prefer same-path matches where config_key maps to target repo
      let score = pathMatch === "exact" ? 0.55 : 0.5;
      let matchKind = /** @type {"config_binding"|"path_contract"} */ ("path_contract");
      if (out.config_key && configMap[out.config_key] === inn.logical_repo) {
        score = pathMatch === "exact" ? 0.95 : 0.9;
        matchKind = "config_binding";
      } else if (out.config_key && configMap[out.config_key]) {
        // config points elsewhere — skip or low score
        if (configMap[out.config_key] !== inn.logical_repo) continue;
      }

      if (score < minScore) continue;
      if (out.logical_repo === inn.logical_repo) continue; // not cross-service

      const edge = buildEdge(out, inn, matchKind, score);
      edge.path_match = pathMatch;
      if (seen.has(edge.edge_id)) continue;
      seen.add(edge.edge_id);
      edges.push(edge);
    }
  }

  const consumersByTopic = new Map();
  for (const consumer of toFacts.filter((fact) => fact.kind === "topic_consume" && fact.topic)) {
    const topic = normalizeTopic(consumer.topic);
    if (!consumersByTopic.has(topic)) consumersByTopic.set(topic, []);
    consumersByTopic.get(topic).push(consumer);
  }
  for (const publisher of fromFacts.filter((fact) => fact.kind === "topic_publish" && fact.topic)) {
    const topic = normalizeTopic(publisher.topic);
    for (const consumer of consumersByTopic.get(topic) || []) {
      if (publisher.logical_repo === consumer.logical_repo) continue;
      const edge = buildEdge(publisher, consumer, "topic_contract", 0.9);
      if (edge.score < minScore || seen.has(edge.edge_id)) continue;
      seen.add(edge.edge_id);
      edges.push(edge);
    }
  }

  return edges.sort((a, b) => {
    // Higher score first; raw code-unit edge_id tiebreak (plan-locked: no localeCompare).
    if (b.score !== a.score) return b.score < a.score ? -1 : 1;
    return compareRaw(a.edge_id, b.edge_id);
  });
}

/**
 * @param {FrontierFact} out
 * @param {FrontierFact} inn
 * @param {"config_binding"|"path_contract"|"topic_contract"} matchKind
 * @param {number} score
 * @returns {SystemEdge}
 */
function buildEdge(out, inn, matchKind, score) {
  const topicMatch = matchKind === "topic_contract";
  const topic = topicMatch ? normalizeTopic(out.topic || inn.topic) : undefined;
  const method = topicMatch ? "PUBLISH" : out.method || inn.method || "GET";
  const path = topicMatch ? topic : out.path || inn.path || "/";
  const ck = topicMatch
    ? `TOPIC ${topic}`
    : out.contract_key || inn.contract_key || contractKey(method, path);
  const interaction = topicMatch
    ? "topic"
    : isWebhookPath(path)
      ? "webhook"
      : "http";
  const trigger = topicMatch
    ? "queue"
    : out.trigger || inn.trigger || (interaction === "webhook" ? "webhook" : "http-sync");
  const material = [
    out.namespace,
    out.logical_repo,
    out.id,
    inn.namespace,
    inn.logical_repo,
    inn.id,
    ck,
    matchKind,
  ].join("|");
  const edge_id = makeL1EdgeId(material);

  const edge = {
    edge_id,
    from: {
      namespace: out.namespace,
      logical_repo: out.logical_repo,
      fact_id: out.id,
    },
    to: {
      namespace: inn.namespace,
      logical_repo: inn.logical_repo,
      fact_id: inn.id,
    },
    contract_key: ck,
    method,
    path,
    evidence_class: "contract-matched",
    match_kind: matchKind,
    score,
    trigger,
    interaction,
    ...(out.config_key ? { config_key: out.config_key } : {}),
    ...(out.schedule ? { schedule: out.schedule } : {}),
    ...(out.pipeline_id ? { pipeline_id: out.pipeline_id } : {}),
    ...(Number.isInteger(out.operation_index) ? { operation_index: out.operation_index } : {}),
    evidence: [
      {
        side: "from",
        file: out.file,
        line: out.line,
        snippet: out.evidence_snippet,
        revision: out.source_revision,
      },
      {
        side: "to",
        file: inn.file,
        line: inn.line,
        snippet: inn.evidence_snippet,
        revision: inn.source_revision,
      },
    ],
  };
  // Plan MUST DO: L1 endpoints ALWAYS reference l0:ff:* (never a direct L0
  // record id). After construction, assert the invariant so v1 callers that
  // pass unprefixed ff:* ids surface as InvalidLayeredIdError immediately.
  assertL0FfEndpoints(edge);
  return edge;
}

/** @param {unknown} topic */
function normalizeTopic(topic) {
  return String(topic || "").trim().toLowerCase();
}

/** @param {unknown} path */
function isWebhookPath(path) {
  return /\/(webhook|notification)(?:\/|$)/i.test(String(path || ""));
}

/**
 * Match a concrete client path to a parameterized server path without
 * weakening HTTP method or segment count.
 *
 * @param {object} out
 * @param {object} inn
 */
function compatibleHttpContract(out, inn) {
  if (String(out.method || "GET").toUpperCase() !== String(inn.method || "GET").toUpperCase()) {
    return false;
  }
  const outParts = String(out.path || "").split("/").filter(Boolean);
  const inParts = String(inn.path || "").split("/").filter(Boolean);
  if (outParts.length !== inParts.length) return false;
  return outParts.every(
    (part, index) =>
      part === inParts[index] || part === "{param}" || inParts[index] === "{param}",
  );
}
