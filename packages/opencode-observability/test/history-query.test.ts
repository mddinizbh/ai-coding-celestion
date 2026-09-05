import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SessionHistoryEvent, SessionLineage } from '../src/history-domain';
import type { LineageNode } from '../src/lineage-tree';
import {
  compareBoundaries,
  decodeHistoryCursor,
  encodeHistoryCursor,
  HISTORY_CURSOR_VERSION,
  type HistoryCursorBoundary,
  type HistoryCursorContext
} from '../src/history-cursor';
import type { ListEventsInput } from '../src/history-query-contracts';
import {
  createHistoryLineageQuery,
  createHistoryQuery,
  getLineageTree,
  listEvents,
  listLineageRoots,
  projectBootstrap,
  resolveScope,
  type HistoryEventReadSource,
  type HistoryLineageSource
} from '../src/history-query';

function make(over: Partial<SessionLineage> & { sessionID: string }): SessionLineage {
  return {
    parentSessionID: over.parentSessionID ?? null,
    agent: over.agent ?? null,
    sanitizedTitle: over.sanitizedTitle ?? 't',
    kind: over.kind ?? 'work',
    observedAtMs: over.observedAtMs ?? 0,
    sessionID: over.sessionID
  } satisfies SessionLineage;
}

function flattenIDs(nodes: readonly LineageNode[]): string[] {
  const out: string[] = [];
  const walk = (ns: readonly LineageNode[]) => {
    for (const n of ns) {
      out.push(n.sessionID);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

function treeIDs(lineages: readonly SessionLineage[], rootSessionID: string, includeSystem = false): string[] {
  const t = getLineageTree(lineages, rootSessionID, { includeSystem });
  assert.ok(t.ok, `expected tree for ${rootSessionID}`);
  return flattenIDs([t.root]);
}

function seededShuffle<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  const next = (): number => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a !== undefined && b !== undefined) {
      out[i] = b;
      out[j] = a;
    }
  }
  return out;
}

const ids = (ls: readonly SessionLineage[]): string[] => ls.map((l) => l.sessionID);

// Main fixture: two visible roots; rootA has system nodes at two depths.
// rootA(10) -> sysB(system,20) -> workC(30) -> workE(31) -> sysF(system,32) -> workG(33)
// rootA -> workD(40)
// rootX(5) -> x1(50)
const mainLineages: readonly SessionLineage[] = [
  make({ sessionID: 'rootA', sanitizedTitle: 'a-root', agent: 'build', observedAtMs: 10 }),
  make({ sessionID: 'sysB', parentSessionID: 'rootA', kind: 'system', sanitizedTitle: 'b-sys', observedAtMs: 20 }),
  make({ sessionID: 'workC', parentSessionID: 'sysB', sanitizedTitle: 'c-work', agent: 'coder', observedAtMs: 30 }),
  make({ sessionID: 'workE', parentSessionID: 'workC', observedAtMs: 31 }),
  make({ sessionID: 'sysF', parentSessionID: 'workE', kind: 'system', observedAtMs: 32 }),
  make({ sessionID: 'workG', parentSessionID: 'sysF', observedAtMs: 33 }),
  make({ sessionID: 'workD', parentSessionID: 'rootA', observedAtMs: 40 }),
  make({ sessionID: 'rootX', sanitizedTitle: 'x-root', agent: 'build', observedAtMs: 5 }),
  make({ sessionID: 'x1', parentSessionID: 'rootX', observedAtMs: 50 })
];

// rootX(5) sorts before rootA(10) in forest order.
const mainRoots = [
  { sessionID: 'rootX', sanitizedTitle: 'x-root', agent: 'build', kind: 'work' as const, observedAtMs: 5 },
  { sessionID: 'rootA', sanitizedTitle: 'a-root', agent: 'build', kind: 'work' as const, observedAtMs: 10 }
];

const systemRootLineages: readonly SessionLineage[] = [
  make({ sessionID: 'sysR', kind: 'system', observedAtMs: 1 }),
  make({ sessionID: 'w1', parentSessionID: 'sysR', observedAtMs: 2 }),
  make({ sessionID: 'w2', parentSessionID: 'sysR', observedAtMs: 3 })
];

const cycleOrphanLineages: readonly SessionLineage[] = [
  make({ sessionID: 'a', parentSessionID: 'b', observedAtMs: 1 }),
  make({ sessionID: 'b', parentSessionID: 'a', observedAtMs: 2 }),
  make({ sessionID: 'm', parentSessionID: 'ghost', observedAtMs: 5 })
];

const unknownKindLineages: readonly SessionLineage[] = [
  make({ sessionID: 'u', kind: 'unknown', observedAtMs: 7 })
];

const dupeLineages: readonly SessionLineage[] = [
  make({ sessionID: 'x', sanitizedTitle: 'first', observedAtMs: 1 }),
  make({ sessionID: 'x', sanitizedTitle: 'second', observedAtMs: 99 })
];

describe('listLineageRoots (roots projection)', () => {
  it('returns empty array for empty input', () => {
    assert.deepStrictEqual(listLineageRoots([]), []);
  });

  it('lists visible roots in forest order with domain-metadata-only summaries', () => {
    const roots = listLineageRoots(mainLineages);
    assert.deepStrictEqual(roots, mainRoots);
    const first = roots[0];
    assert.ok(first !== undefined && !('parentSessionID' in first), 'summary must not leak parentSessionID');
  });

  it('promotes children of hidden system root when includeSystem=false', () => {
    const roots = listLineageRoots(systemRootLineages, { includeSystem: false });
    assert.deepStrictEqual(roots, [
      { sessionID: 'w1', sanitizedTitle: 't', agent: null, kind: 'work', observedAtMs: 2 },
      { sessionID: 'w2', sanitizedTitle: 't', agent: null, kind: 'work', observedAtMs: 3 }
    ]);
  });

  it('shows system root when includeSystem=true', () => {
    const roots = listLineageRoots(systemRootLineages, { includeSystem: true });
    assert.deepStrictEqual(roots.map((r) => r.sessionID), ['sysR']);
    assert.equal(roots[0]?.kind, 'system');
  });

  it('keeps unknown kind visible as a root', () => {
    const roots = listLineageRoots(unknownKindLineages);
    assert.deepStrictEqual(roots, [
      { sessionID: 'u', sanitizedTitle: 't', agent: null, kind: 'unknown', observedAtMs: 7 }
    ]);
  });

  it('surfaces missing-parent orphan as a root', () => {
    const roots = listLineageRoots(cycleOrphanLineages);
    assert.ok(roots.some((r) => r.sessionID === 'm'));
  });

  it('surfaces cycle members as roots', () => {
    const roots = listLineageRoots(cycleOrphanLineages);
    assert.deepStrictEqual(roots.map((r) => r.sessionID), ['a', 'b', 'm']);
  });

  it('dedupes duplicate sessionID lineages (first wins) without ghost roots', () => {
    const roots = listLineageRoots(dupeLineages);
    assert.deepStrictEqual(roots, [
      { sessionID: 'x', sanitizedTitle: 'first', agent: null, kind: 'work', observedAtMs: 1 }
    ]);
  });

  it('is deterministic across shuffled input arrays', () => {
    const s1 = seededShuffle(mainLineages, 7);
    const s2 = seededShuffle(mainLineages, 20260904);
    assert.notDeepStrictEqual(ids(s1), ids(mainLineages));
    assert.notDeepStrictEqual(ids(s2), ids(mainLineages));
    assert.deepStrictEqual(listLineageRoots(s1), mainRoots);
    assert.deepStrictEqual(listLineageRoots(s2), mainRoots);
  });
});

