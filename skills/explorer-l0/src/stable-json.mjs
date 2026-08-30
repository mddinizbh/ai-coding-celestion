/**
 * Stable JSON helpers — deterministic key order and hashing inputs.
 */

import { createHash } from "node:crypto";

/**
 * Deep-sort object keys; arrays keep element order (callers sort set-like arrays).
 * @param {unknown} value
 * @returns {unknown}
 */
export function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(/** @type {Record<string, unknown>} */ (value))
        .sort()
        .map((key) => [
          key,
          stableValue(/** @type {Record<string, unknown>} */ (value)[key]),
        ]),
    );
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stablePretty(value) {
  return `${JSON.stringify(stableValue(value), null, 2)}\n`;
}

/**
 * @param {string} text
 * @returns {string}
 */
export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
