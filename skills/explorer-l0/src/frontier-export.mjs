/**
 * Export FrontierFact[] from an accepted L0 candidate package (or plain package JSON).
 * Deterministic, no git. Used by explorer-l1 stitch --frontier-dir / fixtures.
 *
 * As of ADR 0009 (id_version=2), every FrontierFact id is built by the shared
 * `makeFrontierFactId` from `layered-id.mjs`, producing `l0:ff:<kind>:<16-hex>`.
 * L0 export and L1 extraction MUST use the same builder — no duplicate logic.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { compareRaw, makeFrontierFactId } from "./layered-id.mjs";

/**
 * @typedef {{
 *   kind: "http_inbound" | "http_outbound" | "config_binding" | "topic_publish" | "topic_consume",
 *   namespace: string,
 *   logical_repo: string,
 *   source_revision: string,
 *   method?: string,
 *   path?: string,
 *   contract_key?: string,
 *   config_key?: string,
 *   topic?: string,
 *   file: string,
 *   line: number,
 *   evidence_snippet: string,
 *   id: string,
 * }} FrontierFact
 */

/**
 * @param {string} method
 * @param {string} path
 */
function contractKey(method, path) {
  const m = (method || "GET").toUpperCase();
  let p = (path || "/").toLowerCase();
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\{[^}]+\}/g, "{param}").replace(/\$\{[^}]+\}/g, "{param}");
  return `${m} ${p}`;
}

/**
 * Map Explorer semantic types → frontier kinds.
 * @param {object} rec
 * @param {string} namespace
 * @param {string} logical_repo
 * @param {string} source_revision
 * @returns {FrontierFact | null}
 */
function recordToFact(rec, namespace, logical_repo, source_revision) {
  const type = String(rec.type || "");
  const nk = String(rec.natural_key || rec.name || "");
  const attrs = rec.attributes && typeof rec.attributes === "object" ? rec.attributes : {};
  const file = String(attrs.file || attrs.path || "package");
  const line = Number(attrs.line || 0) || 0;
  const snippet = String(rec.summary || nk).slice(0, 200);
  const base = {
    namespace,
    logical_repo,
    source_revision,
    file,
    line,
    evidence_snippet: snippet,
  };

  // Endpoint: natural_key like "get:/api/foo" or attributes.method+path
  if (/endpoint/i.test(type) || /^([a-z]+):\/\//i.test(nk) || /^([a-z]+):\//i.test(nk)) {
    let method = String(attrs.method || "GET");
    let path = String(attrs.path || "");
    const m = nk.match(/^([a-z]+):(\/.*)$/i);
    if (m) {
      method = m[1].toUpperCase();
      path = m[2];
    }
    if (!path) return null;
    const direction = String(attrs.direction || attrs.kind || "inbound").toLowerCase();
    const kind = direction.includes("out") ? "http_outbound" : "http_inbound";
    const ck = contractKey(method, path);
    const id = factId(kind, base, ck);
    return {
      ...base,
      kind,
      method: method.toUpperCase(),
      path: path.toLowerCase().replace(/\{[^}]+\}/g, "{param}"),
      contract_key: ck,
      ...(attrs.config_key ? { config_key: String(attrs.config_key) } : {}),
      id,
    };
  }

  if (/producer|publish/i.test(type) || attrs.topic) {
    const topic = String(attrs.topic || nk);
    if (!topic) return null;
    const id = factId("topic_publish", base, topic);
    return {
      ...base,
      kind: "topic_publish",
      topic,
      ...(attrs.config_key ? { config_key: String(attrs.config_key) } : {}),
      id,
    };
  }

  if (/consumer|listen|subscriber/i.test(type)) {
    const topic = String(attrs.topic || nk);
    if (!topic) return null;
    const id = factId("topic_consume", base, topic);
    return {
      ...base,
      kind: "topic_consume",
      topic,
      id,
    };
  }

  if (/config/i.test(type) && attrs.config_key) {
    const key = String(attrs.config_key);
    const id = factId("config_binding", base, key);
    return { ...base, kind: "config_binding", config_key: key, id };
  }

  return null;
}

/**
 * FrontierFact id via the shared builder. Single source of truth — L1
 * extraction calls the same `makeFrontierFactId` so the two never diverge.
 *
 * @param {string} kind
 * @param {{ namespace: string, logical_repo: string, source_revision: string, file: string, line: number }} base
 * @param {string} key  contract_key | topic | config_key
 */