describe('getLineageTree (tree projection)', () => {
  it('fails ROOT_UNKNOWN for unknown root session', () => {
    assert.deepStrictEqual(getLineageTree(mainLineages, 'nope'), { ok: false, code: 'ROOT_UNKNOWN' });
  });

  it('fails ROOT_UNKNOWN for empty input', () => {
    assert.deepStrictEqual(getLineageTree([], 'rootA'), { ok: false, code: 'ROOT_UNKNOWN' });
  });

  it('fails ROOT_UNKNOWN when the ID is a visible non-root child', () => {
    assert.deepStrictEqual(getLineageTree(mainLineages, 'workD'), { ok: false, code: 'ROOT_UNKNOWN' });
  });

  it('fails ROOT_UNKNOWN when the root is a hidden system node (includeSystem=false)', () => {
    assert.deepStrictEqual(getLineageTree(systemRootLineages, 'sysR', { includeSystem: false }), {
      ok: false,
      code: 'ROOT_UNKNOWN'
    });
  });

  it('returns nested visible descendants with system nodes promoted (includeSystem=false)', () => {
    assert.deepStrictEqual(treeIDs(mainLineages, 'rootA'), ['rootA', 'workC', 'workE', 'workG', 'workD']);
  });

  it('returns full tree including system nodes when includeSystem=true', () => {
    assert.deepStrictEqual(treeIDs(mainLineages, 'rootA', true), [
      'rootA', 'sysB', 'workC', 'workE', 'sysF', 'workG', 'workD'
    ]);
  });

  it('returns system root tree when includeSystem=true', () => {
    assert.deepStrictEqual(treeIDs(systemRootLineages, 'sysR', true), ['sysR', 'w1', 'w2']);
  });

  it('returns single-node tree for a childless root and shallow tree for a two-node root', () => {
    assert.deepStrictEqual(treeIDs(unknownKindLineages, 'u'), ['u']);
    assert.deepStrictEqual(treeIDs(mainLineages, 'rootX'), ['rootX', 'x1']);
  });

  it('returns trees for cycle-member and orphan roots', () => {
    assert.deepStrictEqual(treeIDs(cycleOrphanLineages, 'a'), ['a']);
    assert.deepStrictEqual(treeIDs(cycleOrphanLineages, 'm'), ['m']);
  });

  it('is deterministic across shuffled input arrays', () => {
    const s1 = seededShuffle(mainLineages, 13);
    const s2 = seededShuffle(mainLineages, 424242);
    assert.notDeepStrictEqual(ids(s1), ids(mainLineages));
    assert.deepStrictEqual(treeIDs(s1, 'rootA'), ['rootA', 'workC', 'workE', 'workG', 'workD']);
    assert.deepStrictEqual(treeIDs(s2, 'rootA'), ['rootA', 'workC', 'workE', 'workG', 'workD']);
  });
});

describe('resolveScope — session scope', () => {
  it('returns exactly the selected visible session (not its children)', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'workC', scope: 'session', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['workC'] });
  });

  it('selecting the root itself resolves to the root alone', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'session', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['rootA'] });
  });

  it('selects a system session when includeSystem=true', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'sysB', scope: 'session', includeSystem: true
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['sysB'] });
  });

  it('selects an unknown-kind session', () => {
    const r = resolveScope(unknownKindLineages, {
      rootSessionID: 'u', selectedSessionID: 'u', scope: 'session', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['u'] });
  });

  it('selects a session over a cycle-member root and an orphan root', () => {
    assert.deepStrictEqual(
      resolveScope(cycleOrphanLineages, { rootSessionID: 'a', selectedSessionID: 'a', scope: 'session' }),
      { ok: true, sessionIDs: ['a'] }
    );
    assert.deepStrictEqual(
      resolveScope(cycleOrphanLineages, { rootSessionID: 'm', selectedSessionID: 'm', scope: 'session' }),
      { ok: true, sessionIDs: ['m'] }
    );
  });

  const sessionScopeFailures: ReadonlyArray<{
    readonly name: string;
    readonly lineages: readonly SessionLineage[];
    readonly query: { readonly rootSessionID: string; readonly selectedSessionID: string; readonly includeSystem: boolean };
    readonly code: 'ROOT_UNKNOWN' | 'SESSION_UNKNOWN' | 'SESSION_NOT_UNDER_ROOT' | 'SESSION_HIDDEN';
  }> = [
    {
      name: 'unknown selected session → SESSION_UNKNOWN',
      lineages: mainLineages,
      query: { rootSessionID: 'rootA', selectedSessionID: 'nope', includeSystem: false },
      code: 'SESSION_UNKNOWN'
    },
    {
      name: 'selected session visible but under a different root → SESSION_NOT_UNDER_ROOT',
      lineages: mainLineages,
      query: { rootSessionID: 'rootA', selectedSessionID: 'x1', includeSystem: false },
      code: 'SESSION_NOT_UNDER_ROOT'
    },
    {
      name: 'selected session is a different root → SESSION_NOT_UNDER_ROOT',
      lineages: mainLineages,
      query: { rootSessionID: 'rootA', selectedSessionID: 'rootX', includeSystem: false },
      code: 'SESSION_NOT_UNDER_ROOT'
    },
    {
      name: 'selected session is a hidden nested system node → SESSION_HIDDEN',
      lineages: mainLineages,
      query: { rootSessionID: 'rootA', selectedSessionID: 'sysB', includeSystem: false },
      code: 'SESSION_HIDDEN'
    },
    {
      name: 'selected session is a hidden deep system node → SESSION_HIDDEN',
      lineages: mainLineages,
      query: { rootSessionID: 'rootA', selectedSessionID: 'sysF', includeSystem: false },
      code: 'SESSION_HIDDEN'
    },
    {
      name: 'root itself unknown → ROOT_UNKNOWN (root check precedes session checks)',
      lineages: mainLineages,
      query: { rootSessionID: 'nope', selectedSessionID: 'workC', includeSystem: false },
      code: 'ROOT_UNKNOWN'
    },
    {
      name: 'root is a hidden system root → ROOT_UNKNOWN even though selection is a promoted child',
      lineages: systemRootLineages,
      query: { rootSessionID: 'sysR', selectedSessionID: 'w1', includeSystem: false },
      code: 'ROOT_UNKNOWN'
    }
  ];

  for (const c of sessionScopeFailures) {
    it(`session scope failure: ${c.name}`, () => {
      const r = resolveScope(c.lineages, { ...c.query, scope: 'session' });
      assert.deepStrictEqual(r, { ok: false, code: c.code });
    });
  }
});

