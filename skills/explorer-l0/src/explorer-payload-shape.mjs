/**
 * Explorer payload shape: field allow-lists, authority/injection guards, and
 * per-payload blocker collection. The Explorer is untrusted and stochastic, so
 * every violation becomes a deterministic blocker object instead of trusted data.
 *
 * Ordering is locale-independent everywhere: all string comparisons use
 * `compareCodeUnits` (UTF-16 code-unit order), never `localeCompare`, so output
 * bytes never depend on the ambient collation of the host environment.
 */

import { validateExplorerPayloadSchema } from "./schema/explorer-payload.mjs";

export const PAYLOAD_KEYS = new Set(["chunk_key", "records", "relations"]);

export const RECORD_KEYS = new Set([
  "node_key",
  "type",
  "natural_key",
  "name",
  "summary",
  "attributes",
]);

export const RELATION_KEYS = new Set([
  "edge_key",
  "relation_type",
  "from_type",
  "from_natural_key",
  "to_type",
  "to_natural_key",
]);

// Authority/derived fields owned by deterministic prepare/finalize.
// None may appear in an Explorer payload at any level.
const BANNED_AUTHORITY = new Set([
  "id",
  "namespace",
  "source_revision",
  "source_engine",
  "status",
  "evidence",
  "manifest_id",
  "artifact_manifest",
  "artifact_manifest_id",
  "artifact_path",
  "content_sha256",
  "canonical_graph_hash",
  "graph_index",
  "graph_index_id",
  "coverage_report",
  "coverage",
  "confidence",
  "accepted",
  "approver",
  "passed",
  "from_record",
  "to_record",
  "source_path",
  "path",
  "uri",
  "repository",
]);

const STRING_MAX = 512;
const MAX_ATTRIBUTES = 32;
const SHA256_RE = /^[a-f0-9]{64}$/;
const CONTROL_RE = /[\u0000-\u001f]/;

/**
 * Deterministic, locale-independent lexical comparison by UTF-16 code unit.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareCodeUnits(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {string} code
 * @param {string[]} chunkKeys
 * @param {string} detail
 * @param {boolean} retryable
 */
export function blocker(code, chunkKeys, detail, retryable) {
  return { code, chunk_keys: [...chunkKeys].sort(compareCodeUnits), detail, retryable };
}

/**
 * Return a reason when a string value is shaped like authority a deterministic
 * stage owns (path, repository reference, or content hash), else null.
 * @param {unknown} value
 * @returns {string|null}
 */
