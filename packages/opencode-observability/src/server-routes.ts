import type { HistoryQueryService } from './history-query';
import type { ListEventsFailureCode, ListEventsInput } from './history-query-contracts';

/**
 * Pure HTTP→query translation layer for the history dashboard (Task 7).
 *
 * TRANSPORT-PURE: no `node:http`, no sockets, no listening, no auth. The
 * server (Task 8) owns sockets, applies `checkOrigin`/`checkBearerAuthorization`
 * and `securityHeaders()` from `server-security.ts` BEFORE calling
 * {@link handleRouteRequest} — routes themselves never check authentication.
 *
 * INPUT contract (`RouteRequest`):
 * - `method` is matched case-sensitively ('GET' exactly; 'get' → 405).
 * - `pathname` starts with '/', carries no search/hash, and is split on '/'
 *   BEFORE decoding (only the dynamic `:sessionID` segment is decoded, so an
 *   encoded '/' cannot alter routing). Server layer builds it from
 *   `new URL(...).pathname`.
 * - `query` is an ordered multimap of search params as pairs — the server
 *   converts via `[...url.searchParams]`.
 *
 * OUTPUT contract (`RouteResponse`): `body` is the FINAL JSON string (already
 * serialized); `headers` is optional and route-level only (`Allow` on 405) —
 * security headers are merged in by the server, never here. Error bodies are
 * EXACTLY `{"error":"<CODE>"}` — no echoed values, tokens, or raw parse text.
 *
 * QUERY VALIDATION (strict boundary — parse, don't validate):
 * - unknown key → `PARAM_INVALID`; duplicate single-value key → `PARAM_AMBIGUOUS`
 *   (never first-value-wins); required key absent → `PARAM_MISSING`;
 *   any present-but-invalid value (empty string, non-exact boolean, bad enum)
 *   → `PARAM_INVALID`.
 * - booleans: exactly `true`/`false` lowercase.
 * - `limit`: integer string `/^-?\d+$/` → parsed and range-checked by the REAL
 *   query layer; any other shape → `LIMIT_INVALID` at the route (one uniform
 *   code for every limit problem).
 * - `cursor`: non-empty opaque string passed through untouched — the real
 *   decoder/compatibility checks produce `CURSOR_INVALID`/`CURSOR_SCOPE_MISMATCH`/`DIRECTION_REQUIRED`.
 *
 * `GET /events/stream` is RECOGNIZED but returns the frozen 501 marker; SSE
 * params and streaming belong to Task 9, so its query is not validated here.
 */

export type QueryPairs = readonly (readonly [string, string])[];

export interface RouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: QueryPairs;
}

export interface RouteDeps {
  readonly queryService: HistoryQueryService;
  readonly getActiveSessionID: () => string | null;
}

