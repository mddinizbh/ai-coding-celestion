/**
 * One-invocation Descobrir protocol: setup-status -> prepare -> chunk dispatch
 * -> finalize, with retries only on failed chunks.
 *
 * This module owns the phase ORDER, retry policy, and the blocked-end-with-run_id
 * contract. It performs no IO: every external interaction (Graphify, Git, file
 * writes, SQLite) goes through injected seams so the protocol is hermetically
 * testable and the OpenCode skill / CLI can wire real seams in production.
 *
 * Phase order is strict and observable:
 *   1. setupStatus — check Graphify tool. Ends `setup_required` on missing or
 *      version mismatch; setup instruction is returned, never a manual fallback.
 *   2. prepare — produce run descriptor + chunk index. Ends `prepare_failed`
 *      with the causing error.
 *   3. dispatch — one dispatch call per chunk. Failed chunks (those returning
 *      retryable blockers) are retried in place up to `maxAttempts`. A chunk
 *      that exhausts attempts ends the run `blocked` with the run_id and the
 *      failed chunk keys; finalize is NOT invoked.
 *   4. finalize — merge payloads, persist candidate. Returns the finalize
 *      result (finalized or finalize-blocked).
 *
 * Invariants:
 *   - setup_status is always called first; nothing else runs if Graphify is
 *     not ready.
 *   - The chunk set comes from prepare's chunk_index; the protocol never
 *     invents chunks.
 *   - On retry, only chunks whose previous attempt returned `{ok:false}` are
 *     re-dispatched — successful chunks are never re-dispatched.
 *   - `maxAttempts` bounds total dispatch attempts per chunk (default 3).
 *   - No stdout/stderr writes; callers decide how to render results.
 */

import { DescobrirError } from "./errors.mjs";

export class DescobrirProtocolError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "DescobrirProtocolError";
  }
}

export const DEFAULT_MAX_ATTEMPTS = 3;
const SETUP_PHASE = "setup_status";
const PREPARE_PHASE = "prepare";
const DISPATCH_PHASE = "chunk_dispatch";
const FINALIZE_PHASE = "finalize";

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is Record<string, unknown>}
 */
function requireObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DescobrirProtocolError(`${label} must be a plain object`);
  }
}

/**
 * @param {unknown} value
 * @param {string} label
 * @returns {asserts value is Function}
 */
function requireFunction(value, label) {
  if (typeof value !== "function") {
    throw new DescobrirProtocolError(`${label} seam must be a function`);
  }
}

/**
 * Run the one-invocation Descobrir protocol with injectable seams.
 *
 * @param {{
 *   namespace: string,
 *   logical_repo: string,
 *   project_path: string,
 *   source_revision?: string,
 *   db?: string,
 *   obsidian_root?: string,
 *   threshold?: object,
 *   run_id?: string,
 * }} input
 * @param {{
 *   setupStatus: () => Promise<{ installed: boolean, matches_pin: boolean, version: string | null, setup_command: string }> | { installed: boolean, matches_pin: boolean, version: string | null, setup_command: string },
 *   prepare: (input: object) => Promise<PrepareResult> | PrepareResult,
 *   dispatchChunk: (ctx: { chunk_key: string, attempt: number, run_id: string, run_root: string, descriptor: object }) =>
 *     Promise<{ ok: true, payload?: object } | { ok: false, blockers: object[] }> |
 *       ({ ok: true, payload?: object } | { ok: false, blockers: object[] }),
 *   finalize: (ctx: { run_root: string, db_path: string, source_repo_path: string, run_id: string }) =>
 *     Promise<FinalizeResult> | FinalizeResult,
 *   maxAttempts?: number,
 * }} seams
 * @returns {Promise<ProtocolResult>}
 *
 * @typedef {object} PrepareResult
 * @property {"prepared"} status
 * @property {string} run_id
 * @property {string} run_root
 * @property {string} source_revision
 * @property {object} chunk_index
 * @property {object} descriptor
 *
 * @typedef {object} FinalizeResult
 * @property {"finalized"|"blocked"} status
 * @property {number} exit_code
 * @property {string} run_id
 *
 * @typedef {{
 *   status: "setup_required",
 *   phase: typeof SETUP_PHASE,
 *   run_id: null,
 *   setup_command: string,
 *   installed: boolean,
 *   matches_pin: boolean,
 *   version: string | null,
 * } | {
 *   status: "prepare_failed",
 *   phase: typeof PREPARE_PHASE,
 *   run_id: null,
 *   error: string,
 * } | {
 *   status: "blocked",
 *   phase: typeof DISPATCH_PHASE,
 *   run_id: string,
 *   failed_chunk_keys: string[],
 *   attempts: Record<string, number>,
 *   blockers: object[],
 * } | {
 *   status: "finalized"|"finalize_blocked",
 *   phase: typeof FINALIZE_PHASE,
 *   finalize: FinalizeResult,
 * }} ProtocolResult
 */
