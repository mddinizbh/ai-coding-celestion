import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareBoundaries, type HistoryCursorBoundary } from '../src/history-cursor';
import type { SessionHistoryEvent, SessionLineage } from '../src/history-domain';
import type { ListEventsInput } from '../src/history-query-contracts';
import { createHistoryQuery, type HistoryEventReadSource, type HistoryQueryService } from '../src/history-query';
import { handleRouteRequest, type QueryPairs, type RouteDeps, type RouteResponse } from '../src/server-routes';

// Fixture makers (same patterns as test/history-query.test.ts).
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

const ev = (sessionID: string, runID: string, sequence: number, timestampMs: number): SessionHistoryEvent =>
  ({ eventID: `${sessionID}:${runID}:${sequence}`, runID, sessionID, sequence, timestampMs, type: 'run.started', parentSessionID: null }) satisfies SessionHistoryEvent;

const sourceOf = (lineages: readonly SessionLineage[], events: readonly SessionHistoryEvent[] = []): HistoryEventReadSource => ({
  listLineages: () => lineages,
  getAllEvents: () => events
});

// Main fixture: rootA(10) -> sysB(system,20) -> workC(30); rootA -> workD(40); rootX(5) -> x1(50).
// Visible subtree of rootA (includeSystem=false): rootA, workC, workD (sysB hidden, workC promoted).
const lineages: readonly SessionLineage[] = [
  make({ sessionID: 'rootA', sanitizedTitle: 'a-root', agent: 'build', observedAtMs: 10 }),
  make({ sessionID: 'sysB', parentSessionID: 'rootA', kind: 'system', sanitizedTitle: 'b-sys', observedAtMs: 20 }),
  make({ sessionID: 'workC', parentSessionID: 'sysB', sanitizedTitle: 'c-work', agent: 'coder', observedAtMs: 30 }),
  make({ sessionID: 'workD', parentSessionID: 'rootA', observedAtMs: 40 }),
  make({ sessionID: 'rootX', sanitizedTitle: 'x-root', agent: 'build', observedAtMs: 5 }),
  make({ sessionID: 'x1', parentSessionID: 'rootX', observedAtMs: 50 })
];

// Canonical ascending in-scope order (x1 events filtered out of every rootA scope):
// rootA:r1:1@1000, workC:r1:2@1001, workC:r1:3@1002, workD:r1:4@1003.
const events: readonly SessionHistoryEvent[] = [
  ev('rootA', 'r1', 1, 1000),
  ev('workC', 'r1', 2, 1001),
  ev('workC', 'r1', 3, 1002),
  ev('workD', 'r1', 4, 1003),
  ev('x1', 'r9', 5, 999),
  ev('x1', 'r9', 6, 1005)
];

const queryService: HistoryQueryService = createHistoryQuery(sourceOf(lineages, events));
const deps: RouteDeps = { queryService, getActiveSessionID: () => 'workC' };
const nullActiveDeps: RouteDeps = { queryService, getActiveSessionID: () => null };

// Hidden-system-root fixture: proves includeSystem passthrough on roots and tree 404s.
const sysRootLineages: readonly SessionLineage[] = [
  make({ sessionID: 'sysR', kind: 'system', observedAtMs: 1 }),
  make({ sessionID: 'w1', parentSessionID: 'sysR', observedAtMs: 2 })
];
const sysDeps: RouteDeps = { queryService: createHistoryQuery(sourceOf(sysRootLineages, [])), getActiveSessionID: () => null };

// URL-encoding fixture: raw session IDs containing '/' and ' ' arrive percent-encoded in the path.
const encodedLineages: readonly SessionLineage[] = [
  make({ sessionID: 'ses_abc/def', observedAtMs: 1 }),
  make({ sessionID: 'ses_a b', observedAtMs: 2 })
];
const encodedDeps: RouteDeps = { queryService: createHistoryQuery(sourceOf(encodedLineages, [])), getActiveSessionID: () => null };

function route(pathname: string, query: QueryPairs = [], method = 'GET', d: RouteDeps = deps): RouteResponse {
  return handleRouteRequest({ method, pathname, query }, d);
}

function jsonBody(response: RouteResponse): unknown {
  return JSON.parse(response.body);
}

