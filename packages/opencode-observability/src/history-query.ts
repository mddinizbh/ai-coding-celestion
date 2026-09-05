import type { SessionHistoryEvent, SessionLineage } from './history-domain';
import {
  HISTORY_CURSOR_VERSION,
  checkCompatibility,
  compareBoundaries,
  decodeHistoryCursor,
  encodeHistoryCursor,
  type HistoryCursorBoundary,
  type HistoryCursorContext
} from './history-cursor';
import {
  EVENT_PAGE_LIMIT_DEFAULT,
  EVENT_PAGE_LIMIT_MAX,
  type BootstrapProjection,
  type ListEventsInput,
  type ListEventsResult,
  type ProjectBootstrapInput
} from './history-query-contracts';
import { buildSessionLineageForest } from './lineage-tree';
import type { LineageNode } from './lineage-tree';
import { hasValidHistoryScope } from './history-scope';

/**
 * Narrow read port for lineage queries. `HistoryPersistence` satisfies this
 * structurally via its public `listLineages()` — the pure logic below never
 * depends on the persistence class itself.
 */
export type HistoryLineageSource = {
  listLineages(): readonly SessionLineage[];
};

/** Domain-metadata-only summary of a root session (no parent pointer, no event data). */
export interface LineageRootSummary {
  readonly sessionID: string;
  readonly sanitizedTitle: string;
  readonly agent: string | null;
  readonly kind: SessionLineage['kind'];
  readonly observedAtMs: number;
}

/**
 * Root session summaries of the visible forest, in forest order
 * (`observedAtMs` asc, then `sessionID` asc per `buildSessionLineageForest`).
 * With `includeSystem: false` (default), hidden system roots are replaced by
 * their promoted visible descendants; cycle members and missing-parent
 * orphans surface as roots. Pure: never mutates `lineages`.
 */
export function listLineageRoots(
  lineages: readonly SessionLineage[],
  { includeSystem = false }: { includeSystem?: boolean } = {}
): readonly LineageRootSummary[] {
  const forest = buildSessionLineageForest(lineages, { includeSystem });
  return forest.roots.map((r) => ({
    sessionID: r.sessionID,
    sanitizedTitle: r.sanitizedTitle,
    agent: r.agent,
    kind: r.kind,
    observedAtMs: r.observedAtMs
  }));
}

export type GetLineageTreeResult =
  | { readonly ok: true; readonly root: LineageNode }
  | { readonly ok: false; readonly code: 'ROOT_UNKNOWN' };

/**
 * Recursive visible `LineageNode` tree for `rootSessionID`, reusing the M2
 * forest output (promotion semantics included). Fails `ROOT_UNKNOWN` when the
 * ID is not a visible root of the forest — including the case where the raw
 * root exists but is a system node hidden by `includeSystem: false`.
 * Pure: never mutates `lineages`.
 */
export function getLineageTree(
  lineages: readonly SessionLineage[],
  rootSessionID: string,
  { includeSystem = false }: { includeSystem?: boolean } = {}
): GetLineageTreeResult {
  const forest = buildSessionLineageForest(lineages, { includeSystem });
  const root = forest.roots.find((r) => r.sessionID === rootSessionID);
  return root ? { ok: true, root } : { ok: false, code: 'ROOT_UNKNOWN' };
}

export type LineageScope = 'all' | 'session' | 'subtree';

export interface LineageScopeQuery {
  readonly rootSessionID?: string | undefined;
  readonly selectedSessionID?: string | undefined;
  readonly scope: LineageScope;
  /** Default `false` — matches `buildSessionLineageForest`. */
  readonly includeSystem?: boolean;
}

export type ScopeFailureCode =
  | 'SCOPE_INVALID'
  | 'ROOT_UNKNOWN'
  | 'SESSION_NOT_UNDER_ROOT'
  | 'SESSION_HIDDEN'
  | 'SESSION_UNKNOWN';

export type ResolveScopeResult =
  | { readonly ok: true; readonly sessionIDs: readonly string[] }
  | { readonly ok: false; readonly code: ScopeFailureCode };