export async function runDescobrirProtocol(input, seams) {
  requireObject(input, "input");
  requireObject(seams, "seams");
  requireFunction(seams.setupStatus, "setupStatus");
  requireFunction(seams.prepare, "prepare");
  requireFunction(seams.dispatchChunk, "dispatchChunk");
  requireFunction(seams.finalize, "finalize");

  const maxAttemptsRaw = seams.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  if (
    typeof maxAttemptsRaw !== "number" ||
    !Number.isInteger(maxAttemptsRaw) ||
    maxAttemptsRaw < 1
  ) {
    throw new DescobrirProtocolError("maxAttempts must be a positive integer");
  }
  const maxAttempts = maxAttemptsRaw;

  // Phase 1: setup-status. Missing or version-mismatched Graphify ends the run
  // with setup instructions, never a manual fallback.
  const status = await seams.setupStatus();
  requireObject(status, "setupStatus result");
  if (typeof status.installed !== "boolean" || typeof status.matches_pin !== "boolean") {
    throw new DescobrirProtocolError(
      "setupStatus result must have boolean installed and matches_pin",
    );
  }
  if (!status.installed || !status.matches_pin) {
    return {
      status: "setup_required",
      phase: SETUP_PHASE,
      run_id: null,
      installed: status.installed,
      matches_pin: status.matches_pin,
      version: typeof status.version === "string" ? status.version : null,
      setup_command:
        typeof status.setup_command === "string" && status.setup_command !== ""
          ? status.setup_command
          : "",
    };
  }

  // Phase 2: prepare.
  let prepared;
  try {
    prepared = await seams.prepare(input);
  } catch (err) {
    return {
      status: "prepare_failed",
      phase: PREPARE_PHASE,
      run_id: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  requireObject(prepared, "prepare result");
  if (prepared.status !== "prepared") {
    throw new DescobrirProtocolError(
      `prepare seam returned unexpected status '${prepared.status}'`,
    );
  }
  if (typeof prepared.run_id !== "string" || prepared.run_id === "") {
    throw new DescobrirProtocolError("prepare result must include run_id");
  }
  if (typeof prepared.run_root !== "string" || prepared.run_root === "") {
    throw new DescobrirProtocolError("prepare result must include run_root");
  }
  if (
    !prepared.chunk_index ||
    !Array.isArray(prepared.chunk_index.chunks)
  ) {
    throw new DescobrirProtocolError("prepare result must include chunk_index.chunks");
  }
  const chunkKeys = /** @type {{ chunk_key: string }[]} */ (
    prepared.chunk_index.chunks
  ).map((c) => {
    if (typeof c.chunk_key !== "string" || c.chunk_key === "") {
      throw new DescobrirProtocolError("chunk_index entry missing chunk_key");
    }
    return c.chunk_key;
  });

  // Phase 3: dispatch with bounded retries only on failed chunks.
  /** @type {Map<string, number>} */
  const attemptsByChunk = new Map();
  for (const key of chunkKeys) attemptsByChunk.set(key, 0);
  /** @type {Set<string>} */
  let pending = new Set(chunkKeys);
  /** @type {object[]} */
  const accumulatedBlockers = [];
  /** @type {Set<string>} */
  const exhausted = new Set();

  while (pending.size > 0) {
    /** @type {Set<string>} */
    const nextPending = new Set();
    for (const chunkKey of pending) {
      const attempt = (attemptsByChunk.get(chunkKey) ?? 0) + 1;
      attemptsByChunk.set(chunkKey, attempt);
      let result;
      try {
        result = await seams.dispatchChunk({
          chunk_key: chunkKey,
          attempt,
          run_id: prepared.run_id,
          run_root: prepared.run_root,
          descriptor: prepared.descriptor,
        });
      } catch (err) {
        // Treat a thrown dispatch as a retryable blocker; surface the cause.
        result = {
          ok: false,
          blockers: [
            {
              code: "dispatch_exception",
              chunk_keys: [chunkKey],
              detail: err instanceof Error ? err.message : String(err),
              retryable: true,
            },
          ],
        };
      }
      requireObject(result, `dispatchChunk('${chunkKey}') result`);
      if (result.ok === true) {
        continue;
      }
      // Failed attempt.
      const blockers = Array.isArray(result.blockers) ? result.blockers : [];
      for (const b of blockers) {
        if (b && typeof b === "object") accumulatedBlockers.push(b);
      }
      if (attempt < maxAttempts) {
        nextPending.add(chunkKey);
      } else {
        exhausted.add(chunkKey);
      }
    }
    pending = nextPending;
  }

  // A chunk is failed only if its final (maxAttempts-th) attempt was non-ok.
  const failedChunkKeys = chunkKeys.filter((key) => exhausted.has(key));

  if (failedChunkKeys.length > 0) {
    return {
      status: "blocked",
      phase: DISPATCH_PHASE,
      run_id: prepared.run_id,
      failed_chunk_keys: failedChunkKeys,
      attempts: Object.fromEntries(attemptsByChunk),
      blockers: accumulatedBlockers,
    };
  }

  // Phase 4: finalize.
  const finalizeResult = await seams.finalize({
    run_root: prepared.run_root,
    db_path: /** @type {{ db?: string }} */ (input).db ?? "",
    source_repo_path: /** @type {{ project_path: string }} */ (input).project_path,
    run_id: prepared.run_id,
  });
  requireObject(finalizeResult, "finalize result");
  if (
    finalizeResult.status !== "finalized" &&
    finalizeResult.status !== "blocked"
  ) {
    throw new DescobrirProtocolError(
      `finalize result has unexpected status '${finalizeResult.status}'`,
    );
  }
  return {
    status: finalizeResult.status === "finalized" ? "finalized" : "finalize_blocked",
    phase: FINALIZE_PHASE,
    finalize: finalizeResult,
  };
}