function assertError(response: RouteResponse, status: number, code: string, label = code): void {
  assert.equal(response.status, status, `status for ${label}`);
  assert.equal(response.contentType, 'application/json', `contentType for ${label}`);
  assert.deepStrictEqual(jsonBody(response), { error: code }, `body must be exactly {error:'${code}'} for ${label}`);
}

const toB = (e: SessionHistoryEvent): HistoryCursorBoundary =>
  ({ timestampMs: e.timestampMs, sessionID: e.sessionID, runID: e.runID, sequence: e.sequence });

function assertAscending(list: readonly SessionHistoryEvent[]): void {
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1];
    const curr = list[i];
    assert.ok(prev !== undefined && curr !== undefined, 'index within bounds');
    assert.ok(compareBoundaries(toB(prev), toB(curr)) < 0, `events must be ascending at index ${i}`);
  }
}

const eventsBase: readonly (readonly [string, string])[] = [
  ['rootSessionID', 'rootA'],
  ['selectedSessionID', 'rootA'],
  ['scope', 'subtree'],
  ['includeSystem', 'false']
];

const subtreeInput = (over: { direction?: 'older' | 'newer'; cursor?: string; limit?: number } = {}): ListEventsInput => ({
  rootSessionID: 'rootA',
  selectedSessionID: 'rootA',
  scope: 'subtree',
  includeSystem: false,
  ...over
});

function withParam(name: string, value: string): readonly (readonly [string, string])[] {
  return [...eventsBase, [name, value]];
}

function replacingParam(name: string, value: string): readonly (readonly [string, string])[] {
  return eventsBase.map(([key, v]) => [key, key === name ? value : v] as const);
}

function withoutParam(name: string): readonly (readonly [string, string])[] {
  return eventsBase.filter(([key]) => key !== name);
}

describe('GET /health', () => {
  it('returns exactly {"ok":true} with no extra headers or body fields', () => {
    const response = route('/health');
    assert.equal(response.status, 200);
    assert.equal(response.contentType, 'application/json');
    assert.equal(response.body, '{"ok":true}');
    assert.equal(response.headers, undefined, 'transport headers belong to the server layer, not routes');
  });

  it('rejects any query param (strict boundary)', () => {
    assertError(route('/health', [['x', '1']]), 400, 'PARAM_INVALID');
  });
});

describe('GET /bootstrap', () => {
  it('projects bootstrap through the real query layer with the injected active session', () => {
    const expected = queryService.projectBootstrap({ activeSessionID: 'workC' });
    const response = route('/bootstrap');
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), expected);
    assert.equal(expected.activeRootSessionID, 'rootA', 'fixture premise: workC walks up to rootA');
  });

  it('degrades to null active session when the injected getter returns null', () => {
    const expected = queryService.projectBootstrap({ activeSessionID: null });
    const response = route('/bootstrap', [], 'GET', nullActiveDeps);
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), expected);
    assert.equal(expected.activeRootSessionID, null);
  });

  it('rejects any query param', () => {
    assertError(route('/bootstrap', [['q', 'v']]), 400, 'PARAM_INVALID');
  });
});

describe('GET /sessions/roots', () => {
  it('defaults includeSystem to false and returns exactly { roots }', () => {
    const response = route('/sessions/roots');
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), { roots: queryService.listRoots({ includeSystem: false }) });
  });

  it('forwards includeSystem=true to the real layer', () => {
    const response = route('/sessions/roots', [['includeSystem', 'true']]);
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), { roots: queryService.listRoots({ includeSystem: true }) });
  });

  it('reveals the hidden system root only when includeSystem=true (real passthrough)', () => {
    assert.deepStrictEqual(
      jsonBody(route('/sessions/roots', [], 'GET', sysDeps)),
      { roots: [{ sessionID: 'w1', sanitizedTitle: 't', agent: null, kind: 'work', observedAtMs: 2 }] }
    );
    assert.deepStrictEqual(
      jsonBody(route('/sessions/roots', [['includeSystem', 'true']], 'GET', sysDeps)),
      { roots: [{ sessionID: 'sysR', sanitizedTitle: 't', agent: null, kind: 'system', observedAtMs: 1 }] }
    );
  });

  it('requires EXACT lowercase booleans: TRUE, 1, yes, empty are all rejected', () => {
    for (const bad of ['TRUE', '1', 'yes', '']) {
      assertError(route('/sessions/roots', [['includeSystem', bad]]), 400, 'PARAM_INVALID', `includeSystem='${bad}'`);
    }
  });

  it('rejects duplicate includeSystem values instead of taking the first', () => {
    assertError(
      route('/sessions/roots', [['includeSystem', 'false'], ['includeSystem', 'true']]),
      400,
      'PARAM_AMBIGUOUS'
    );
  });
});

