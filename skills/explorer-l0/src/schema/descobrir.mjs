/**
 * Public Descobrir schema validators.
 * Loads self-contained contract JSON from this skill's contracts/ at runtime.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SUPPORTED_KEYWORDS, validateInstance } from "./interpret.mjs";

export { SUPPORTED_KEYWORDS };

const here = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIR = join(here, "..", "..", "contracts");

const SCHEMA_FILES = Object.freeze({
  knowledgeRecord: "knowledge-record.schema.json",
  relation: "relation.schema.json",
  artifactManifest: "artifact-manifest.schema.json",
  graphIndex: "graph-index.schema.json",
  coverageReport: "coverage-report.schema.json",
});

const cache = new Map();

function loadSchema(fileName) {
  if (cache.has(fileName)) {
    return cache.get(fileName);
  }
  const raw = readFileSync(join(CONTRACTS_DIR, fileName), "utf8");
  const schema = JSON.parse(raw);
  cache.set(fileName, schema);
  return schema;
}

function validate(fileName, instance) {
  return validateInstance(instance, loadSchema(fileName));
}

export function validateKnowledgeRecord(instance) {
  return validate(SCHEMA_FILES.knowledgeRecord, instance);
}

export function validateRelation(instance) {
  return validate(SCHEMA_FILES.relation, instance);
}

export function validateArtifactManifest(instance) {
  return validate(SCHEMA_FILES.artifactManifest, instance);
}

export function validateGraphIndex(instance) {
  return validate(SCHEMA_FILES.graphIndex, instance);
}

export function validateCoverageReport(instance) {
  return validate(SCHEMA_FILES.coverageReport, instance);
}
