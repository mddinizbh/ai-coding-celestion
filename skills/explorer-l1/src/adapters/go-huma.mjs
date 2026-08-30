/**
 * Frontier adapter: Go + huma (`huma.Register(api, huma.Operation{...})`).
 *
 * First non-JVM adapter. Exists to prove the adapter seam as much as to support
 * Go: the Spring/Micronaut rules stay untouched in `frontier-extract.mjs` and
 * this file owns every Go-specific assumption.
 *
 * Deterministic, no LLM: reads the pinned revision's bytes and emits
 * `http_inbound` facts with file:line evidence.
 *
 * Known limits (documented on purpose, see `describes()`):
 * - only `huma.Operation{}` literals; routes registered through a helper that
 *   builds the Operation elsewhere are not seen
 * - `Method:` must be `http.MethodX` or a quoted verb
 * - outbound Go calls (http.Client, resty, ...) are NOT extracted yet
 */

const OPERATION_OPEN = "huma.Operation{";
const MAX_LOOKAHEAD = 24;

const GO_METHOD_CONST = {
  MethodGet: "GET",
  MethodHead: "HEAD",
  MethodPost: "POST",
  MethodPut: "PUT",
  MethodPatch: "PATCH",
  MethodDelete: "DELETE",
  MethodOptions: "OPTIONS",
};

export const id = "go-huma";

/** @param {string} file */
export function matches(file) {
  return /\.go$/i.test(file) && !/_test\.go$/i.test(file);
}

/** Human-readable coverage contract, surfaced by `frontier report`. */
export function describes() {
  return {
    id: "go-huma",
    language: "go",
    reads: ["*.go (excluding *_test.go)"],
    emits: ["http_inbound"],
    recognizes: ["huma.Register(_, huma.Operation{ Method: http.MethodX, Path: \"...\" })"],
    blind_to: [
      "Operation literals built outside the Register call",
      "outbound HTTP calls from Go code",
      "Kafka publish/consume in Go",
    ],
  };
}

/**
 * @param {string} text   file contents at the pinned revision
 * @param {string} file   repo-relative path
 * @returns {{ method: string, path: string, operation_id: string|null, line: number }[]}
 */
export function scanOperations(text, file) {
  if (typeof text !== "string" || text === "") return [];
  if (!text.includes(OPERATION_OPEN)) return [];
  const lines = text.split(/\r?\n/);
  /** @type {{ method: string, path: string, operation_id: string|null, line: number }[]} */
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].includes(OPERATION_OPEN)) continue;
    let method = null;
    let path = null;
    let operationId = null;
    const limit = Math.min(i + MAX_LOOKAHEAD, lines.length);
    for (let j = i; j < limit; j += 1) {
      const line = lines[j];
      const constMatch = line.match(/Method:\s*http\.(Method[A-Za-z]+)/);
      if (constMatch) method = GO_METHOD_CONST[constMatch[1]] || null;
      const literalMatch = line.match(/Method:\s*"([A-Za-z]+)"/);
      if (!method && literalMatch) method = literalMatch[1].toUpperCase();
      const pathMatch = line.match(/Path:\s*"([^"]+)"/);
      if (pathMatch) path = pathMatch[1];
      const opMatch = line.match(/OperationID:\s*"([^"]+)"/);
      if (opMatch) operationId = opMatch[1];
      // The composite literal closes on the first line that starts with `}` —
      // covers both `})` and `}, s.Handler)`. Without this the scan bleeds into
      // the next Register block and reports the wrong route.
      if (j > i && /^\s*\}/.test(line)) break;
    }
    if (!method || !path) continue;
    out.push({ method, path, operation_id: operationId, line: i + 1 });
  }
  return out;
}

/**
 * Adapter entrypoint. Mirrors the shape used by the JVM rules in
 * `frontier-extract.mjs`: returns facts WITHOUT `id`; the caller stamps ids
 * through the shared `makeFrontierFactId` so identity stays owned by one place.
 *
 * @param {string} text
 * @param {string} file
 * @param {{ namespace: string, logical_repo: string, source_revision: string }} meta
 * @param {{ contractKey: Function, normalizeHttpPath: Function, normalizeMethod: Function }} helpers
 */
export function extract(text, file, meta, helpers) {
  const { contractKey, normalizeHttpPath, normalizeMethod } = helpers;
  return scanOperations(text, file).map((op) => {
    const method = normalizeMethod(op.method);
    const path = normalizeHttpPath(op.path);
    return {
      kind: "http_inbound",
      namespace: meta.namespace,
      logical_repo: meta.logical_repo,
      source_revision: meta.source_revision,
      method,
      path,
      contract_key: contractKey(method, path),
      trigger: "http-sync",
      interaction: "http",
      file,
      line: op.line,
      evidence_snippet:
        `huma.Register ${op.operation_id || ""} ${op.method} ${op.path}`.trim().slice(0, 200),
    };
  });
}

export default { id: "go-huma", matches, extract, describes, scanOperations };
