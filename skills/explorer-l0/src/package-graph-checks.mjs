/**
 * Graph-structure checks for store-boundary package integrity.
 */

import { artifactEvidenceResolves } from "./coverage-metrics.mjs";
import { StoreError } from "./errors.mjs";
import { stableStringify } from "./stable-json.mjs";

/**
 * @param {object[]} items
 * @param {string} label
 */
export function assertUniqueIds(items, label) {
  const seen = new Set();
  for (const item of items) {
    if (typeof item?.id !== "string" || item.id === "") {
      throw new StoreError(`${label} missing id`);
    }
    if (seen.has(item.id)) {
      throw new StoreError(`duplicate ${label} id: ${item.id}`);
    }
    seen.add(item.id);
  }
}

/**
 * @param {object[]} records
 * @param {object[]} relations
 */
export function assertRelationEndpoints(records, relations) {
  const ids = new Set(records.map((r) => r.id));
  for (const rel of relations) {
    if (!ids.has(rel.from_record)) {
      throw new StoreError(
        `relation ${rel.id}: from_record missing from record set: ${rel.from_record}`,
      );
    }
    if (!ids.has(rel.to_record)) {
      throw new StoreError(
        `relation ${rel.id}: to_record missing from record set: ${rel.to_record}`,
      );
    }
  }
}

/**
 * @param {object[]} entities
 * @param {object} manifest
 */
export function assertArtifactEvidence(entities, manifest) {
  for (const entity of entities) {
    if (!Array.isArray(entity.evidence)) continue;
    for (const ev of entity.evidence) {
      if (ev?.kind === "artifact" && !artifactEvidenceResolves(ev, manifest)) {
        throw new StoreError(
          `artifact evidence does not resolve against manifest for ${entity.id}`,
        );
      }
    }
  }
}

/**
 * @param {string[]} actual
 * @param {string[]} expected
 * @param {string} label
 */
export function assertSortedIdList(actual, expected, label) {
  if (!Array.isArray(actual)) {
    throw new StoreError(`graph_index.${label} must be an array`);
  }
  const want = [...expected].sort();
  const got = [...actual];
  if (stableStringify(got) !== stableStringify(want)) {
    throw new StoreError(`graph_index.${label} does not match graph content`);
  }
}

/**
 * @param {object} pkg
 * @param {string} ns
 * @param {string} repo
 * @param {string} rev
 */
export function assertIdentityAlignment(pkg, ns, repo, rev) {
  if (pkg.artifact_manifest.namespace !== ns) {
    throw new StoreError("artifact_manifest.namespace mismatch with package.namespace");
  }
  if (pkg.artifact_manifest.logical_repo !== repo) {
    throw new StoreError("artifact_manifest.logical_repo mismatch with package.logical_repo");
  }
  if (pkg.artifact_manifest.source_revision !== rev) {
    throw new StoreError("artifact_manifest.source_revision mismatch with package.source_revision");
  }
  if (pkg.graph_index.namespace !== ns) {
    throw new StoreError("graph_index.namespace mismatch with package.namespace");
  }
  if (pkg.graph_index.source_revision !== rev) {
    throw new StoreError("graph_index.source_revision mismatch with package.source_revision");
  }
  if (pkg.coverage_report.namespace !== ns) {
    throw new StoreError("coverage_report.namespace mismatch with package.namespace");
  }
  if (pkg.coverage_report.source_revision !== rev) {
    throw new StoreError("coverage_report.source_revision mismatch with package.source_revision");
  }
  for (const rec of pkg.records) {
    if (rec.namespace !== ns || rec.source_revision !== rev) {
      throw new StoreError(`record ${rec.id}: namespace/source_revision mismatch`);
    }
  }
  for (const rel of pkg.relations) {
    if (rel.namespace !== ns || rel.source_revision !== rev) {
      throw new StoreError(`relation ${rel.id}: namespace/source_revision mismatch`);
    }
  }
}