function factId(kind, base, key) {
  return makeFrontierFactId({
    kind,
    namespace: base.namespace,
    logical_repo: base.logical_repo,
    source_revision: base.source_revision,
    identity_key: key,
    file: base.file,
    line: base.line,
  });
}

/**
 * @param {object} packageJson  L0 candidate package
 * @returns {FrontierFact[]}
 */
export function frontierFromPackage(packageJson) {
  if (!packageJson || typeof packageJson !== "object") {
    throw new Error("packageJson required");
  }
  const namespace = String(packageJson.namespace || "");
  const logical_repo = String(packageJson.logical_repo || "");
  const source_revision = String(packageJson.source_revision || "");
  if (!namespace || !logical_repo) {
    throw new Error("package must have namespace and logical_repo");
  }

  /** @type {FrontierFact[]} */
  const facts = [];
  const records = Array.isArray(packageJson.records) ? packageJson.records : [];
  for (const rec of records) {
    const f = recordToFact(rec, namespace, logical_repo, source_revision);
    if (f) facts.push(f);
  }

  // Also allow explicit packageJson.frontier array (fixtures / future export)
  if (Array.isArray(packageJson.frontier)) {
    for (const f of packageJson.frontier) {
      if (f && f.kind && f.id) facts.push(/** @type {FrontierFact} */ (f));
    }
  }

  const byId = new Map();
  for (const f of facts) byId.set(f.id, f);
  return [...byId.values()].sort((a, b) => compareRaw(a.id, b.id));
}

/**
 * Stable record identifier for origin mapping. Prefers natural_key (the
 * canonical record key in Descobrir packages), falls back to name. Records
 * without either produce an empty string — acceptable since recordToFact
 * typically yields null for malformed records anyway.
 * @param {object} rec
 * @returns {string}
 */
function recordIdOf(rec) {
  const nk = rec.natural_key;
  if (typeof nk === "string" && nk !== "") return nk;
  const name = rec.name;
  if (typeof name === "string" && name !== "") return name;
  return "";
}

/**
 * Build FrontierFacts paired with their source record IDs. Reuses the
 * EXISTING `recordToFact` (no logic duplication). Multiple records that
 * resolve to the same fact (same contract_key + file + line) collapse to a
 * single entry whose `source_record_ids` lists every contributing record,
 * canonically sorted by raw code-unit compare.
 *
 * @param {object} packageJson  L0 candidate package
 * @returns {{fact: FrontierFact, source_record_ids: string[]}[]}
 */
export function frontierFactsWithOrigins(packageJson) {
  if (!packageJson || typeof packageJson !== "object") {
    throw new Error("packageJson required");
  }
  const namespace = String(packageJson.namespace || "");
  const logical_repo = String(packageJson.logical_repo || "");
  const source_revision = String(packageJson.source_revision || "");
  if (!namespace || !logical_repo) {
    throw new Error("package must have namespace and logical_repo");
  }

  /** @type {Map<string, {fact: FrontierFact, recordIds: Set<string>}>} */
  const byFact = new Map();
  const records = Array.isArray(packageJson.records) ? packageJson.records : [];
  for (const rec of records) {
    const f = recordToFact(rec, namespace, logical_repo, source_revision);
    if (!f) continue;
    const rid = recordIdOf(rec);
    const existing = byFact.get(f.id);
    if (existing) {
      if (rid) existing.recordIds.add(rid);
    } else {
      byFact.set(f.id, { fact: f, recordIds: new Set(rid ? [rid] : []) });
    }
  }

  return [...byFact.values()].map(({ fact, recordIds }) => ({
    fact,
    source_record_ids: [...recordIds].sort(compareRaw),
  }));
}

/**
 * @param {string} packagePath
 * @param {string} outDir  writes <logical_repo>.frontier.json
 */
export function exportFrontierFile(packagePath, outDir) {
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  const facts = frontierFromPackage(pkg);
  mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const out = join(outDir, `${pkg.logical_repo}.frontier.json`);
  const payload = {
    namespace: pkg.namespace,
    logical_repo: pkg.logical_repo,
    source_revision: pkg.source_revision,
    exported_at: new Date().toISOString(),
    fact_count: facts.length,
    facts,
  };
  writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return { output: out, fact_count: facts.length, logical_repo: pkg.logical_repo };
}