describe('GET /sessions/:id/tree', () => {
  it('returns exactly { tree } from the real layer for a visible root', () => {
    const tree = queryService.getTree('rootA');
    assert.ok(tree.ok);
    const response = route('/sessions/rootA/tree');
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), { tree: tree.root });
  });

  it('forwards includeSystem=true to the real tree layer', () => {
    const tree = queryService.getTree('rootA', { includeSystem: true });
    assert.ok(tree.ok);
    assert.deepStrictEqual(jsonBody(route('/sessions/rootA/tree', [['includeSystem', 'true']])), { tree: tree.root });
  });

  it('decodes %2F-encoded session IDs before they reach the real layer', () => {
    const tree = encodedDeps.queryService.getTree('ses_abc/def');
    assert.ok(tree.ok, 'fixture premise: ses_abc/def is a real root');
    const response = route('/sessions/ses_abc%2Fdef/tree', [], 'GET', encodedDeps);
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), { tree: tree.root });
  });

  it('decodes %20-encoded session IDs before they reach the real layer', () => {
    const tree = encodedDeps.queryService.getTree('ses_a b');
    assert.ok(tree.ok, 'fixture premise: ses_a b is a real root');
    assert.deepStrictEqual(jsonBody(route('/sessions/ses_a%20b/tree', [], 'GET', encodedDeps)), { tree: tree.root });
  });

  it('maps malformed percent-encoding (%ZZ) to a sanitized 400', () => {
    assertError(route('/sessions/ses_%ZZ/tree'), 400, 'PATH_INVALID');
  });

  it('maps truncated percent-encoding (%2) to a sanitized 400', () => {
    assertError(route('/sessions/ses_%2/tree'), 400, 'PATH_INVALID');
  });

  it('maps ROOT_UNKNOWN from the real layer to 404 for unknown roots', () => {
    assertError(route('/sessions/nope/tree'), 404, 'ROOT_UNKNOWN');
  });

  it('maps ROOT_UNKNOWN to 404 for a visible non-root child (trees are root-only)', () => {
    assertError(route('/sessions/workC/tree'), 404, 'ROOT_UNKNOWN');
  });

  it('maps ROOT_UNKNOWN to 404 when the root is a hidden system node', () => {
    assertError(route('/sessions/sysR/tree', [], 'GET', sysDeps), 404, 'ROOT_UNKNOWN');
  });
});

describe('GET /events — success translation', () => {
  it('returns the real page DTO as JSON: ascending events, hasMore, nextCursor', () => {
    const direct = queryService.listEvents(subtreeInput({ limit: 2 }));
    assert.ok(direct.ok);
    assertAscending(direct.page.events);

    const response = route('/events', withParam('limit', '2'));
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), direct.page);
  });

  it('emits resolvedRunID for session scope with a single run (key present in body)', () => {
    const direct = queryService.listEvents({
      rootSessionID: 'rootA', selectedSessionID: 'workC', scope: 'session', includeSystem: false
    });
    assert.ok(direct.ok);
    assert.equal(direct.page.resolvedRunID, 'r1', 'fixture premise: workC events share run r1');

    const response = route('/events', [
      ['rootSessionID', 'rootA'], ['selectedSessionID', 'workC'], ['scope', 'session'], ['includeSystem', 'false']
    ]);
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), {
      events: [ev('workC', 'r1', 2, 1001), ev('workC', 'r1', 3, 1002)],
      hasMore: false,
      nextCursor: null,
      resolvedRunID: 'r1'
    });
  });

  it('omits the resolvedRunID key entirely for subtree scope', () => {
    const response = route('/events', eventsBase);
    assert.equal(response.status, 200);
    assert.deepStrictEqual(jsonBody(response), {
      events: [ev('rootA', 'r1', 1, 1000), ev('workC', 'r1', 2, 1001), ev('workC', 'r1', 3, 1002), ev('workD', 'r1', 4, 1003)],
      hasMore: false,
      nextCursor: null
    });
  });

  it('walks older pages exactly-once through real cursors until exhaustion', () => {
    const collected: SessionHistoryEvent[] = [];
    let cursor: string | null = null;
    let guard = 0;
    for (;;) {
      assert.ok(++guard < 25, 'walk must terminate');
      const query: QueryPairs = cursor === null
        ? withParam('limit', '2')
        : [...withParam('limit', '2'), ['direction', 'older'], ['cursor', cursor]];
      const response = route('/events', query);
      assert.equal(response.status, 200, `walk step ${guard}`);

      const direct = queryService.listEvents(
        subtreeInput({ limit: 2, ...(cursor === null ? {} : { direction: 'older', cursor }) })
      );
      assert.ok(direct.ok);
      assertAscending(direct.page.events);
      assert.deepStrictEqual(jsonBody(response), direct.page, 'route body must equal the real page at every step');

      collected.push(...direct.page.events);
      if (!direct.page.hasMore) {
        assert.equal(direct.page.nextCursor, null);
        break;
      }
      assert.ok(direct.page.nextCursor !== null);
      cursor = direct.page.nextCursor;
    }
    const walkedIDs = collected.map((e) => e.eventID);
    assert.equal(new Set(walkedIDs).size, walkedIDs.length, 'no eventID may repeat within the walk');
    const canonical = [...collected].sort((a, b) => compareBoundaries(toB(a), toB(b)));
    assert.deepStrictEqual(canonical.map((e) => e.eventID), ['rootA:r1:1', 'workC:r1:2', 'workC:r1:3', 'workD:r1:4']);
  });
});

