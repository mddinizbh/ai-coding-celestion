/**
 * Typed domain errors for the Context Slice engine.
 *
 * Exit-code contract (see README): 0 ok · 1 infra/typed · 2 semantic blocker.
 * Reuses the L0 CLI scrub pattern (sanitizeErrorMessage) verbatim — DO NOT
 * reimplement the path regexes; consistency across L0/L1/query is required.
 */

import { sanitizeErrorMessage } from "../../explorer-l0/src/errors.mjs";

/**
 * Base Slice error. Preserves `name` and forwards optional `cause`.
 * @param {string} message
 * @param {{ cause?: unknown }} [options]
 */
export class SliceError extends Error {
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SliceError";
  }
}

/** Infra: store I/O / SQL failure → exit 1. */
export class SliceStoreError extends SliceError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SliceStoreError";
  }
}

/** Semantic blocker: same derivation key + divergent payload → exit 2. */
export class SliceCollisionError extends SliceError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SliceCollisionError";
  }
}

/** Semantic blocker: non-canonical field smuggled into payload → exit 2. */
export class SliceDeterminismError extends SliceError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SliceDeterminismError";
  }
}

/** Infra: unsupported or failed migration → exit 1. */
export class SliceMigrationError extends SliceError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SliceMigrationError";
  }
}

/**
 * Semantic blocker: materialization safety failure → exit 2.
 * Carries an optional `code` (`SAFETY_CEILING` | `MISSING_BASELINE` | `UNRESOLVED_ANCHOR`).
 * @param {string} message
 * @param {{ cause?: unknown, code?: string }} [options]
 */
export class SliceMaterializationError extends SliceError {
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "SliceMaterializationError";
    if (options.code) this.code = options.code;
  }
}

const SEMANTIC_BLOCKERS = new Set([
  SliceCollisionError,
  SliceDeterminismError,
  SliceMaterializationError,
]);

/**
 * Map an error to a process exit code.
 * Semantic Slice blockers → 2; everything else (infra, unknown) → 1; never 0.
 * @param {unknown} err
 * @returns {1 | 2}
 */
export function exitCodeForError(err) {
  for (const Klass of SEMANTIC_BLOCKERS) {
    if (err instanceof Klass) return 2;
  }
  return 1;
}

/**
 * Sanitize a Slice error for CLI stderr. Delegates to the L0 scrubber so the
 * path-handling regexes stay in one place; scrubs POSIX `/Users`, `/home` and
 * Windows drive paths to `<path>` and prefixes the error `name`.
 * @param {unknown} err
 * @returns {string}
 */
export function sanitizeSliceErrorMessage(err) {
  return sanitizeErrorMessage(err);
}