/**
 * Resolve dashboard scope membership against the visible forest.
 *
 * Membership ORDER (deterministic): pre-order depth-first traversal of the
 * selected node in the M2 visible forest — the selected session first, then
 * descendants children-first, siblings by `observedAtMs` then `sessionID`.
 * `session` scope yields exactly `[selectedSessionID]`.
 * `all` percorre todas as raízes visíveis e não recebe IDs de seleção.
 *
 * Failure codes, checked in this order:
 * 1. `ROOT_UNKNOWN` — `rootSessionID` is not a visible root (unknown, or a
 *    system root hidden by `includeSystem: false`).
 * 2. `SESSION_NOT_UNDER_ROOT` — selected session is visible in the forest but
 *    under a different root.
 * 3. `SESSION_HIDDEN` — selected session exists (first occurrence wins for
 *    duplicates) but is a system node hidden by `includeSystem: false`; a
 *    hidden node has no visible root membership, so this wins over
 *    `SESSION_NOT_UNDER_ROOT` regardless of its raw parent.
 * 4. `SESSION_UNKNOWN` — no lineage with that sessionID at all.
 *
 * Pure: no mutation, no exceptions, no storage access, no content logging.
 */
export function resolveScope(lineages: readonly SessionLineage[], query: LineageScopeQuery): ResolveScopeResult {
  if (!hasValidHistoryScope(query)) return { ok: false, code: 'SCOPE_INVALID' };
  const includeSystem = query.includeSystem ?? false;
  const forest = buildSessionLineageForest(lineages, { includeSystem });
  if (query.scope === 'all') return { ok: true, sessionIDs: forest.roots.flatMap(preorderIDs) };
  const root = forest.roots.find((r) => r.sessionID === query.rootSessionID);
  if (!root) return { ok: false, code: 'ROOT_UNKNOWN' };
  if (query.selectedSessionID === undefined) return { ok: false, code: 'SESSION_UNKNOWN' };

  const selected = findNode(root, query.selectedSessionID);
  if (!selected) {
    if (findInForest(forest.roots, query.selectedSessionID)) {
      return { ok: false, code: 'SESSION_NOT_UNDER_ROOT' };
    }
    const firstOccurrence = lineages.find((l) => l.sessionID === query.selectedSessionID);
    if (firstOccurrence && firstOccurrence.kind === 'system' && !includeSystem) {
      return { ok: false, code: 'SESSION_HIDDEN' };
    }
    return { ok: false, code: 'SESSION_UNKNOWN' };
  }

  switch (query.scope) {
    case 'session':
      return { ok: true, sessionIDs: [selected.sessionID] };
    case 'subtree':
      return { ok: true, sessionIDs: preorderIDs(selected) };
  }
}

export interface HistoryLineageQueryService {
  listRoots(options?: { includeSystem?: boolean }): readonly LineageRootSummary[];
  getTree(rootSessionID: string, options?: { includeSystem?: boolean }): GetLineageTreeResult;
  resolveScope(query: LineageScopeQuery): ResolveScopeResult;
}

/**
 * Tiny service binding the pure query functions to a lineage source.
 * Pass a `HistoryPersistence` instance (structural match) or any test double.
 */
export function createHistoryLineageQuery(source: HistoryLineageSource): HistoryLineageQueryService {
  return {
    listRoots: (options) => listLineageRoots(source.listLineages(), options),
    getTree: (rootSessionID, options) => getLineageTree(source.listLineages(), rootSessionID, options),
    resolveScope: (query) => resolveScope(source.listLineages(), query)
  };
}

/**
 * Read port for event pagination and bootstrap projection. `HistoryPersistence`
 * satisfies this structurally via `listLineages()` + `getAllEvents()`.
 */
export type HistoryEventReadSource = HistoryLineageSource & {
  getAllEvents(): ReadonlyArray<SessionHistoryEvent>;
};