describe('GET /events — required params and strict values', () => {
  it('rejects each missing required param with PARAM_MISSING', () => {
    for (const name of ['rootSessionID', 'selectedSessionID', 'scope', 'includeSystem']) {
      assertError(route('/events', withoutParam(name)), 400, 'PARAM_MISSING', `missing ${name}`);
    }
  });

  it('treats an empty required value as invalid, not missing', () => {
    const query = eventsBase.map(([k, v]) => [k, k === 'scope' ? '' : v] as const);
    assertError(route('/events', query), 400, "PARAM_INVALID", 'scope=\'\'');
  });

  it('rejects enum violations for scope and direction', () => {
    assertError(route('/events', replacingParam('scope', 'bogus')), 400, 'PARAM_INVALID');
    assertError(route('/events', withParam('direction', 'sideways')), 400, 'PARAM_INVALID');
  });

  it('rejects non-exact booleans for includeSystem on /events', () => {
    for (const bad of ['TRUE', 'True', '1', 'yes', '']) {
      const query = eventsBase.map(([k, v]) => [k, k === 'includeSystem' ? bad : v] as const);
      assertError(route('/events', query), 400, 'PARAM_INVALID', `includeSystem='${bad}'`);
    }
  });

  it('rejects duplicate ambiguous params instead of silently taking the first value', () => {
    assertError(route('/events', [...eventsBase, ['scope', 'session']]), 400, 'PARAM_AMBIGUOUS', 'duplicate scope');
    assertError(route('/events', [...eventsBase, ['limit', '1'], ['limit', '2']]), 400, 'PARAM_AMBIGUOUS', 'duplicate limit');
  });

  it('rejects unknown query keys (strict boundary)', () => {
    assertError(route('/events', [...eventsBase, ['foo', 'bar']]), 400, 'PARAM_INVALID');
  });
});

describe('GET /events — limit translation', () => {
  it('rejects non-integer limit strings with LIMIT_INVALID', () => {
    for (const bad of ['abc', '1.5', '2q0', ' ']) {
      assertError(route('/events', withParam('limit', bad)), 400, 'LIMIT_INVALID', `limit='${bad}'`);
    }
  });

  it('lets the real query layer range-check parsed integers (0, -3, 500 → LIMIT_INVALID)', () => {
    for (const bad of ['0', '-3', '500']) {
      assertError(route('/events', withParam('limit', bad)), 400, 'LIMIT_INVALID', `limit=${bad} out of 1..200`);
    }
  });
});

