/**
 * Canonical ID generation for Descobrir (ADR 0002, ADR 0009).
 * Deterministic, layer-prefixed IDs unique within a Knowledge Namespace.
 *
 * As of Todo 8b (id_version=2) every new ID carries an explicit `l0:` prefix.
 * Legacy unprefixed IDs (`service:x`, `exposes:...`) are treated as
 * id_version=1; v2 readers reject mixed versions. All builders delegate to
 * the shared identity module so L0/L1/L2/query never duplicate logic.
 */

import { CanonicalIdError } from "./errors.mjs";
import { makeL0RecordId, makeL0RelationId, normalizeNaturalKey } from "./layered-id.mjs";

export { CanonicalIdError };

/**
 * V1 helper kept for migration code paths only. Returns the legacy unprefixed
 * shape `<type>:<natural-key>`. NEVER call this for new outputs — it is v1.
 *
 * @param {string} type
 * @param {string} naturalKey
 * @returns {string}
 */
export function canonicalRecordIdV1(type, naturalKey) {
  const normalizedType = normalizeNaturalKey(type);
  const normalizedKey = normalizeNaturalKey(naturalKey);
  if (normalizedType === "") throw new CanonicalIdError("canonical id type is empty");
  if (normalizedKey === "") throw new CanonicalIdError("canonical id natural_key is empty");
  return `${normalizedType}:${normalizedKey}`;
}

/**
 * V1 helper kept for migration code paths only. Returns the legacy unprefixed
 * shape `<TYPE>:<from>-><to>` with raw natural keys.
 *
 * @param {string} relationType
 * @param {string} fromRecord  legacy record id (NOT prefixed)
 * @param {string} toRecord    legacy record id (NOT prefixed)
 * @returns {string}
 */
export function canonicalRelationIdV1(relationType, fromRecord, toRecord) {
  const type = relationType.trim().toLowerCase();
  if (type === "") throw new CanonicalIdError("relation_type is empty");
  if (!fromRecord || !toRecord) throw new CanonicalIdError("relation endpoints required");
  return `${type}:${fromRecord}->${toRecord}`;
}

/**
 * Canonical L0 record id (id_version=2): `l0:<record-kind>:<canonical-natural-key>`.
 *
 * @param {string} type
 * @param {string} naturalKey
 * @returns {string}
 */
export function canonicalRecordId(type, naturalKey) {
  try {
    return makeL0RecordId(type, naturalKey);
  } catch (err) {
    throw new CanonicalIdError(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Canonical L0 relation id (id_version=2).
 * Body carries canonical natural keys (NOT full record ids). Endpoints in the
 * relation payload continue to store full L0 record ids (`l0:<kind>:*`).
 *
 * @param {string} relationType
 * @param {string} fromNaturalKey
 * @param {string} toNaturalKey
 * @returns {string}
 */
export function canonicalRelationId(relationType, fromNaturalKey, toNaturalKey) {
  try {
    return makeL0RelationId(relationType, fromNaturalKey, toNaturalKey);
  } catch (err) {
    throw new CanonicalIdError(err instanceof Error ? err.message : String(err));
  }
}