export function authorityShape(value) {
  if (typeof value !== "string") return null;
  if (value.length > STRING_MAX) return "an over-length value";
  if (CONTROL_RE.test(value)) return "control characters";
  if (/^\//.test(value)) return "an absolute path";
  if (/^[A-Za-z]:[\\/]/.test(value)) return "a filesystem path";
  if (/\\/.test(value)) return "a backslash path separator";
  if (/(^|\/)\.\.(\/|$)/.test(value)) return "a path traversal";
  if (/repo:\/\//.test(value)) return "a repository reference";
  if (SHA256_RE.test(value)) return "a content hash";
  return null;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} allowed
 * @param {string} label
 * @param {string} basePath
 * @param {string[]} scope
 * @param {boolean} retryable
 * @param {object[]} out
 * @param {Set<string>} flagged
 */
function scanKeys(obj, allowed, label, basePath, scope, retryable, out, flagged) {
  for (const key of Object.keys(obj).sort(compareCodeUnits)) {
    if (BANNED_AUTHORITY.has(key)) {
      out.push(blocker("banned_field", scope, `${label}: authority field '${key}' is not allowed`, retryable));
      flagged.add(`${basePath}/${key}`);
    } else if (!allowed.has(key)) {
      out.push(blocker("unknown_field", scope, `${label}: unknown field '${key}'`, retryable));
      flagged.add(`${basePath}/${key}`);
    }
  }
}

/**
 * @param {Record<string, unknown>} value
 * @param {string} label
 * @param {string} basePath
 * @param {string[]} scope
 * @param {boolean} retryable
 * @param {object[]} out
 * @param {Set<string>} flagged
 */
function scanAttributes(value, label, basePath, scope, retryable, out, flagged) {
  if (!isPlainObject(value)) {
    out.push(blocker("invalid_shape", scope, `${label}.attributes must be an object`, retryable));
    flagged.add(`${basePath}/attributes`);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_ATTRIBUTES) {
    out.push(blocker("invalid_shape", scope, `${label}.attributes exceeds ${MAX_ATTRIBUTES} entries`, retryable));
  }
  for (const key of keys.sort(compareCodeUnits)) {
    if (BANNED_AUTHORITY.has(key)) {
      out.push(blocker("banned_field", scope, `${label}.attributes: authority field '${key}' is not allowed`, retryable));
      flagged.add(`${basePath}/attributes/${key}`);
      continue;
    }
    const reason = authorityShape(value[key]);
    if (reason !== null) {
      out.push(blocker("banned_field", scope, `${label}.attributes.${key} looks like ${reason}`, retryable));
      flagged.add(`${basePath}/attributes/${key}`);
    }
  }
}

/**
 * Guard the string values of an entity's own allowed fields.
 * @param {Record<string, unknown>} item
 * @param {Set<string>} allowed
 * @param {string} label
 * @param {string} basePath
 * @param {string[]} scope
 * @param {boolean} retryable
 * @param {object[]} out
 * @param {Set<string>} flagged
 */
function scanValues(item, allowed, label, basePath, scope, retryable, out, flagged) {
  for (const key of Object.keys(item).sort(compareCodeUnits)) {
    if (!allowed.has(key) || BANNED_AUTHORITY.has(key)) continue;
    if (key === "attributes") {
      scanAttributes(
        /** @type {Record<string, unknown>} */ (item[key]),
        label,
        basePath,
        scope,
        retryable,
        out,
        flagged,
      );
      continue;
    }
    const reason = authorityShape(item[key]);
    if (reason !== null) {
      out.push(blocker("banned_field", scope, `${label}.${key} looks like ${reason}`, retryable));
      flagged.add(`${basePath}/${key}`);
    }
  }
}

/**
 * @param {unknown} items
 * @param {string} label
 * @param {Set<string>} allowed
 * @param {string} baseKey
 * @param {string[]} scope
 * @param {boolean} retryable
 * @param {object[]} out
 * @param {Set<string>} flagged
 */
function scanEntities(items, label, allowed, baseKey, scope, retryable, out, flagged) {
  if (items === undefined) return;
  if (!Array.isArray(items)) {
    out.push(blocker("invalid_shape", scope, `${label}s must be an array`, retryable));
    flagged.add(`/${baseKey}`);
    return;
  }
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const basePath = `/${baseKey}/${index}`;
    if (!isPlainObject(item)) {
      out.push(blocker("invalid_shape", scope, `${label} must be an object`, retryable));
      flagged.add(basePath);
      continue;
    }
    scanKeys(item, allowed, label, basePath, scope, retryable, out, flagged);
    scanValues(item, allowed, label, basePath, scope, retryable, out, flagged);
  }
}

/**
 * @param {string} errPath
 * @param {Set<string>} flagged
 * @returns {boolean}
 */
function pathAlreadyFlagged(errPath, flagged) {
  if (flagged.has(errPath)) return true;
  for (const f of flagged) {
    if (errPath.startsWith(`${f}/`)) return true;
  }
  return false;
}

/**
 * Validate one untrusted Explorer payload into deterministic blockers. The
 * imperative scan (authority fields, value smuggle) is always combined with the
 * closed-schema backstop (structure, types, patterns, nested non-scalars) so a
 * payload can surface an authority field and a nested non-scalar at once. Schema
 * errors already covered imperatively are suppressed to avoid double reporting.
 * @param {unknown} payload
 * @returns {Array<{ code: string, chunk_keys: string[], detail: string, retryable: boolean }>}
 */
export function collectPayloadBlockers(payload) {
  if (!isPlainObject(payload)) {
    return [blocker("invalid_shape", [], "payload must be a JSON object", false)];
  }
  const chunkKey = typeof payload.chunk_key === "string" ? payload.chunk_key : null;
  const scope = chunkKey === null ? [] : [chunkKey];
  const retryable = chunkKey !== null;
  const out = [];
  /** @type {Set<string>} */
  const flagged = new Set();

  scanKeys(payload, PAYLOAD_KEYS, "payload", "", scope, retryable, out, flagged);
  if (chunkKey === null) {
    out.push(blocker("invalid_shape", scope, "payload.chunk_key must be a non-empty string", false));
    flagged.add("/chunk_key");
  } else if (authorityShape(chunkKey) !== null) {
    out.push(blocker("banned_field", scope, "payload.chunk_key looks like a path or hash", false));
    flagged.add("/chunk_key");
  }
  scanEntities(payload.records, "record", RECORD_KEYS, "records", scope, retryable, out, flagged);
  scanEntities(payload.relations, "relation", RELATION_KEYS, "relations", scope, retryable, out, flagged);

  // Always combine the closed-schema backstop; skip paths already flagged so a
  // banned authority field and a nested non-scalar attribute both surface.
  for (const err of validateExplorerPayloadSchema(payload).errors) {
    if (pathAlreadyFlagged(err.path, flagged)) continue;
    out.push(blocker("invalid_shape", scope, `schema ${err.path || "/"}: ${err.message}`, retryable));
  }
  return out;
}
