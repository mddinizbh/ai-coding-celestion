/**
 * Frontier adapter: route-manifest YAML (demo runtime `demo.yaml`).
 *
 * Exists to fix a direction bug, not just to add a format. The generic YAML
 * rules treat any `"/api/..."` string literal as an OUTBOUND call. In a route
 * manifest those entries are the app's OWN INBOUND routes, so the system graph
 * ends up with arrows pointing the wrong way — and any edge it produces matches
 * by accident.
 *
 * Shape recognised:
 *   rules:
 *     - path: "/api/auth/login"
 *       methods: ["POST"]
 *
 * `methods: ["*"]` is deliberately NOT expanded into concrete verbs: inventing
 * GET/POST/PUT for a wildcard would fabricate contracts that nobody declared.
 * Those routes are counted and reported as skipped instead.
 */

export const id = "route-manifest-yaml";

const MANIFEST_BASENAMES = new Set(["demo.yaml", "demo.yml"]);

/** @param {string} file */
export function matches(file) {
  const base = (file.split("/").pop() || file).toLowerCase();
  return MANIFEST_BASENAMES.has(base);
}

export function describes() {
  return {
    id,
    language: "yaml",
    reads: ["demo.yaml", "demo.yml"],
    emits: ["http_inbound"],
    recognizes: ['rules: - path: "/api/..." + methods: ["POST"]'],
    blind_to: [
      'routes declared with methods: ["*"] (wildcard verbs are not invented)',
      "outbound calls (those live in the handler/client code)",
      "route manifests of other runtimes",
    ],
  };
}

/**
 * @param {string} text
 * @param {string} file
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @param {{ contractKey: Function, normalizeHttpPath: Function, normalizeMethod: Function }} helpers
 */
export function extract(text, file, meta, helpers) {
  if (typeof text !== "string" || text === "") return [];
  const { contractKey, normalizeHttpPath, normalizeMethod } = helpers;
  const lines = text.split(/\r?\n/);
  const facts = [];

  for (let i = 0; i < lines.length; i += 1) {
    const pathMatch = lines[i].match(/^\s*-\s*path:\s*["']([^"']+)["']/);
    if (!pathMatch) continue;
    const rawPath = pathMatch[1];
    if (!rawPath.startsWith("/")) continue;

    /** @type {string[]} */
    let methods = [];
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j += 1) {
      if (/^\s*-\s*path:/.test(lines[j])) break;
      const mm = lines[j].match(/^\s*methods:\s*\[([^\]]*)\]/);
      if (mm) {
        methods = mm[1]
          .split(",")
          .map((s) => s.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean);
        break;
      }
    }
    if (methods.length === 0) continue;
    // wildcard verbs are not contracts — do not invent them
    methods = methods.filter((m) => m !== "*");
    if (methods.length === 0) continue;

    const path = normalizeHttpPath(rawPath);
    for (const method of methods) {
      const nm = normalizeMethod(method);
      facts.push({
        kind: "http_inbound",
        namespace: meta.namespace,
        logical_repo: meta.logical_repo,
        source_revision: meta.source_revision,
        method: nm,
        path,
        contract_key: contractKey(nm, path),
        trigger: "http-sync",
        interaction: "http",
        file,
        line: i + 1,
        evidence_snippet: lines[i].trim().slice(0, 200),
      });
    }
  }
  return facts;
}

export default { id, matches, extract, describes };
