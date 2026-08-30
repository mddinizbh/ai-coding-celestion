/**
 * Per-entity draft canonicalization and graph consistency checks.
 */

import { canonicalRecordId, canonicalRelationId } from "./canonical-id.mjs";
import {
  RECORD_DRAFT_KEYS,
  RELATION_DRAFT_KEYS,
  TOP_LEVEL_KEYS,
  assertSchemaValid,
  buildSourceEngine,
  initialStatus,
  isPlainObject,
  rejectUnknownAndBanned,
  requireNonEmptyString,
  requirePlainObject,
} from "./candidate-shape.mjs";
import { artifactEvidenceResolves } from "./coverage-report.mjs";
import { CandidatePackageError } from "./errors.mjs";
import {
  validateKnowledgeRecord,
  validateRelation,
} from "./schema/descobrir.mjs";

export {
  TOP_LEVEL_KEYS,
  assertSchemaValid,
  buildSourceEngine,
  isPlainObject,
  rejectUnknownAndBanned,
  requireNonEmptyString,
  requirePlainObject,
};

/**
 * @param {unknown} evidence
 * @param {object} manifest
 * @param {string} label
 */
function assertEvidenceResolves(evidence, manifest, label) {
  if (!Array.isArray(evidence)) {
    throw new CandidatePackageError(`${label}.evidence must be an array`);
  }
  for (const ev of evidence) {
    if (!isPlainObject(ev)) {
      throw new CandidatePackageError(`${label}: evidence item must be an object`);
    }
    if (ev.kind === "artifact" && !artifactEvidenceResolves(ev, manifest)) {
      throw new CandidatePackageError(
        `${label}: artifact evidence does not resolve against manifest`,
      );
    }
  }
}

/**
 * @param {unknown} value
 * @returns {object}
 */
function cloneEvidenceItem(value) {
  if (!isPlainObject(value)) {
    throw new CandidatePackageError("evidence item must be an object");
  }
  const item = { ...value };
  if (isPlainObject(value.range)) {
    item.range = { ...value.range };
  }
  return item;
}

/**
 * @param {Record<string, unknown>} draft
 * @param {string} namespace
 * @param {string} sourceRevision
 * @param {object} sourceEngine
 * @param {object} manifest
 */
export function canonicalizeRecord(draft, namespace, sourceRevision, sourceEngine, manifest) {
  requirePlainObject(draft, "record");
  rejectUnknownAndBanned(draft, RECORD_DRAFT_KEYS, "record");

  const type = requireNonEmptyString(draft.type, "record.type");
  const naturalKey = requireNonEmptyString(draft.natural_key, "record.natural_key");
  const name = requireNonEmptyString(draft.name, "record.name");
  if (typeof draft.summary !== "string") {
    throw new CandidatePackageError("record.summary must be a string");
  }
  if (!isPlainObject(draft.attributes)) {
    throw new CandidatePackageError("record.attributes must be an object");
  }
  const statusRaw = requireNonEmptyString(draft.status, "record.status");
  assertEvidenceResolves(draft.evidence, manifest, "record");

  const id = canonicalRecordId(type, naturalKey);
  const record = {
    id,
    namespace,
    type,
    name,
    summary: draft.summary,
    attributes: draft.attributes,
    status: initialStatus(statusRaw),
    source_revision: sourceRevision,
    source_engine: sourceEngine,
    evidence: /** @type {unknown[]} */ (draft.evidence).map(cloneEvidenceItem),
  };
  assertSchemaValid(validateKnowledgeRecord(record), `record ${id}`);
  return record;
}

/**
 * @param {Record<string, unknown>} draft
 * @param {string} namespace
 * @param {string} sourceRevision
 * @param {object} sourceEngine
 * @param {object} manifest
 */
export function canonicalizeRelation(draft, namespace, sourceRevision, sourceEngine, manifest) {
  requirePlainObject(draft, "relation");
  rejectUnknownAndBanned(draft, RELATION_DRAFT_KEYS, "relation");

  const relationType = requireNonEmptyString(draft.relation_type, "relation.relation_type");
  const statusRaw = requireNonEmptyString(draft.status, "relation.status");
  assertEvidenceResolves(draft.evidence, manifest, "relation");

  // from_record / to_record / id are never authority — always natural keys.
  // Per ADR 0009: relation ID body carries canonical NATURAL KEYS only,
  // while the persisted from_record/to_record fields carry full L0 record ids.
  const fromType = requireNonEmptyString(draft.from_type, "relation.from_type");
  const fromKey = requireNonEmptyString(draft.from_natural_key, "relation.from_natural_key");
  const toType = requireNonEmptyString(draft.to_type, "relation.to_type");
  const toKey = requireNonEmptyString(draft.to_natural_key, "relation.to_natural_key");
  const fromRecord = canonicalRecordId(fromType, fromKey);
  const toRecord = canonicalRecordId(toType, toKey);
  const id = canonicalRelationId(relationType, fromKey, toKey);
  const relation = {
    id,
    namespace,
    from_record: fromRecord,
    relation_type: relationType,
    to_record: toRecord,
    status: initialStatus(statusRaw),
    source_revision: sourceRevision,
    source_engine: sourceEngine,
    evidence: /** @type {unknown[]} */ (draft.evidence).map(cloneEvidenceItem),
  };
  assertSchemaValid(validateRelation(relation), `relation ${id}`);
  return relation;
}

/**
 * @param {object[]} items
 * @param {string} label
 */
export function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new CandidatePackageError(`duplicate ${label} id: ${item.id}`);
    }
    seen.add(item.id);
  }
}

/**
 * @param {object[]} records
 * @param {object[]} relations
 */
export function assertRelationEndpointsExist(records, relations) {
  const ids = new Set(records.map((r) => r.id));
  for (const rel of relations) {
    if (!ids.has(rel.from_record)) {
      throw new CandidatePackageError(
        `relation ${rel.id}: from_record missing from record set: ${rel.from_record}`,
      );
    }
    if (!ids.has(rel.to_record)) {
      throw new CandidatePackageError(
        `relation ${rel.id}: to_record missing from record set: ${rel.to_record}`,
      );
    }
  }
}
