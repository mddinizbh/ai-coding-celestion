/**
 * Shared draft shape predicates and field allow-lists.
 */

import { CandidatePackageError } from "./errors.mjs";

export const TOP_LEVEL_KEYS = new Set([
  "namespace",
  "logical_repo",
  "source_revision",
  "artifact_manifest",
  "records",
  "relations",
  "coverage_report",
]);

export const RECORD_DRAFT_KEYS = new Set([
  "type",
  "natural_key",
  "name",
  "summary",
  "attributes",
  "status",
  "evidence",
  "id",
  "namespace",
  "source_revision",
  "source_engine",
]);

export const RELATION_DRAFT_KEYS = new Set([
  "relation_type",
  "from_type",
  "from_natural_key",
  "to_type",
  "to_natural_key",
  "from_record",
  "to_record",
  "status",
  "evidence",
  "id",
  "namespace",
  "source_revision",
  "source_engine",
]);

const BANNED_KEYS = new Set(["confidence", "artifact_id", "call_chain", "prose_confidence"]);

const STATUS_ENUM = new Set(["comprovado", "hipótese", "contradição", "stale"]);

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} label
 */
export function requirePlainObject(value, label) {
  if (!isPlainObject(value)) {
    throw new CandidatePackageError(`${label} must be an object`);
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} allowed
 * @param {string} label
 */
export function rejectUnknownAndBanned(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (BANNED_KEYS.has(key)) {
      throw new CandidatePackageError(`${label}: banned field '${key}'`);
    }
    if (!allowed.has(key)) {
      throw new CandidatePackageError(`${label}: unknown field '${key}'`);
    }
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {string}
 */
export function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CandidatePackageError(`${label} must be a non-empty string`);
  }
  return value;
}

/**
 * @param {{ valid: boolean, errors: { path: string, message: string }[] }} result
 * @param {string} label
 */
export function assertSchemaValid(result, label) {
  if (!result.valid) {
    const detail = result.errors
      .slice(0, 5)
      .map((e) => `${e.path || "/"}: ${e.message}`)
      .join("; ");
    throw new CandidatePackageError(`${label} schema invalid: ${detail}`);
  }
}

/**
 * Draft `comprovado` is never trusted without verification — start as hipótese.
 * @param {string} status
 */
export function initialStatus(status) {
  if (!STATUS_ENUM.has(status)) {
    throw new CandidatePackageError(`invalid status: ${status}`);
  }
  return status === "comprovado" ? "hipótese" : status;
}

/**
 * @param {unknown} engine
 * @param {unknown} adapter
 * @param {string} manifestId
 */
export function buildSourceEngine(engine, adapter, manifestId) {
  const eng = isPlainObject(engine) ? engine : {};
  const adp = isPlainObject(adapter) ? adapter : {};
  return {
    name: typeof eng.name === "string" && eng.name !== "" ? eng.name : "graphify-llm-explorer",
    profile:
      typeof eng.profile === "string" && eng.profile !== "" ? eng.profile : "graph-json-v1",
    adapter_version:
      typeof adp.version === "string" && adp.version !== "" ? adp.version : "1.0.0",
    artifact_manifest_id: manifestId,
  };
}
