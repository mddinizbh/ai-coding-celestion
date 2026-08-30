/**
 * Skill-local Explorer payload schema validator.
 * Loads the closed contract JSON from skills/descobrir/contracts/ at runtime,
 * reusing the zero-dependency interpreter (no external schema library).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { validateInstance } from "./interpret.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = join(here, "..", "..", "contracts", "explorer-payload.schema.json");

let cached = null;

function loadSchema() {
  if (cached === null) {
    cached = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
  }
  return cached;
}

/**
 * @param {unknown} instance
 * @returns {{ valid: boolean, errors: { path: string, message: string }[] }}
 */
export function validateExplorerPayloadSchema(instance) {
  return validateInstance(instance, loadSchema());
}
