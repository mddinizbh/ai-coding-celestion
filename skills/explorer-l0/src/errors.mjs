/**
 * Typed domain errors for the Descobrir skill.
 */

export class DescobrirError extends Error {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "DescobrirError";
  }
}

export class CanonicalIdError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CanonicalIdError";
  }
}

export class ProvenanceError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProvenanceError";
  }
}

export class CandidatePackageError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "CandidatePackageError";
  }
}

export class StoreError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "StoreError";
  }
}

export class ExplorerPayloadError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ExplorerPayloadError";
  }
}

export class AcceptanceError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "AcceptanceError";
  }
}

export class InstallConflictError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "InstallConflictError";
  }
}

export class GitSourceError extends DescobrirError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GitSourceError";
  }
}

export class WorktreeError extends DescobrirError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = "WorktreeError";
  }
}

export class GraphifyToolError extends DescobrirError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown, code?: string }} [options]
   */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : {});
    this.name = "GraphifyToolError";
    if (options.code) /** @type {any} */ (this).code = options.code;
  }
}

export class GraphifyVersionError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GraphifyVersionError";
  }
}

export class GraphifyLoaderError extends DescobrirError {
  /**
   * @param {string} message
   * @param {{ cause?: unknown }} [options]
   */
  constructor(message, options = {}) {
    super(message, options);
    this.name = "GraphifyLoaderError";
  }
}

export class GraphifyProjectionError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "GraphifyProjectionError";
  }
}

export class ProjectionError extends DescobrirError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "ProjectionError";
  }
}

/**
 * Sanitize error text for CLI stderr — strip absolute paths.
 * @param {unknown} err
 * @returns {string}
 */
export function sanitizeErrorMessage(err) {
  const name = err instanceof Error ? err.name : "Error";
  const raw = err instanceof Error ? err.message : String(err);
  const scrubbed = raw
    .replace(/\/Users\/[^\s:]+/g, "<path>")
    .replace(/\/home\/[^\s:]+/g, "<path>")
    .replace(/[A-Za-z]:\\[^\s:]+/g, "<path>");
  return `${name}: ${scrubbed}`;
}