describe('resolveScope — subtree scope', () => {
  it('A→B(system)→C(work): subtree from A includes C but not B when includeSystem=false', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['rootA', 'workC', 'workE', 'workG', 'workD'] });
  });

  it('same subtree with includeSystem=true includes the system nodes', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: true
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['rootA', 'sysB', 'workC', 'workE', 'sysF', 'workG', 'workD'] });
  });

  it('subtree from a work node excludes nested system nodes but includes their promoted visible descendants', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'workC', scope: 'subtree', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['workC', 'workE', 'workG'] });
  });

  it('subtree from a system node resolves when includeSystem=true', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'sysB', scope: 'subtree', includeSystem: true
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['sysB', 'workC', 'workE', 'sysF', 'workG'] });
  });

  it('subtree of a leaf resolves to the leaf alone', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'workD', scope: 'subtree', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['workD'] });
  });

  it('subtree over cycle-member and orphan roots resolves with correct membership', () => {
    assert.deepStrictEqual(
      resolveScope(cycleOrphanLineages, { rootSessionID: 'a', selectedSessionID: 'a', scope: 'subtree' }),
      { ok: true, sessionIDs: ['a'] }
    );
    assert.deepStrictEqual(
      resolveScope(cycleOrphanLineages, { rootSessionID: 'b', selectedSessionID: 'b', scope: 'subtree' }),
      { ok: true, sessionIDs: ['b'] }
    );
    assert.deepStrictEqual(
      resolveScope(cycleOrphanLineages, { rootSessionID: 'm', selectedSessionID: 'm', scope: 'subtree' }),
      { ok: true, sessionIDs: ['m'] }
    );
  });

  it('duplicate sessionID lineages yield single-member subtree without ghosts', () => {
    const r = resolveScope(dupeLineages, {
      rootSessionID: 'x', selectedSessionID: 'x', scope: 'subtree', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: true, sessionIDs: ['x'] });
  });

  it('fails ROOT_UNKNOWN before session checks when root is unknown', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'nope', selectedSessionID: 'workC', scope: 'subtree', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: false, code: 'ROOT_UNKNOWN' });
  });

  it('fails SESSION_NOT_UNDER_ROOT when subtree selection belongs to a different root', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'x1', scope: 'subtree', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: false, code: 'SESSION_NOT_UNDER_ROOT' });
  });

  it('fails SESSION_HIDDEN when subtree selection is a hidden system node', () => {
    const r = resolveScope(mainLineages, {
      rootSessionID: 'rootA', selectedSessionID: 'sysB', scope: 'subtree', includeSystem: false
    });
    assert.deepStrictEqual(r, { ok: false, code: 'SESSION_HIDDEN' });
  });

  it('is deterministic across shuffled input arrays', () => {
    const s1 = seededShuffle(mainLineages, 99);
    const s2 = seededShuffle(mainLineages, 314159);
    const expected = { ok: true, sessionIDs: ['rootA', 'workC', 'workE', 'workG', 'workD'] };
    assert.deepStrictEqual(
      resolveScope(s1, { rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree' }),
      expected
    );
    assert.deepStrictEqual(
      resolveScope(s2, { rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree' }),
      expected
    );
  });
});

describe('createHistoryLineageQuery (port-bound service)', () => {
  const source: HistoryLineageSource = { listLineages: () => mainLineages };

  it('delegates roots, tree, and scope to the pure functions over the source', () => {
    const service = createHistoryLineageQuery(source);
    assert.deepStrictEqual(service.listRoots(), listLineageRoots(mainLineages));
    assert.deepStrictEqual(service.getTree('rootA', { includeSystem: false }), getLineageTree(mainLineages, 'rootA'));
    assert.deepStrictEqual(
      service.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'workC', scope: 'subtree' }),
      { ok: true, sessionIDs: ['workC', 'workE', 'workG'] }
    );
    assert.deepStrictEqual(service.resolveScope({ rootSessionID: 'nope', selectedSessionID: 'x', scope: 'session' }), {
      ok: false,
      code: 'ROOT_UNKNOWN'
    });
  });
});

describe('purity (inputs never mutated)', () => {
  it('all three functions leave frozen lineage inputs untouched', () => {
    const input = Object.freeze([
      Object.freeze(make({ sessionID: 'p1', observedAtMs: 1 })),
      Object.freeze(make({ sessionID: 'p2', parentSessionID: 'p1', observedAtMs: 2 }))
    ]);
    const snapshot = input.map((l) => ({ ...l }));
    listLineageRoots(input);
    getLineageTree(input, 'p1');
    resolveScope(input, { rootSessionID: 'p1', selectedSessionID: 'p2', scope: 'subtree' });
    assert.deepStrictEqual(input, snapshot);
  });
});

