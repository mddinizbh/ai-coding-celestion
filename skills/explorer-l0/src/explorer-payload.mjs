/**
 * Explorer semantic payload seam.
 *
 * `validateExplorerPayload` strictly validates one untrusted payload into
 * deterministic blockers. `mergeExplorerPayloads` folds many chunk payloads
 * into one byte-stable semantic payload plus an ordered blocker list and the
 * set of chunks worth retrying. This stage owns no authority: it never assigns
 * canonical ids, status, hashes, coverage, verification, or persistence.
 */

import { ExplorerPayloadError } from "./errors.mjs";
import {
  blocker,
  collectPayloadBlockers,
  compareCodeUnits,
  isPlainObject,
} from "./explorer-payload-shape.mjs";
import { stableStringify } from "./stable-json.mjs";

export { ExplorerPayloadError };

// Internal grouping separator. NUL never appears in a validated field, so it
// safely joins tuples. These grouping keys are NOT canonical ids.
const SEP = "\u0000";

/**
 * @param {unknown} payload
 * @returns {Array<{ code: string, chunk_keys: string[], detail: string, retryable: boolean }>}
 */
export function validateExplorerPayload(payload) {
  return collectPayloadBlockers(payload);
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function asArray(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * @param {string} type
 * @param {string} naturalKey
 */
function recordKey(type, naturalKey) {
  return `${type}${SEP}${naturalKey}`;
}

/**
 * @param {Record<string, unknown>} relation
 */
function relationKey(relation) {
  return [
    relation.relation_type,
    relation.from_type,
    relation.from_natural_key,
    relation.to_type,
    relation.to_natural_key,
  ].join(SEP);
}

/**
 * Reject unknown chunk keys and divergent repeats; keep one payload per chunk.
 * @param {Record<string, unknown>[]} valid
 * @param {Set<string>} known
 * @param {object[]} blockers
 * @returns {Record<string, unknown>[]}
 */
function collectAccepted(valid, known, blockers) {
  /** @type {Map<string, Record<string, unknown>[]>} */
  const byChunk = new Map();
  for (const payload of valid) {
    const chunkKey = /** @type {string} */ (payload.chunk_key);
    if (!known.has(chunkKey)) {
      blockers.push(
        blocker("unknown_chunk_key", [chunkKey], `chunk_key '${chunkKey}' is not in the current chunk index`, false),
      );
      continue;
    }
    const list = byChunk.get(chunkKey) ?? [];
    list.push(payload);
    byChunk.set(chunkKey, list);
  }
  const accepted = [];
  for (const [chunkKey, list] of byChunk) {
    const distinct = new Set(list.map((payload) => stableStringify(payload)));
    if (distinct.size > 1) {
      blockers.push(
        blocker("duplicate_chunk_payload", [chunkKey], `chunk '${chunkKey}' received divergent payloads`, true),
      );
      continue;
    }
    accepted.push(list[0]);
  }
  return accepted;
}

/**
 * Group records by (type, natural_key); conflicting semantics block the identity.
 * @param {Record<string, unknown>[]} accepted
 * @param {object[]} blockers
 */
function buildRecords(accepted, blockers) {
  const groups = new Map();
  for (const payload of accepted) {
    const chunkKey = /** @type {string} */ (payload.chunk_key);
    for (const record of asArray(payload.records)) {
      const rec = /** @type {Record<string, unknown>} */ (record);
      const identity = recordKey(/** @type {string} */ (rec.type), /** @type {string} */ (rec.natural_key));
      const group = groups.get(identity) ?? {
        type: rec.type,
        natural_key: rec.natural_key,
        contents: new Map(),
        nodeKeys: new Set(),
        chunks: new Set(),
      };
      const content = stableStringify({ name: rec.name, summary: rec.summary, attributes: rec.attributes });
      group.contents.set(content, { name: rec.name, summary: rec.summary, attributes: rec.attributes });
      group.nodeKeys.add(rec.node_key);
      group.chunks.add(chunkKey);
      groups.set(identity, group);
    }
  }
  const records = [];
  for (const group of groups.values()) {
    if (group.contents.size > 1) {
      blockers.push(
        blocker(
          "duplicate_conflict",
          [...group.chunks],
          `records for type='${group.type}' natural_key='${group.natural_key}' disagree across chunks`,
          true,
        ),
      );
      continue;
    }
    const fields = [...group.contents.values()][0];
    records.push({
      type: group.type,
      natural_key: group.natural_key,
      name: fields.name,
      summary: fields.summary,
      attributes: fields.attributes,
      node_keys: [...group.nodeKeys].sort(compareCodeUnits),
    });
  }
  return records;
}

/**
 * Group relations by endpoint tuple; missing endpoints or self-edges are blocked.
 * @param {Record<string, unknown>[]} accepted
 * @param {object[]} records
 * @param {object[]} blockers
 */
function buildRelations(accepted, records, blockers) {
  const identities = new Set(records.map((r) => recordKey(r.type, r.natural_key)));
  const groups = new Map();
  for (const payload of accepted) {
    const chunkKey = /** @type {string} */ (payload.chunk_key);
    for (const relation of asArray(payload.relations)) {
      const rel = /** @type {Record<string, unknown>} */ (relation);
      const identity = relationKey(rel);
      const group = groups.get(identity) ?? {
        relation_type: rel.relation_type,
        from_type: rel.from_type,
        from_natural_key: rel.from_natural_key,
        to_type: rel.to_type,
        to_natural_key: rel.to_natural_key,
        edgeKeys: new Set(),
        chunks: new Set(),
      };
      group.edgeKeys.add(rel.edge_key);
      group.chunks.add(chunkKey);
      groups.set(identity, group);
    }
  }
  const relations = [];
  for (const group of groups.values()) {
    const from = recordKey(group.from_type, group.from_natural_key);
    const to = recordKey(group.to_type, group.to_natural_key);
    if (from === to) {
      blockers.push(
        blocker("unsupported_relation", [...group.chunks], `relation '${group.relation_type}' is a self-edge`, true),
      );
      continue;
    }
    if (!identities.has(from) || !identities.has(to)) {
      blockers.push(
        blocker(
          "unsupported_relation",
          [...group.chunks],
          `relation '${group.relation_type}' has an endpoint missing from the record set`,
          true,
        ),
      );
      continue;
    }
    relations.push({
      relation_type: group.relation_type,
      from_type: group.from_type,
      from_natural_key: group.from_natural_key,
      to_type: group.to_type,
      to_natural_key: group.to_natural_key,
      edge_keys: [...group.edgeKeys].sort(compareCodeUnits),
    });
  }
  return relations;
}

/**
 * @param {{ type: string, natural_key: string }} a
 * @param {{ type: string, natural_key: string }} b
 */
function byRecordKey(a, b) {
  return compareCodeUnits(a.type, b.type) || compareCodeUnits(a.natural_key, b.natural_key);
}

/**
 * @param {Record<string, string>} a
 * @param {Record<string, string>} b
 */
function byRelationKey(a, b) {
  return (
    compareCodeUnits(a.relation_type, b.relation_type) ||
    compareCodeUnits(a.from_type, b.from_type) ||
    compareCodeUnits(a.from_natural_key, b.from_natural_key) ||
    compareCodeUnits(a.to_type, b.to_type) ||
    compareCodeUnits(a.to_natural_key, b.to_natural_key)
  );
}

/**
 * Dedupe and totally order blockers so output is input-order independent.
 * @param {Array<{ code: string, chunk_keys: string[], detail: string, retryable: boolean }>} blockers
 */
function sortBlockers(blockers) {
  const seen = new Set();
  const unique = [];
  for (const b of blockers) {
    const key = `${b.code}${SEP}${b.chunk_keys.join(",")}${SEP}${b.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(b);
  }
  return unique.sort(
    (a, b) =>
      compareCodeUnits(a.code, b.code) ||
      compareCodeUnits(a.chunk_keys.join(","), b.chunk_keys.join(",")) ||
      compareCodeUnits(a.detail, b.detail),
  );
}

/**
 * Merge validated Explorer payloads into one deterministic semantic payload.
 * @param {{ payloads: unknown, chunkKeys: unknown }} input
 * @returns {{ ok: boolean, merged: object, blockers: object[], retryable_chunk_keys: string[] }}
 */
export function mergeExplorerPayloads(input) {
  if (!isPlainObject(input)) {
    throw new ExplorerPayloadError("merge input must be an object");
  }
  const { payloads, chunkKeys } = input;
  if (!Array.isArray(payloads)) {
    throw new ExplorerPayloadError("payloads must be an array");
  }
  if (!Array.isArray(chunkKeys) || !chunkKeys.every((key) => typeof key === "string" && key !== "")) {
    throw new ExplorerPayloadError("chunkKeys must be an array of non-empty strings");
  }

  const known = new Set(chunkKeys);
  /** @type {object[]} */
  const blockers = [];
  const structurallyValid = [];
  for (const payload of payloads) {
    const found = validateExplorerPayload(payload);
    if (found.length > 0) {
      blockers.push(...found);
    } else {
      structurallyValid.push(/** @type {Record<string, unknown>} */ (payload));
    }
  }

  const accepted = collectAccepted(structurallyValid, known, blockers);
  const records = buildRecords(accepted, blockers);
  const relations = buildRelations(accepted, records, blockers);

  const sorted = sortBlockers(blockers);
  const merged = {
    records: records.sort(byRecordKey),
    relations: relations.sort(byRelationKey),
  };
  const retryable_chunk_keys = [
    ...new Set(sorted.filter((b) => b.retryable).flatMap((b) => b.chunk_keys)),
  ].sort(compareCodeUnits);

  return { ok: sorted.length === 0, merged, blockers: sorted, retryable_chunk_keys };
}