describe('GET /events — cursor translation', () => {
  it('passes cursors without direction to the real layer → DIRECTION_REQUIRED', () => {
    assertError(route('/events', withParam('cursor', 'Z2FyYmFnZQ')), 400, 'DIRECTION_REQUIRED');
  });

  it('passes garbage cursors to the real decoder → CURSOR_INVALID', () => {
    assertError(route('/events', [...withParam('cursor', 'Z2FyYmFnZQ'), ['direction', 'older']]), 400, 'CURSOR_INVALID');
  });

  it('rejects an empty cursor value at the boundary (non-empty contract)', () => {
    assertError(route('/events', [...withParam('cursor', ''), ['direction', 'older']]), 400, 'PARAM_INVALID');
  });

  it('proves cross-scope cursor rejection through the real query layer with a real cursor', () => {
    // Real cursor minted by the real service for (rootA, workC, session, older).
    const sessionPage = queryService.listEvents({
      rootSessionID: 'rootA', selectedSessionID: 'workC', scope: 'session', includeSystem: false, limit: 1
    });
    assert.ok(sessionPage.ok);
    const realCursor = sessionPage.page.nextCursor;
    assert.ok(realCursor !== null, 'limit-1 page over 2 events must mint a cursor');

    // Same root + selected, DIFFERENT scope: the real layer must reject the reuse.
    assertError(
      route('/events', [
        ['rootSessionID', 'rootA'],
        ['selectedSessionID', 'workC'],
        ['scope', 'subtree'],
        ['includeSystem', 'false'],
        ['direction', 'older'],
        ['cursor', realCursor]
      ]),
      400,
      'CURSOR_SCOPE_MISMATCH'
    );
  });
});

describe('GET /events — scope failure propagation (all 400 with exact codes)', () => {
  const cases: readonly (readonly [string, string, string, string])[] = [
    ['unknown root', 'nope', 'workC', 'ROOT_UNKNOWN'],
    ['selected under a different root', 'rootA', 'x1', 'SESSION_NOT_UNDER_ROOT'],
    ['selected hidden system session', 'rootA', 'sysB', 'SESSION_HIDDEN'],
    ['selected session with no lineage', 'rootA', 'zzz', 'SESSION_UNKNOWN']
  ];

  for (const [name, rootSessionID, selectedSessionID, code] of cases) {
    it(`maps ${name} → ${code}`, () => {
      assertError(
        route('/events', [
          ['rootSessionID', rootSessionID], ['selectedSessionID', selectedSessionID], ['scope', 'session'], ['includeSystem', 'false']
        ]),
        400,
        code
      );
    });
  }
});

describe('GET /events/stream — Task 9 handoff marker', () => {
  it('recognizes the path and returns the 501 marker with an exact body', () => {
    const response = route('/events/stream');
    assert.equal(response.status, 501);
    assert.equal(response.contentType, 'application/json');
    assert.equal(response.body, '{"error":"NOT_IMPLEMENTED"}');
    assert.deepStrictEqual(jsonBody(response), { error: 'NOT_IMPLEMENTED' });
  });

  it('keeps the marker regardless of query (SSE params belong to Task 9)', () => {
    assert.equal(route('/events/stream', [['scope', 'session']]).status, 501);
  });
});

describe('route table — method and path errors', () => {
  it('returns 405 with Allow: GET for known paths hit with the wrong method', () => {
    const wrongMethodCases: readonly (readonly [string, string])[] = [
      ['POST', '/events'],
      ['get', '/events'],
      ['DELETE', '/health'],
      ['PUT', '/sessions/roots'],
      ['POST', '/sessions/rootA/tree'],
      ['POST', '/events/stream'],
      ['HEAD', '/bootstrap']
    ];
    for (const [method, path] of wrongMethodCases) {
      const response = route(path, [], method);
      assert.equal(response.status, 405, `${method} ${path} → 405`);
      assert.deepStrictEqual(jsonBody(response), { error: 'METHOD_NOT_ALLOWED' }, `${method} ${path} body`);
      assert.deepStrictEqual(response.headers, { Allow: 'GET' }, `${method} ${path} Allow header`);
    }
  });

  it('returns 404 NOT_FOUND for unknown paths, shapes, and non-slash roots', () => {
    for (const path of ['/nope', '/sessions', '/sessions/rootA', '/sessions/rootA/tree/extra', '/events/other', '/', '', 'health', '/health/']) {
      assertError(route(path), 404, 'NOT_FOUND', path);
    }
  });

  it('never echoes query values, headers, or raw parse errors in any error body', () => {
    const response = route('/events', replacingParam('scope', '<script>x</script>&token=secret'));
    assert.equal(response.status, 400);
    assert.equal(response.body.includes('secret'), false);
    assert.equal(response.body.includes('<script>'), false);
    assert.deepStrictEqual(jsonBody(response), { error: 'PARAM_INVALID' });
  });
});