/**
 * Stable keyset pagination over sanitized history events.
 *
 * Contract:
 * 1. Scope membership is resolved FIRST via `resolveScope`; its typed failures
 *    (`ROOT_UNKNOWN`, `SESSION_NOT_UNDER_ROOT`, `SESSION_HIDDEN`,
 *    `SESSION_UNKNOWN`) propagate unchanged.
 * 2. `limit` defaults to {@link EVENT_PAGE_LIMIT_DEFAULT} (200) and must be an
 *    integer in 1..200 — anything else fails `LIMIT_INVALID`.
 * 3. Events are filtered to `event.sessionID ∈ scope membership`, then sorted
 *    ascending by the canonical tuple `(timestampMs, sessionID, runID, sequence)`
 *    via `compareBoundaries`.
 * 4. No cursor: the NEWEST `limit` matching events, returned ascending;
 *    `hasMore` = older events exist beyond the page.
 * 5. With cursor: decode (`CURSOR_INVALID`), then `checkCompatibility` against
 *    root/selected/scope/includeSystem/direction (`CURSOR_SCOPE_MISMATCH`).
 *    A cursor without `direction` fails `DIRECTION_REQUIRED` — cursors are
 *    direction-bound.
 * 6. `older`: events STRICTLY BEFORE the boundary, newest `limit` of those,
 *    ascending; `hasMore` = more older events remain.
 * 7. `newer`: events STRICTLY AFTER the boundary, oldest `limit`, ascending;
 *    `hasMore` = more newer events remain.
 *
 * nextCursor boundary rule (lossless + duplicate-free in BOTH directions):
 * `nextCursor` points at the page edge the next request reads BEYOND — the
 * FIRST (oldest) event of the page for `older` continuation, the LAST (newest)
 * event for `newer` continuation. Initial (cursor-less) pages always continue
 * `older`, so they carry the oldest event of the page. Because both directions
 * select STRICTLY before/after the boundary, every walk visits each matching
 * event exactly once. `nextCursor` is emitted only while `hasMore` is true
 * (`null` on the final or an empty page).
 * `newerCursor` avança após o último evento de qualquer página não vazia,
 * inclusive a última, para polling e conexão inicial de SSE no mesmo escopo.
 *
 * `resolvedRunID`: `session` scope only — returned when ALL matching events of
 * the selected session share exactly one `runID` (computed over the full
 * matching set, so it is stable across pages); omitted otherwise. `subtree`
 * scope NEVER returns a singular run ID.
 *
 * Events are returned as-is (already sanitized); inputs are never mutated.
 * Failures are sanitized codes only — never cursor payload fragments.
 */
export function listEvents(source: HistoryEventReadSource, input: ListEventsInput): ListEventsResult {
  const limit = input.limit ?? EVENT_PAGE_LIMIT_DEFAULT;
  if (!Number.isInteger(limit) || limit < 1 || limit > EVENT_PAGE_LIMIT_MAX) {
    return { ok: false, code: 'LIMIT_INVALID' };
  }
  const direction: 'older' | 'newer' = input.direction ?? 'older';
  if (input.cursor !== undefined && input.direction === undefined) return { ok: false, code: 'DIRECTION_REQUIRED' };
  const scope = resolveScope(source.listLineages(), input);
  if (!scope.ok) return { ok: false, code: scope.code };

  const context: HistoryCursorContext = {
    rootSessionID: input.rootSessionID,
    selectedSessionID: input.selectedSessionID,
    scope: input.scope,
    includeSystem: input.includeSystem,
    direction
  };
  const membership = new Set(scope.sessionIDs);
  const matching = source.getAllEvents()
    .filter((e) => membership.has(e.sessionID))
    .sort((a, b) => compareBoundaries(boundaryOf(a), boundaryOf(b)));

  let view: readonly SessionHistoryEvent[] = matching;
  if (input.cursor !== undefined) {
    const decoded = decodeHistoryCursor(input.cursor);
    if (!decoded.ok) return { ok: false, code: decoded.code };
    const compatible = checkCompatibility(decoded.value, context);
    if (!compatible.ok) return { ok: false, code: compatible.code };
    const boundary = decoded.value.boundary;
    view = matching.filter((e) => {
      const cmp = compareBoundaries(boundaryOf(e), boundary);
      return direction === 'newer' ? cmp > 0 : cmp < 0;
    });
  }

  const events = direction === 'newer' ? view.slice(0, limit) : view.slice(-limit);
  const hasMore = view.length > events.length;
  let nextCursor: string | null = null;
  if (hasMore && events.length > 0) {
    const edge = direction === 'newer' ? events[events.length - 1] : events[0];
    if (edge !== undefined) {
      nextCursor = encodeHistoryCursor({ version: HISTORY_CURSOR_VERSION, ...context, boundary: boundaryOf(edge) });
    }
  }

  const resolvedRunID = input.scope === 'session' ? uniqueRunID(matching) : undefined;
  const page = resolvedRunID === undefined
     ? { events, hasMore, nextCursor }
     : { events, hasMore, nextCursor, resolvedRunID };
  const newest = events.at(-1);
  return { ok: true, page: {
    ...page,
    ...(newest === undefined ? {} : { newerCursor: encodeHistoryCursor({ version: HISTORY_CURSOR_VERSION, ...context, direction: 'newer', boundary: boundaryOf(newest) }) })
  } };
}

