/**
 * Stratified sample of L1 edges by path_match (exact vs template).
 * Does not write the graph.
 */

/**
 * @param {object} edge
 * @returns {"exact" | "template" | "other"}
 */
export function classifyPathMatch(edge) {
  if (edge && edge.path_match === "exact") return "exact";
  if (edge && edge.path_match === "template") return "template";
  return "other";
}

/**
 * @param {object} edge
 */
export function compactEdge(edge) {
  const evidence = Array.isArray(edge.evidence)
    ? edge.evidence.map((ev) => ({
        side: ev.side,
        file: ev.file,
        line: ev.line,
        revision: ev.revision,
      }))
    : [];
  return {
    edge_id: edge.edge_id,
    path_match: classifyPathMatch(edge),
    score: edge.score,
    method: edge.method,
    path: edge.path,
    match_kind: edge.match_kind,
    from: edge.from,
    to: edge.to,
    evidence,
  };
}

/**
 * @param {object[]} edges
 * @param {{ perClass?: number }} [opts]
 */
export function sampleEdges(edges, opts = {}) {
  const perClass = Number.isInteger(opts.perClass) && opts.perClass > 0 ? opts.perClass : 5;
  const list = Array.isArray(edges) ? edges : [];
  const buckets = { exact: [], template: [], other: [] };
  const sorted = [...list].sort((a, b) => {
    const left = String(a.edge_id || "");
    const right = String(b.edge_id || "");
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  for (const edge of sorted) {
    buckets[classifyPathMatch(edge)].push(compactEdge(edge));
  }
  return {
    counts: {
      exact: buckets.exact.length,
      template: buckets.template.length,
      other: buckets.other.length,
      total: list.length,
    },
    sample: {
      exact: buckets.exact.slice(0, perClass),
      template: buckets.template.slice(0, perClass),
    },
  };
}