// ---------------------------------------------------------------------------
// listEvents + projectBootstrap (Task 3)
// ---------------------------------------------------------------------------

const ev = (sessionID: string, runID: string, sequence: number, timestampMs: number): SessionHistoryEvent =>
  ({ eventID: `${sessionID}:${runID}:${sequence}`, runID, sessionID, sequence, timestampMs, type: 'run.started', parentSessionID: null }) satisfies SessionHistoryEvent;

const sourceOf = (lineages: readonly SessionLineage[], events: readonly SessionHistoryEvent[] = []): HistoryEventReadSource => ({
  listLineages: () => lineages,
  getAllEvents: () => events
});

const toB = (e: SessionHistoryEvent): HistoryCursorBoundary =>
  ({ timestampMs: e.timestampMs, sessionID: e.sessionID, runID: e.runID, sequence: e.sequence });

const sortedByBoundary = (es: readonly SessionHistoryEvent[]): SessionHistoryEvent[] =>
  [...es].sort((a, b) => compareBoundaries(toB(a), toB(b)));

const eventIDs = (es: readonly SessionHistoryEvent[]): string[] => es.map((e) => e.eventID);

const syntheticCursor = (boundary: HistoryCursorBoundary, context: HistoryCursorContext): string =>
  encodeHistoryCursor({ version: HISTORY_CURSOR_VERSION, ...context, boundary });

function assertAscending(es: readonly SessionHistoryEvent[]): void {
  for (let i = 1; i < es.length; i++) {
    const prev = es[i - 1];
    const curr = es[i];
    assert.ok(prev !== undefined && curr !== undefined, 'index access within bounds');
    assert.ok(compareBoundaries(toB(prev), toB(curr)) < 0, `page must be strictly ascending at index ${i}`);
  }
}

function assertPage(r: ReturnType<typeof listEvents>): asserts r is Extract<ReturnType<typeof listEvents>, { ok: true }> {
  assert.ok(r.ok, `expected listEvents success, got failure ${r.ok ? '' : r.code}`);
  assertAscending(r.page.events);
}

function collectWalk(
  source: HistoryEventReadSource,
  base: Omit<ListEventsInput, 'cursor' | 'direction'>,
  direction: 'older' | 'newer',
  startCursor: string | null,
  limit?: number
): SessionHistoryEvent[] {
  const collected: SessionHistoryEvent[] = [];
  let cursor: string | null = startCursor;
  let guard = 0;
  const input: ListEventsInput = { ...base, direction, limit };
  while (cursor !== null) {
    assert.ok(++guard < 1000, 'walk must terminate');
    const r = listEvents(source, { ...input, cursor });
    assertPage(r);
    collected.push(...r.page.events);
    if (!r.page.hasMore) {
      assert.equal(r.page.nextCursor, null, 'exhausted page must carry nextCursor=null');
      cursor = null;
    } else {
      assert.ok(r.page.nextCursor !== null, 'hasMore=true must carry a nextCursor');
      cursor = r.page.nextCursor;
    }
  }
  return collected;
}

function assertWalkExactlyOnce(walked: readonly SessionHistoryEvent[], expected: readonly SessionHistoryEvent[], label: string): void {
  const ids = eventIDs(walked);
  assert.equal(ids.length, new Set(ids).size, `${label}: no eventID may repeat within the walk`);
  assert.deepStrictEqual(sortedByBoundary(walked), sortedByBoundary(expected), `${label}: walk must cover the full matching multiset exactly once`);
}

// Pagination fixture: visible rootR subtree (includeSystem=false) = rootR, c1, deep, c2, quiet.
// rootO/o1 sit outside rootR. `quiet` has lineages but zero events.
const pagLineages: readonly SessionLineage[] = [
  make({ sessionID: 'rootR', sanitizedTitle: 'r', observedAtMs: 1 }),
  make({ sessionID: 'c1', parentSessionID: 'rootR', observedAtMs: 2 }),
  make({ sessionID: 'deep', parentSessionID: 'c1', observedAtMs: 3 }),
  make({ sessionID: 'c2', parentSessionID: 'rootR', observedAtMs: 4 }),
  make({ sessionID: 'quiet', parentSessionID: 'rootR', observedAtMs: 5 }),
  make({ sessionID: 'rootO', observedAtMs: 6 }),
  make({ sessionID: 'o1', parentSessionID: 'rootO', observedAtMs: 7 })
];

// 9 in-scope events with deliberate equal timestamps ACROSS sessions (ts=1000: c1 vs rootR;
// ts=1003: rootR twice) and ACROSS runs under the SAME session (c1@1000 r1+r2, c2@1001, rootR@1003).
// Canonical ascending order of the in-scope set:
//   (c1,r1,2,1000) (c1,r2,3,1000) (rootR,r1,1,1000) (c2,r1,4,1001) (c2,r2,5,1001)
//   (deep,r1,6,1002) (rootR,r1,7,1003) (rootR,r2,8,1003) (c1,r2,9,1004)
// plus 2 outsider o1 events (ts=999 and ts=1005) that MUST be filtered out.
const tieEvents: readonly SessionHistoryEvent[] = [
  ev('rootR', 'r1', 1, 1000),
  ev('c1', 'r1', 2, 1000),
  ev('c1', 'r2', 3, 1000),
  ev('c2', 'r1', 4, 1001),
  ev('c2', 'r2', 5, 1001),
  ev('deep', 'r1', 6, 1002),
  ev('rootR', 'r1', 7, 1003),
  ev('rootR', 'r2', 8, 1003),
  ev('c1', 'r2', 9, 1004),
  ev('o1', 'r9', 10, 999),
  ev('o1', 'r9', 11, 1005)
];

const pagSource = sourceOf(pagLineages, tieEvents);

const subtreeBase = { rootSessionID: 'rootR', selectedSessionID: 'rootR', scope: 'subtree' as const, includeSystem: false };
const olderCtx: HistoryCursorContext = { ...subtreeBase, direction: 'older' };
const newerCtx: HistoryCursorContext = { ...subtreeBase, direction: 'newer' };
const belowAllBoundary: HistoryCursorBoundary = { timestampMs: 0, sessionID: 'a', runID: 'a', sequence: 0 };

