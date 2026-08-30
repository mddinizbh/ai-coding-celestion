/**
 * Repository-evidence verifier + status promotion seam (ADR 0002).
 * Reader is injected — this module never touches live git.
 */

import { ProvenanceError } from "./errors.mjs";
import { parseRepositoryReference, verifyLineRange } from "./provenance.mjs";

export class RepoVerifierError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "RepoVerifierError";
  }
}

const HIPOTESE = "hipótese";
const COMPROVADO = "comprovado";

/** @param {string} message */
function fail(message) {
  throw new RepoVerifierError(message);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireArray(value, label) {
  if (!Array.isArray(value)) fail(`${label} must be an array`);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value === "") fail(`${label} must be a non-empty string`);
}

/** @param {unknown} value */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {object[]} items */
function sortById(items) {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** @param {Buffer|string} bytes */
function toText(bytes) {
  return Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
}

/** @param {unknown} err */
function isExpectedReaderFailure(err) {
  return err instanceof Error && err.name === "GitSourceError";
}

/**
 * @param {object} ev
 * @param {string} logicalRepo
 * @param {string} sourceRevision
 * @param {Function} readAtRevision
 */
function verifyOneRepoEvidence(ev, logicalRepo, sourceRevision, readAtRevision) {
  let parsed;
  try {
    parsed = parseRepositoryReference(ev.uri);
  } catch (err) {
    if (err instanceof ProvenanceError) return "unresolved";
    throw err;
  }
  if (parsed.logicalRepo !== logicalRepo || parsed.sourceRevision !== sourceRevision) {
    return "unresolved";
  }
  let bytes;
  try {
    bytes = readAtRevision({ revision: parsed.sourceRevision, path: parsed.path });
  } catch (err) {
    if (isExpectedReaderFailure(err)) return "unresolved";
    throw err;
  }
  if (!verifyLineRange(toText(bytes), parsed.startLine, parsed.endLine)) {
    return "unresolved";
  }
  return "verified";
}

/**
 * @param {object} entity
 * @param {string} status
 */
function cloneWithStatus(entity, status) {
  return {
    ...entity,
    evidence: entity.evidence.map((e) => ({ ...e })),
    status,
  };
}

/**
 * @param {object} entity
 * @param {string} logicalRepo
 * @param {string} sourceRevision
 * @param {Function} readAtRevision
 */
function processEntity(entity, logicalRepo, sourceRevision, readAtRevision) {
  if (entity.status !== HIPOTESE) {
    return { entity: cloneWithStatus(entity, entity.status), unresolved: false };
  }
  const repoEv = entity.evidence.filter(
    (e) => e !== null && typeof e === "object" && e.kind === "repository",
  );
  if (repoEv.length === 0) {
    return { entity: cloneWithStatus(entity, HIPOTESE), unresolved: false };
  }
  for (const ev of repoEv) {
    if (verifyOneRepoEvidence(ev, logicalRepo, sourceRevision, readAtRevision) === "unresolved") {
      return { entity: cloneWithStatus(entity, HIPOTESE), unresolved: true };
    }
  }
  return { entity: cloneWithStatus(entity, COMPROVADO), unresolved: false };
}

/**
 * @param {object} input
 * @returns {{ records: object[], relations: object[], unresolvedIds: string[] }}
 */
export function verifyAndPromote({
  records,
  relations,
  logicalRepo,
  sourceRevision,
  readAtRevision,
}) {
  requireArray(records, "records");
  requireArray(relations, "relations");
  requireNonEmptyString(logicalRepo, "logicalRepo");
  requireNonEmptyString(sourceRevision, "sourceRevision");
  if (typeof readAtRevision !== "function") fail("readAtRevision must be a function");

  /** @type {string[]} */
  const unresolvedIds = [];

  const outRecords = records.map((rec) => {
    if (!isPlainObject(rec)) fail("each record must be an object");
    if (!Array.isArray(rec.evidence)) fail("each record must have an evidence array");
    const result = processEntity(rec, logicalRepo, sourceRevision, readAtRevision);
    if (result.unresolved) unresolvedIds.push(result.entity.id);
    return result.entity;
  });

  const outRelations = relations.map((rel) => {
    if (!isPlainObject(rel)) fail("each relation must be an object");
    if (!Array.isArray(rel.evidence)) fail("each relation must have an evidence array");
    const result = processEntity(rel, logicalRepo, sourceRevision, readAtRevision);
    if (result.unresolved) unresolvedIds.push(result.entity.id);
    return result.entity;
  });

  unresolvedIds.sort();
  return {
    records: sortById(outRecords),
    relations: sortById(outRelations),
    unresolvedIds,
  };
}
