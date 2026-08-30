/**
 * Bottom-up L2 pipeline: propose-from-l1 → enrich-from-l0 → bind.
 */

import { bindJourney } from "./journey-bind.mjs";
import { enrichFromL0, loadAcceptedPackagesWith } from "./enrich-from-l0.mjs";
import { proposeFromL1 } from "./propose-from-l1.mjs";

/**
 * @param {{
 *   edges: object[],
 *   system_namespace: string,
 *   namespace?: string,
 *   journey_id?: string,
 *   from_repo?: string,
 *   to_repo?: string,
 *   min_score?: number,
 *   packages_by_repo?: Record<string, { records: object[], relations?: object[] }>,
 *   exportPackage?: Function,
 *   l0Store?: object,
 *   skip_enrich?: boolean,
 * }} input
 */
export function synthesizeJourney(input) {
  const proposed = proposeFromL1(input.edges, {
    system_namespace: input.system_namespace,
    journey_id: input.journey_id,
    from_repo: input.from_repo,
    to_repo: input.to_repo,
    min_score: input.min_score,
  });

  let packages = input.packages_by_repo || {};
  if (
    !input.skip_enrich &&
    Object.keys(packages).length === 0 &&
    input.exportPackage &&
    input.l0Store &&
    input.namespace
  ) {
    packages = loadAcceptedPackagesWith(
      input.exportPackage,
      input.l0Store,
      input.namespace,
      proposed.spec.members,
    );
  }

  let enriched = {
    spec: proposed.spec,
    warnings: [],
    stats: { steps_with_anchors: 0, hotspot_steps: 0, warning_count: 0 },
  };

  if (!input.skip_enrich) {
    enriched = enrichFromL0(proposed.spec, { packages_by_repo: packages });
  }

  const bind = bindJourney(enriched.spec, input.edges);

  return {
    pipeline: "propose-from-l1 → enrich-from-l0 → bind",
    propose: proposed.stats,
    enrich: enriched.stats,
    warnings: enriched.warnings || [],
    claims_blocked_until_body_read:
      enriched.spec.enrichment?.claims_blocked_until_body_read ||
      enriched.spec.pipeline?.claims_blocked_until_body_read ||
      [],
    read_plan: enriched.spec.read_plan || [],
    spec: enriched.spec,
    bind,
  };
}