/**
 * Initial dashboard projection.
 *
 * `roots`: `listLineageRoots` semantics (default `includeSystem=false`).
 * `activeRootSessionID`: parent-chain walk of `activeSessionID` up to its root;
 * a missing parent or a cycle anywhere in the chain degrades to the ACTIVE
 * session itself (orphan-root semantics); unknown or null active session →
 * null. Duplicate lineage IDs resolve first-occurrence-wins.
 * `cursor`: encoded newest-boundary of ALL retained events (global, including
 * sessions without lineages), direction `newer` — null only when there are no
 * events. When the active session is known the cursor context anchors to it
 * (root = walked active root, selected = active session, subtree); otherwise
 * the context degrades to the newest event's own session for both fields. The
 * SSE reconnect path later validates this boundary payload against its stream
 * scope.
 */
export function projectBootstrap(
  source: HistoryEventReadSource,
  input: ProjectBootstrapInput
): BootstrapProjection {
  const lineages = source.listLineages();
  const activeRootSessionID = activeRootOf(lineages, input.activeSessionID);
  return {
    roots: listLineageRoots(lineages),
    activeRootSessionID,
    cursor: newestEventCursor(source.getAllEvents(), input.activeSessionID, activeRootSessionID)
  };
}

export interface HistoryQueryService extends HistoryLineageQueryService {
  listEvents(input: ListEventsInput): ListEventsResult;
  projectBootstrap(input: ProjectBootstrapInput): BootstrapProjection;
}

/** Unified query service binding all pure projections to one event read source. */
export function createHistoryQuery(source: HistoryEventReadSource): HistoryQueryService {
  const lineage = createHistoryLineageQuery(source);
  return {
    listRoots: lineage.listRoots,
    getTree: lineage.getTree,
    resolveScope: lineage.resolveScope,
    listEvents: (input) => listEvents(source, input),
    projectBootstrap: (input) => projectBootstrap(source, input)
  };
}

function boundaryOf(e: SessionHistoryEvent): HistoryCursorBoundary {
  return { timestampMs: e.timestampMs, sessionID: e.sessionID, runID: e.runID, sequence: e.sequence };
}

function uniqueRunID(events: readonly SessionHistoryEvent[]): string | undefined {
  const first = events.at(0);
  if (first === undefined) return undefined;
  return events.every((e) => e.runID === first.runID) ? first.runID : undefined;
}

function activeRootOf(lineages: readonly SessionLineage[], activeSessionID: string | null): string | null {
  if (activeSessionID === null) return null;
  const byID = new Map<string, SessionLineage>();
  for (const l of lineages) if (!byID.has(l.sessionID)) byID.set(l.sessionID, l);
  if (!byID.has(activeSessionID)) return null;
  const visited = new Set<string>([activeSessionID]);
  let current = byID.get(activeSessionID);
  while (current !== undefined) {
    const parent = current.parentSessionID;
    if (parent === null) return current.sessionID;
    if (visited.has(parent)) return activeSessionID;
    visited.add(parent);
    current = byID.get(parent);
  }
  return activeSessionID;
}

function newestEventCursor(
  events: ReadonlyArray<SessionHistoryEvent>,
  activeSessionID: string | null,
  activeRootSessionID: string | null
): string | null {
  let newest: SessionHistoryEvent | undefined;
  for (const e of events) {
    if (newest === undefined || compareBoundaries(boundaryOf(e), boundaryOf(newest)) > 0) newest = e;
  }
  if (newest === undefined) return null;
  return encodeHistoryCursor({
    version: HISTORY_CURSOR_VERSION,
    rootSessionID: activeRootSessionID ?? newest.sessionID,
    selectedSessionID: activeSessionID ?? newest.sessionID,
    scope: 'subtree',
    includeSystem: false,
    direction: 'newer',
    boundary: boundaryOf(newest)
  });
}

function findNode(node: LineageNode, sessionID: string): LineageNode | undefined {
  if (node.sessionID === sessionID) return node;
  for (const child of node.children) {
    const found = findNode(child, sessionID);
    if (found) return found;
  }
  return undefined;
}

function findInForest(roots: readonly LineageNode[], sessionID: string): LineageNode | undefined {
  for (const root of roots) {
    const found = findNode(root, sessionID);
    if (found) return found;
  }
  return undefined;
}

function preorderIDs(node: LineageNode): readonly string[] {
  const ids: string[] = [];
  const walk = (current: LineageNode): void => {
    ids.push(current.sessionID);
    for (const child of current.children) walk(child);
  };
  walk(node);
  return ids;
}