export interface RouteResponse {
  readonly status: number;
  readonly contentType: 'application/json';
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type RouteErrorCode =
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'NOT_IMPLEMENTED'
  | 'PARAM_MISSING'
  | 'PARAM_AMBIGUOUS'
  | 'PARAM_INVALID'
  | 'PATH_INVALID'
  | ListEventsFailureCode;

type ParamCode = 'PARAM_MISSING' | 'PARAM_AMBIGUOUS' | 'PARAM_INVALID' | 'PATH_INVALID';

const healthResponse: RouteResponse = Object.freeze({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
const notFoundResponse: RouteResponse = Object.freeze({ status: 404, contentType: 'application/json', body: '{"error":"NOT_FOUND"}' });
const methodNotAllowedResponse: RouteResponse = Object.freeze({
  status: 405,
  contentType: 'application/json',
  body: '{"error":"METHOD_NOT_ALLOWED"}',
  headers: Object.freeze({ Allow: 'GET' })
});
const notImplementedResponse: RouteResponse = Object.freeze({ status: 501, contentType: 'application/json', body: '{"error":"NOT_IMPLEMENTED"}' });

function jsonOk(value: unknown): RouteResponse {
  return { status: 200, contentType: 'application/json', body: JSON.stringify(value) };
}

function errorResponse(status: number, code: RouteErrorCode): RouteResponse {
  return { status, contentType: 'application/json', body: JSON.stringify({ error: code }) };
}

/** Strict single-value parse of the query multimap against `knownKeys`. */
function parseQuery(
  query: QueryPairs,
  knownKeys: readonly string[]
): { ok: true; values: Readonly<Record<string, string>> } | { ok: false; code: 'PARAM_INVALID' | 'PARAM_AMBIGUOUS' } {
  const values: Record<string, string> = {};
  for (const pair of query) {
    const key = pair[0];
    if (!knownKeys.includes(key)) return { ok: false, code: 'PARAM_INVALID' };
    if (key in values) return { ok: false, code: 'PARAM_AMBIGUOUS' };
    values[key] = pair[1];
  }
  return { ok: true, values };
}

function requiredString(values: Readonly<Record<string, string>>, key: string): { ok: true; value: string } | { ok: false; code: ParamCode } {
  const raw = values[key];
  if (raw === undefined) return { ok: false, code: 'PARAM_MISSING' };
  if (raw === '') return { ok: false, code: 'PARAM_INVALID' };
  return { ok: true, value: raw };
}

function parseBool(raw: string): { ok: true; value: boolean } | { ok: false; code: 'PARAM_INVALID' } {
  if (raw === 'true') return { ok: true, value: true };
  if (raw === 'false') return { ok: true, value: false };
  return { ok: false, code: 'PARAM_INVALID' };
}

function optionalBool(raw: string | undefined): { ok: true; value: boolean } | { ok: false; code: 'PARAM_INVALID' } {
  return raw === undefined ? { ok: true, value: false } : parseBool(raw);
}

/** Decodes the URL-encoded dynamic path segment; malformed escapes → typed 400 code. */
function decodeSessionID(segment: string): { ok: true; value: string } | { ok: false; code: 'PATH_INVALID' } {
  try {
    return { ok: true, value: decodeURIComponent(segment) };
  } catch {
    return { ok: false, code: 'PATH_INVALID' };
  }
}

function handleHealth(_params: Readonly<Record<string, string>>, query: QueryPairs): RouteResponse {
  return parseQuery(query, []).ok ? healthResponse : errorResponse(400, 'PARAM_INVALID');
}

function handleBootstrap(_params: Readonly<Record<string, string>>, query: QueryPairs, deps: RouteDeps): RouteResponse {
  if (!parseQuery(query, []).ok) return errorResponse(400, 'PARAM_INVALID');
  return jsonOk(deps.queryService.projectBootstrap({ activeSessionID: deps.getActiveSessionID() }));
}

function handleRoots(_params: Readonly<Record<string, string>>, query: QueryPairs, deps: RouteDeps): RouteResponse {
  const parsed = parseQuery(query, ['includeSystem']);
  if (!parsed.ok) return errorResponse(400, parsed.code);
  const includeSystem = optionalBool(parsed.values['includeSystem']);
  if (!includeSystem.ok) return errorResponse(400, includeSystem.code);
  return jsonOk({ roots: deps.queryService.listRoots({ includeSystem: includeSystem.value }) });
}

function handleTree(params: Readonly<Record<string, string>>, query: QueryPairs, deps: RouteDeps): RouteResponse {
  const raw = params['sessionID'];
  if (raw === undefined) return notFoundResponse;
  const decoded = decodeSessionID(raw);
  if (!decoded.ok) return errorResponse(400, decoded.code);
  const parsed = parseQuery(query, ['includeSystem']);
  if (!parsed.ok) return errorResponse(400, parsed.code);
  const includeSystem = optionalBool(parsed.values['includeSystem']);
  if (!includeSystem.ok) return errorResponse(400, includeSystem.code);
  const tree = deps.queryService.getTree(decoded.value, { includeSystem: includeSystem.value });
  return tree.ok ? jsonOk({ tree: tree.root }) : errorResponse(404, tree.code);
}

const EVENTS_KNOWN_KEYS = ['rootSessionID', 'selectedSessionID', 'scope', 'includeSystem', 'direction', 'cursor', 'limit'] as const;

function handleEvents(_params: Readonly<Record<string, string>>, query: QueryPairs, deps: RouteDeps): RouteResponse {
  const parsed = parseQuery(query, EVENTS_KNOWN_KEYS);
  if (!parsed.ok) return errorResponse(400, parsed.code);
  const values = parsed.values;

  const scope = requiredString(values, 'scope');
  if (!scope.ok) return errorResponse(400, scope.code);
  if (scope.value !== 'all' && scope.value !== 'session' && scope.value !== 'subtree') return errorResponse(400, 'PARAM_INVALID');
  if (scope.value === 'all') {
    if (values['rootSessionID'] !== undefined || values['selectedSessionID'] !== undefined) return errorResponse(400, 'PARAM_INVALID');
  } else {
    for (const key of ['rootSessionID', 'selectedSessionID']) {
      const required = requiredString(values, key);
      if (!required.ok) return errorResponse(400, required.code);
    }
  }
  const includeSystem = values['includeSystem'] === undefined
    ? { ok: false as const, code: 'PARAM_MISSING' as const }
    : parseBool(values['includeSystem']);
  if (!includeSystem.ok) return errorResponse(400, includeSystem.code);

  const direction = values['direction'];
  if (direction !== undefined && direction !== 'older' && direction !== 'newer') return errorResponse(400, 'PARAM_INVALID');
  const cursor = values['cursor'];
  if (cursor === '') return errorResponse(400, 'PARAM_INVALID');
  const limitRaw = values['limit'];
  if (limitRaw !== undefined && !/^-?\d+$/.test(limitRaw)) return errorResponse(400, 'LIMIT_INVALID');

  const input: ListEventsInput = {
    ...(scope.value === 'all' ? {} : { rootSessionID: values['rootSessionID'], selectedSessionID: values['selectedSessionID'] }),
    scope: scope.value,
    includeSystem: includeSystem.value,
    ...(direction !== undefined ? { direction } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(limitRaw !== undefined ? { limit: Number(limitRaw) } : {})
  };
  const result = deps.queryService.listEvents(input);
  return result.ok ? jsonOk(result.page) : errorResponse(400, result.code);
}

type RouteHandler = (params: Readonly<Record<string, string>>, query: QueryPairs, deps: RouteDeps) => RouteResponse;

interface RoutePattern {
  readonly method: 'GET';
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

const routes: readonly RoutePattern[] = [
  { method: 'GET', segments: ['health'], handler: handleHealth },
  { method: 'GET', segments: ['bootstrap'], handler: handleBootstrap },
  { method: 'GET', segments: ['sessions', 'roots'], handler: handleRoots },
  { method: 'GET', segments: ['sessions', ':sessionID', 'tree'], handler: handleTree },
  { method: 'GET', segments: ['events'], handler: handleEvents },
  { method: 'GET', segments: ['events', 'stream'], handler: () => notImplementedResponse }
];

function matchPattern(pattern: RoutePattern, segments: readonly string[]): Readonly<Record<string, string>> | null {
  if (pattern.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.segments.length; i++) {
    const spec = pattern.segments[i];
    const segment = segments[i];
    if (spec === undefined || segment === undefined) return null;
    if (spec.startsWith(':')) {
      params[spec.slice(1)] = segment;
    } else if (spec !== segment) {
      return null;
    }
  }
  return params;
}

/** Pure router: translates a request shape into a typed JSON response. */
export function handleRouteRequest(request: RouteRequest, deps: RouteDeps): RouteResponse {
  if (!request.pathname.startsWith('/')) return notFoundResponse;
  const segments = request.pathname.slice(1).split('/');
  for (const pattern of routes) {
    const params = matchPattern(pattern, segments);
    if (params === null) continue;
    return request.method === pattern.method
      ? pattern.handler(params, request.query, deps)
      : methodNotAllowedResponse;
  }
  return notFoundResponse;
}
