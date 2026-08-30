export class L1Error extends Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "L1Error";
  }
}

export class FrontierError extends L1Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, options);
    this.name = "FrontierError";
  }
}

export class MatchError extends L1Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, options);
    this.name = "MatchError";
  }
}

export class SystemStoreError extends L1Error {
  /** @param {string} message @param {{ cause?: unknown }} [options] */
  constructor(message, options = {}) {
    super(message, options);
    this.name = "SystemStoreError";
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
export function sanitizeErrorMessage(err) {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .replace(/\/Users\/[^\s:]+/g, "<path>")
    .replace(/\/home\/[^\s:]+/g, "<path>")
    .replace(/\/private\/var\/[^\s:]+/g, "<path>")
    .replace(/\/var\/folders\/[^\s:]+/g, "<path>");
}