describe('listEvents — limit validation', () => {
  it('default limit is 200: initial page returns the newest 200 of 540 matching, hasMore=true', () => {
    const events = generateTiedEvents(540);
    const source = sourceOf(bigLineages, [...events, ev('zzOut', 'zr', 900, 999), ev('zzOut', 'zr', 901, 99999)]);
    const r = listEvents(source, { ...subtreeBase, rootSessionID: 'bigRoot', selectedSessionID: 'bigRoot' });
    assertPage(r);
    assert.equal(r.page.events.length, 200);
    assert.equal(r.page.hasMore, true);
    const expected = sortedByBoundary(events); // zzOut events filtered out of scope membership
    assert.deepStrictEqual(toB(r.page.events[0] as SessionHistoryEvent), toB(expected[340] as SessionHistoryEvent));
    assert.deepStrictEqual(toB(r.page.events[199] as SessionHistoryEvent), toB(expected[539] as SessionHistoryEvent));
  });

  it('explicit limit 1 accepted: page is exactly the single newest matching event', () => {
    const r = listEvents(pagSource, { ...subtreeBase, limit: 1 });
    assertPage(r);
    assert.deepStrictEqual(r.page.events, [tieEvents[8]]);
    assert.equal(r.page.hasMore, true);
    const decoded = decodeHistoryCursor(r.page.nextCursor as string);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.value.boundary, { timestampMs: 1004, sessionID: 'c1', runID: 'r2', sequence: 9 });
    assert.equal(decoded.value.direction, 'older');
  });

  it('explicit limit 200 accepted: smaller matching set returns everything, hasMore=false', () => {
    const r = listEvents(pagSource, { ...subtreeBase, limit: 200 });
    assertPage(r);
    assert.equal(r.page.events.length, 9);
    assert.equal(r.page.hasMore, false);
    assert.equal(r.page.nextCursor, null);
  });

  const badLimits: ReadonlyArray<{ readonly name: string; readonly limit: number }> = [
    { name: 'limit 0', limit: 0 },
    { name: 'limit 201', limit: 201 },
    { name: 'negative limit', limit: -5 },
    { name: 'non-integer limit', limit: 2.5 }
  ];
  for (const c of badLimits) {
    it(`rejects ${c.name} with sanitized LIMIT_INVALID`, () => {
      assert.deepStrictEqual(listEvents(pagSource, { ...subtreeBase, limit: c.limit }), { ok: false, code: 'LIMIT_INVALID' });
    });
  }
});

describe('listEvents — initial page (no cursor)', () => {
  it('returns newest limit events re-sorted ascending, outsiders filtered, fixtures returned as-is', () => {
    const r = listEvents(pagSource, { ...subtreeBase, limit: 50 });
    assertPage(r);
    assert.deepStrictEqual(eventIDs(r.page.events), [
      'c1:r1:2', 'c1:r2:3', 'rootR:r1:1', 'c2:r1:4', 'c2:r2:5', 'deep:r1:6', 'rootR:r1:7', 'rootR:r2:8', 'c1:r2:9'
    ]);
    assert.equal(r.page.hasMore, false);
    assert.equal(r.page.nextCursor, null);
    assert.ok(r.page.events[0] === tieEvents[1], 'events must be returned as-is (same references)');
  });

  it('hasMore=true on initial page means older events exist beyond it', () => {
    const r = listEvents(pagSource, { ...subtreeBase, limit: 3 });
    assertPage(r);
    assert.deepStrictEqual(eventIDs(r.page.events), ['rootR:r1:7', 'rootR:r2:8', 'c1:r2:9']);
    assert.equal(r.page.hasMore, true);
  });

  it('session in scope with zero events yields an empty page and omitted resolvedRunID', () => {
    const r = listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'quiet', scope: 'session' });
    assertPage(r);
    assert.deepStrictEqual(r.page, { events: [], hasMore: false, nextCursor: null });
  });
});

describe('listEvents — older pagination', () => {
  const initial = listEvents(pagSource, { ...subtreeBase, limit: 3 });

  it('initial page nextCursor boundary is the OLDEST event of the page, direction-bound older', () => {
    assertPage(initial);
    const next = initial.page.nextCursor;
    assert.ok(next !== null);
    const decoded = decodeHistoryCursor(next);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.value.boundary, { timestampMs: 1003, sessionID: 'rootR', runID: 'r1', sequence: 7 });
    assert.equal(decoded.value.direction, 'older');
  });

  it('older page from that cursor: strictly newer-first tie-broken set, hasMore=true', () => {
    assert.ok(initial.ok);
    const r = listEvents(pagSource, { ...subtreeBase, direction: 'older', cursor: initial.page.nextCursor as string, limit: 3 });
    assertPage(r);
    assert.deepStrictEqual(eventIDs(r.page.events), ['c2:r1:4', 'c2:r2:5', 'deep:r1:6']);
    assert.equal(r.page.hasMore, true);
    const decoded = decodeHistoryCursor(r.page.nextCursor as string);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.value.boundary, { timestampMs: 1001, sessionID: 'c2', runID: 'r1', sequence: 4 });
  });

  it('final older page: hasMore=false and nextCursor=null', () => {
    const cursor = syntheticCursor({ timestampMs: 1001, sessionID: 'c2', runID: 'r1', sequence: 4 }, olderCtx);
    const r = listEvents(pagSource, { ...subtreeBase, direction: 'older', cursor, limit: 3 });
    assertPage(r);
    assert.deepStrictEqual(eventIDs(r.page.events), ['c1:r1:2', 'c1:r2:3', 'rootR:r1:1']);
    assert.equal(r.page.hasMore, false);
    assert.equal(r.page.nextCursor, null);
  });

  it('page newest event is STRICTLY before the requested boundary (no boundary duplication)', () => {
    const boundaryX: HistoryCursorBoundary = { timestampMs: 1001, sessionID: 'c2', runID: 'r1', sequence: 4 };
    const r = listEvents(pagSource, { ...subtreeBase, direction: 'older', cursor: syntheticCursor(boundaryX, olderCtx), limit: 2 });
    assertPage(r);
    const newest = r.page.events[r.page.events.length - 1];
    assert.ok(newest !== undefined);
    assert.ok(compareBoundaries(toB(newest), boundaryX) < 0, 'newest event of the older page must compare strictly before X');
  });

  it('complete older walk from the initial page covers all 9 matching events exactly once', () => {
    assert.ok(initial.ok);
    const start = initial.page.nextCursor;
    assert.ok(start !== null);
    const walked = [initial.page.events, collectWalk(pagSource, subtreeBase, 'older', start, 3)].flat();
    const inScope = tieEvents.filter((e) => e.sessionID !== 'o1');
    assertWalkExactlyOnce(walked, inScope, 'older walk');
  });
});

describe('listEvents — newer pagination', () => {
  it('newer page from below-all boundary takes the OLDEST limit, nextCursor boundary is the NEWEST event of the page', () => {
    const cursor = syntheticCursor(belowAllBoundary, newerCtx);
    const r = listEvents(pagSource, { ...subtreeBase, direction: 'newer', cursor, limit: 4 });
    assertPage(r);
    assert.deepStrictEqual(eventIDs(r.page.events), ['c1:r1:2', 'c1:r2:3', 'rootR:r1:1', 'c2:r1:4']);
    assert.equal(r.page.hasMore, true);
    const decoded = decodeHistoryCursor(r.page.nextCursor as string);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.value.boundary, { timestampMs: 1001, sessionID: 'c2', runID: 'r1', sequence: 4 });
    assert.equal(decoded.value.direction, 'newer');
  });

  it('second newer page continues strictly after the previous page newest event', () => {
    const cursor = syntheticCursor({ timestampMs: 1001, sessionID: 'c2', runID: 'r1', sequence: 4 }, newerCtx);
    const r = listEvents(pagSource, { ...subtreeBase, direction: 'newer', cursor, limit: 4 });
    assertPage(r);
    assert.deepStrictEqual(eventIDs(r.page.events), ['c2:r2:5', 'deep:r1:6', 'rootR:r1:7', 'rootR:r2:8']);
    assert.equal(r.page.hasMore, true);
    const decoded = decodeHistoryCursor(r.page.nextCursor as string);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.value.boundary, { timestampMs: 1003, sessionID: 'rootR', runID: 'r2', sequence: 8 });
  });

  it('final newer page: hasMore=false and nextCursor=null', () => {
    const cursor = syntheticCursor({ timestampMs: 1003, sessionID: 'rootR', runID: 'r2', sequence: 8 }, newerCtx);
    const r = listEvents(pagSource, { ...subtreeBase, direction: 'newer', cursor, limit: 4 });
    assertPage(r);
    assert.deepStrictEqual(eventIDs(r.page.events), ['c1:r2:9']);
    assert.equal(r.page.hasMore, false);
    assert.equal(r.page.nextCursor, null);
  });

  it('complete newer walk from below-all boundary covers all 9 matching events exactly once', () => {
    const walked = collectWalk(pagSource, subtreeBase, 'newer', syntheticCursor(belowAllBoundary, newerCtx), 4);
    const inScope = tieEvents.filter((e) => e.sessionID !== 'o1');
    assertWalkExactlyOnce(walked, inScope, 'newer walk');
  });
});

describe('listEvents — cursor validation (sanitized failures only)', () => {
  it('malformed cursor token → CURSOR_INVALID (charset guard)', () => {
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, direction: 'older', cursor: '### not base64url ###' }),
      { ok: false, code: 'CURSOR_INVALID' }
    );
  });

  it('valid base64url of non-payload JSON → CURSOR_INVALID', () => {
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, direction: 'older', cursor: Buffer.from('abc', 'utf8').toString('base64url') }),
      { ok: false, code: 'CURSOR_INVALID' }
    );
  });

  it('cursor present without direction → DIRECTION_REQUIRED', () => {
    const cursor = syntheticCursor({ timestampMs: 1001, sessionID: 'c2', runID: 'r1', sequence: 4 }, olderCtx);
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, cursor }),
      { ok: false, code: 'DIRECTION_REQUIRED' }
    );
  });

  it('session-scope cursor rejected on subtree request → CURSOR_SCOPE_MISMATCH', () => {
    const session = listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'c1', scope: 'session', limit: 2 });
    assert.ok(session.ok && session.page.nextCursor !== null);
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, direction: 'older', cursor: session.page.nextCursor as string }),
      { ok: false, code: 'CURSOR_SCOPE_MISMATCH' }
    );
  });

  it('subtree cursor rejected on session request → CURSOR_SCOPE_MISMATCH', () => {
    const subtree = listEvents(pagSource, { ...subtreeBase, limit: 3 });
    assert.ok(subtree.ok && subtree.page.nextCursor !== null);
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'rootR', scope: 'session', direction: 'older', cursor: subtree.page.nextCursor as string }),
      { ok: false, code: 'CURSOR_SCOPE_MISMATCH' }
    );
  });

  it('includeSystem flip against a valid cursor → CURSOR_SCOPE_MISMATCH', () => {
    const made = listEvents(pagSource, { ...subtreeBase, limit: 3 });
    assert.ok(made.ok && made.page.nextCursor !== null);
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, includeSystem: true, direction: 'older', cursor: made.page.nextCursor as string }),
      { ok: false, code: 'CURSOR_SCOPE_MISMATCH' }
    );
  });

  it('direction flip against a valid cursor → CURSOR_SCOPE_MISMATCH', () => {
    const made = listEvents(pagSource, { ...subtreeBase, limit: 3 });
    assert.ok(made.ok && made.page.nextCursor !== null);
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, direction: 'newer', cursor: made.page.nextCursor as string }),
      { ok: false, code: 'CURSOR_SCOPE_MISMATCH' }
    );
  });

  it('root and selected flips against a valid cursor → CURSOR_SCOPE_MISMATCH', () => {
    const made = listEvents(pagSource, { ...subtreeBase, limit: 3 });
    assert.ok(made.ok && made.page.nextCursor !== null);
    const cursor = made.page.nextCursor as string;
    assert.deepStrictEqual(
      listEvents(sourceOf(pagLineages, tieEvents), { ...subtreeBase, rootSessionID: 'rootO', selectedSessionID: 'o1', direction: 'older', cursor }),
      { ok: false, code: 'CURSOR_SCOPE_MISMATCH' }
    );
    assert.deepStrictEqual(
      listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'c1', direction: 'older', cursor }),
      { ok: false, code: 'CURSOR_SCOPE_MISMATCH' }
    );
  });

  const scopeFailures: ReadonlyArray<{
    readonly name: string;
    readonly lineages: readonly SessionLineage[];
    readonly input: { readonly rootSessionID: string; readonly selectedSessionID: string; readonly scope: 'session' | 'subtree'; readonly includeSystem: boolean };
    readonly code: 'ROOT_UNKNOWN' | 'SESSION_NOT_UNDER_ROOT' | 'SESSION_HIDDEN' | 'SESSION_UNKNOWN';
  }> = [
    {
      name: 'unknown root → ROOT_UNKNOWN',
      lineages: pagLineages,
      input: { rootSessionID: 'nope', selectedSessionID: 'c1', scope: 'subtree', includeSystem: false },
      code: 'ROOT_UNKNOWN'
    },
    {
      name: 'selected under a different root → SESSION_NOT_UNDER_ROOT',
      lineages: pagLineages,
      input: { rootSessionID: 'rootR', selectedSessionID: 'o1', scope: 'subtree', includeSystem: false },
      code: 'SESSION_NOT_UNDER_ROOT'
    },
    {
      name: 'unknown selected → SESSION_UNKNOWN',
      lineages: pagLineages,
      input: { rootSessionID: 'rootR', selectedSessionID: 'zzz', scope: 'session', includeSystem: false },
      code: 'SESSION_UNKNOWN'
    },
    {
      name: 'hidden system selected → SESSION_HIDDEN',
      lineages: mainLineages,
      input: { rootSessionID: 'rootA', selectedSessionID: 'sysB', scope: 'subtree', includeSystem: false },
      code: 'SESSION_HIDDEN'
    }
  ];
  for (const c of scopeFailures) {
    it(`propagates scope failure: ${c.name}`, () => {
      const source = sourceOf(c.lineages, []);
      assert.deepStrictEqual(listEvents(source, c.input), { ok: false, code: c.code });
    });
  }
});

describe('listEvents — resolvedRunID', () => {
  it('session scope whose matching events share exactly one runID returns it', () => {
    const r = listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'deep', scope: 'session' });
    assertPage(r);
    assert.equal(r.page.resolvedRunID, 'r1');
  });

  it('session scope with multiple runIDs omits resolvedRunID', () => {
    const r = listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'c2', scope: 'session' });
    assertPage(r);
    assert.ok(!('resolvedRunID' in r.page), 'multi-run session must omit resolvedRunID entirely');
  });

  it('session scope with zero matching events omits resolvedRunID', () => {
    const r = listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'quiet', scope: 'session' });
    assertPage(r);
    assert.ok(!('resolvedRunID' in r.page));
  });

  it('subtree scope NEVER returns a singular run ID — even single-session single-run subtree', () => {
    const r = listEvents(pagSource, { ...subtreeBase, selectedSessionID: 'deep', scope: 'subtree' });
    assertPage(r);
    assert.ok(!('resolvedRunID' in r.page), 'subtree scope must always omit resolvedRunID');
  });
});

// 540 matching events: 3 sessions × 2 runs × 90 equal-timestamp groups; sequences globally unique
// so canonical boundaries are unique but timestamps tie across sessions AND runs everywhere.
function generateTiedEvents(count: number): SessionHistoryEvent[] {
  const sessions = ['sessA', 'sessB', 'sessC'];
  const runs = ['run1', 'run2'];
  const out: SessionHistoryEvent[] = [];
  let seq = 0;
  while (out.length < count) {
    const ts = 1000 + Math.floor(out.length / (sessions.length * runs.length));
    for (const s of sessions) {
      for (const r of runs) {
        if (out.length === count) return out;
        seq += 1;
        out.push(ev(s, r, seq, ts));
      }
    }
  }
  return out;
}

const bigLineages: readonly SessionLineage[] = [
  make({ sessionID: 'bigRoot', observedAtMs: 1 }),
  make({ sessionID: 'sessA', parentSessionID: 'bigRoot', observedAtMs: 2 }),
  make({ sessionID: 'sessB', parentSessionID: 'sessA', observedAtMs: 3 }),
  make({ sessionID: 'sessC', parentSessionID: 'sessB', observedAtMs: 4 })
];

describe('listEvents — adversarial exactly-once walks (540 tied events, 3 sessions, 2 runs)', () => {
  const bigBase = { rootSessionID: 'bigRoot', selectedSessionID: 'bigRoot', scope: 'subtree' as const, includeSystem: false };
  const events = generateTiedEvents(540);
  const source = sourceOf(bigLineages, events);

  it('older walk from the initial page to exhaustion visits each matching event exactly once', () => {
    const initial = listEvents(source, { ...bigBase, limit: 37 });
    assertPage(initial);
    assert.equal(initial.page.hasMore, true);
    const start = initial.page.nextCursor;
    assert.ok(start !== null);
    const walked = [initial.page.events, ...[collectWalk(source, bigBase, 'older', start, 37)]].flat();
    assertWalkExactlyOnce(walked, events, 'adversarial older walk');
  });

  it('newer walk from below-all boundary to exhaustion visits each matching event exactly once', () => {
    const anchor = syntheticCursor(belowAllBoundary, { ...bigBase, direction: 'newer' });
    const walked = collectWalk(source, bigBase, 'newer', anchor, 37);
    assertWalkExactlyOnce(walked, events, 'adversarial newer walk');
  });
});

// Bootstrap fixture: deep chain, orphan chain with missing parent, two cycles, self-parent.
const bootLineages: readonly SessionLineage[] = [
  make({ sessionID: 'bRoot', observedAtMs: 10 }),
  make({ sessionID: 'bMid', parentSessionID: 'bRoot', observedAtMs: 20 }),
  make({ sessionID: 'bLeaf', parentSessionID: 'bMid', observedAtMs: 30 }),
  make({ sessionID: 'bOrphan', parentSessionID: 'ghost', observedAtMs: 40 }),
  make({ sessionID: 'bOrphChild', parentSessionID: 'bOrphan', observedAtMs: 41 }),
  make({ sessionID: 'cyc1', parentSessionID: 'cyc2', observedAtMs: 50 }),
  make({ sessionID: 'cyc2', parentSessionID: 'cyc1', observedAtMs: 51 }),
  make({ sessionID: 'cycEntry', parentSessionID: 'cyc1', observedAtMs: 52 }),
  make({ sessionID: 'selfP', parentSessionID: 'selfP', observedAtMs: 60 })
];

const bootEvents: readonly SessionHistoryEvent[] = [
  ev('bRoot', 'r1', 1, 500),
  ev('bLeaf', 'r2', 2, 900),
  ev('stranger', 'r3', 3, 700)
];

describe('projectBootstrap — roots', () => {
  it('roots mirror listLineageRoots with default includeSystem=false', () => {
    const p = projectBootstrap(sourceOf(bootLineages, bootEvents), { activeSessionID: 'bLeaf' });
    assert.deepStrictEqual(p.roots, listLineageRoots(bootLineages));
  });
});

describe('projectBootstrap — activeRootSessionID walk-up', () => {
  const cases: ReadonlyArray<{ readonly name: string; readonly activeSessionID: string | null; readonly expected: string | null }> = [
    { name: 'deep child walks up to its root', activeSessionID: 'bLeaf', expected: 'bRoot' },
    { name: 'mid child walks up to its root', activeSessionID: 'bMid', expected: 'bRoot' },
    { name: 'root maps to itself', activeSessionID: 'bRoot', expected: 'bRoot' },
    { name: 'missing parent in chain degrades to the active session itself', activeSessionID: 'bOrphChild', expected: 'bOrphChild' },
    { name: 'direct orphan degrades to itself', activeSessionID: 'bOrphan', expected: 'bOrphan' },
    { name: 'cycle not through active degrades to the active session itself', activeSessionID: 'cycEntry', expected: 'cycEntry' },
    { name: 'cycle through active degrades to the active session itself', activeSessionID: 'cyc1', expected: 'cyc1' },
    { name: 'self-parent cycle degrades to the active session itself', activeSessionID: 'selfP', expected: 'selfP' },
    { name: 'null active session → null', activeSessionID: null, expected: null },
    { name: 'unknown active session → null', activeSessionID: 'unknownZz', expected: null }
  ];
  for (const c of cases) {
    it(c.name, () => {
      const p = projectBootstrap(sourceOf(bootLineages, bootEvents), { activeSessionID: c.activeSessionID });
      assert.equal(p.activeRootSessionID, c.expected);
    });
  }
});

describe('projectBootstrap — stream-resume cursor', () => {
  it('cursor encodes the NEWEST global event boundary with direction newer and active context', () => {
    const p = projectBootstrap(sourceOf(bootLineages, bootEvents), { activeSessionID: 'bLeaf' });
    assert.ok(p.cursor !== null);
    const decoded = decodeHistoryCursor(p.cursor);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.value, {
      version: HISTORY_CURSOR_VERSION,
      rootSessionID: 'bRoot',
      selectedSessionID: 'bLeaf',
      scope: 'subtree',
      includeSystem: false,
      direction: 'newer',
      boundary: { timestampMs: 900, sessionID: 'bLeaf', runID: 'r2', sequence: 2 }
    });
  });

  it('cursor is global: newest event may belong to a session outside the active lineage', () => {
    const events = [ev('bRoot', 'r1', 1, 500), ev('stranger', 'r9', 2, 9999)];
    const p = projectBootstrap(sourceOf(bootLineages, events), { activeSessionID: 'bLeaf' });
    assert.ok(p.cursor !== null);
    const decoded = decodeHistoryCursor(p.cursor);
    assert.ok(decoded.ok);
    assert.deepStrictEqual(decoded.value.boundary, { timestampMs: 9999, sessionID: 'stranger', runID: 'r9', sequence: 2 });
  });

  it('null active session with events still yields a cursor anchored to the newest event session', () => {
    const p = projectBootstrap(sourceOf(bootLineages, bootEvents), { activeSessionID: null });
    assert.ok(p.cursor !== null);
    const decoded = decodeHistoryCursor(p.cursor);
    assert.ok(decoded.ok);
    assert.equal(decoded.value.rootSessionID, 'bLeaf');
    assert.equal(decoded.value.selectedSessionID, 'bLeaf');
    assert.equal(decoded.value.direction, 'newer');
  });

  it('empty store → cursor null (active root still resolves)', () => {
    const p = projectBootstrap(sourceOf(bootLineages, []), { activeSessionID: 'bLeaf' });
    assert.equal(p.activeRootSessionID, 'bRoot');
    assert.equal(p.cursor, null);
  });
});

describe('createHistoryQuery (unified service over HistoryEventReadSource)', () => {
  it('exposes listRoots/getTree/resolveScope/listEvents/projectBootstrap over one source', () => {
    const source = sourceOf(pagLineages, tieEvents);
    const service = createHistoryQuery(source);
    assert.deepStrictEqual(service.listRoots(), listLineageRoots(pagLineages));
    assert.deepStrictEqual(service.getTree('rootR'), getLineageTree(pagLineages, 'rootR'));
    assert.deepStrictEqual(
      service.resolveScope({ rootSessionID: 'rootR', selectedSessionID: 'c1', scope: 'subtree' }),
      resolveScope(pagLineages, { rootSessionID: 'rootR', selectedSessionID: 'c1', scope: 'subtree' })
    );
    assert.deepStrictEqual(
      service.listEvents({ ...subtreeBase, limit: 3 }),
      listEvents(source, { ...subtreeBase, limit: 3 })
    );
    assert.deepStrictEqual(
      service.projectBootstrap({ activeSessionID: 'c1' }),
      projectBootstrap(source, { activeSessionID: 'c1' })
    );
  });
});

describe('listEvents/projectBootstrap purity (inputs never mutated)', () => {
  it('frozen lineages and events stay untouched across initial, cursored, and bootstrap reads', () => {
    const lineages = Object.freeze(pagLineages.map((l) => Object.freeze({ ...l })));
    const events = Object.freeze(tieEvents.map((e) => Object.freeze({ ...e })));
    const source = sourceOf(lineages, events);
    const initial = listEvents(source, { ...subtreeBase, limit: 3 });
    assert.ok(initial.ok);
    const cursor = initial.page.nextCursor;
    assert.ok(cursor !== null);
    listEvents(source, { ...subtreeBase, direction: 'older', cursor, limit: 3 });
    projectBootstrap(source, { activeSessionID: 'c1' });
    assert.deepStrictEqual(lineages, pagLineages);
    assert.deepStrictEqual(events, tieEvents);
  });
});
