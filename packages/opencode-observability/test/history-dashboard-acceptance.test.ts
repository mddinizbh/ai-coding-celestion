import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { z } from 'zod';
import {
  AcceptanceStorageFake,
  makeAcceptancePersistence,
  makeAcceptanceQueryService,
  makeAcceptanceServer,
  bootstrapSchema,
  lineageRootSummarySchema,
  lineageNodeSchema,
  pageSchema,
  fetchJSON,
  collectSSE,
  extractToken,
  stopServer,
  expectConnectionRefused,
  canRebind,
  toBoundary,
  compareBoundaries,
} from './fixtures/history-dashboard-fixtures';
import type { ServerDiagnosticCode } from '../src/server';
import { encodeHistoryCursor, HISTORY_CURSOR_VERSION } from '../src/history-cursor';
import { type SessionHistoryEvent, type SessionHistoryEventDraft } from '../src/history-domain';

describe('history dashboard end-to-end HTTP/SSE acceptance', () => {
  it('executes every scenario through real HTTP/SSE against composed server with exact behavior assertions', async () => {
    const storage = new AcceptanceStorageFake();
    const { persistence, seededEvents } = await makeAcceptancePersistence(storage);
    const queryService = makeAcceptanceQueryService(persistence);
    const diagnostics: Array<ServerDiagnosticCode | string> = [];
    const { server, token } = makeAcceptanceServer(queryService, persistence, diagnostics);
    const started = await server.start();
    const origin = started.origin;
    const bearerToken = extractToken(started.launchURL);
    assert.equal(bearerToken, token);

    try {
      // 1. Unauthorized before any route
      const unauth = await fetch(`${origin}/health`);
      assert.equal(unauth.status, 401);

      // 2. Set active + bootstrap exact
      server.setActiveSession('child1');
      const bootRes = await fetchJSON(origin, '/bootstrap', token, bootstrapSchema);
      assert.equal(bootRes.status, 200);
      assert.ok(bootRes.json);
      const boot = bootRes.json;
      assert.equal(boot.activeRootSessionID, 'root1');
      assert.ok(boot.cursor);

      // 3. Real HTTP /sessions/roots + /sessions/root1/tree (recursive + promotion + unknown)
      const rootsRes = await fetchJSON(origin, '/sessions/roots?includeSystem=false', token, z.object({ roots: z.array(lineageRootSummarySchema) }).strict());
      assert.equal(rootsRes.status, 200);
      assert.ok(rootsRes.json);
      const rootIDs = rootsRes.json.roots.map((r) => r.sessionID);
      assert.ok(rootIDs.includes('root1'));
      assert.ok(!rootIDs.includes('sys1'));

      const treeRes = await fetchJSON(origin, '/sessions/root1/tree?includeSystem=false', token, z.object({ tree: lineageNodeSchema }).strict());
      assert.equal(treeRes.status, 200);
      assert.ok(treeRes.json);
      const rootNode = treeRes.json.tree;
      const childNode = rootNode.children.find((c) => c.sessionID === 'child1');
      assert.ok(childNode, 'root has child1');
      const grandNode = childNode.children.find((c) => c.sessionID === 'grand1');
      assert.ok(grandNode, 'child has grandchild');
      const hasPromoted = rootNode.children.some((c) => c.sessionID === 'prom1');
      assert.ok(hasPromoted, 'hidden system promoted visible descendant present');
      const hasUnknown = rootNode.children.some((c) => c.sessionID === 'unk1');
      assert.ok(hasUnknown, 'unknown kind root present');

      // 4. Pagination: derive eligible subtree events (child1+grand1), sort canonical, assert per-page order + exact coverage
      const eligible = seededEvents
        .filter((e) => e.sessionID === 'child1' || e.sessionID === 'grand1')
        .sort(compareBoundaries);
      const eligibleIDs = eligible.map((e) => e.eventID);
      assert.ok(eligible.length > 0, 'loop executed at least once');

      const initialRes = await fetchJSON(origin, '/events?rootSessionID=root1&selectedSessionID=child1&scope=subtree&includeSystem=false&limit=2&direction=older', token, pageSchema);
      assert.equal(initialRes.status, 200);
      assert.ok(initialRes.json);
      const initial = initialRes.json;
      assert.ok(!('resolvedRunID' in initial), 'subtree page must omit resolvedRunID key entirely');
      assert.equal(initial.events.length, 2, 'initial page limited to 2');
      // initial page = newest 2 in ascending canonical
      const expectedNewestTwo = eligible.slice(-2);
      assert.deepEqual(initial.events.map((e) => e.eventID), expectedNewestTwo.map((e) => e.eventID), 'initial newest page equals last two in ascending canonical');

      let cursor: string | null = initial.nextCursor;
      const allOlderIDs: string[] = [...initial.events.map((e) => e.eventID)];
      let pageCount = 1;
      while (cursor) {
        const pageRes = await fetchJSON(
          origin,
          `/events?rootSessionID=root1&selectedSessionID=child1&scope=subtree&includeSystem=false&limit=2&direction=older&cursor=${encodeURIComponent(cursor)}`,
          token,
          pageSchema
        );
        assert.equal(pageRes.status, 200);
        assert.ok(pageRes.json);
        const pageEvents = pageRes.json.events;
        if (pageEvents.length === 2) {
          const first = pageEvents[0];
          const second = pageEvents[1];
          if (first && second) {
            assert.ok(compareBoundaries(toBoundary(first), toBoundary(second)) < 0, 'page events in ascending canonical');
          }
        }
        allOlderIDs.push(...pageEvents.map((e) => e.eventID));
        cursor = pageRes.json.nextCursor;
        pageCount++;
      }
      assert.ok(pageCount >= 1, 'loop executed at least once');
      assert.equal(allOlderIDs.length, eligibleIDs.length, 'exact total count');
      assert.deepEqual(new Set(allOlderIDs), new Set(eligibleIDs), 'exact ID set/coverage to eligible seeds');
      assert.equal(new Set(allOlderIDs).size, allOlderIDs.length, 'uniqueness');

      // 5. Append + newer continuation from bootstrap cursor (not older cursor)
      const liveDraft: SessionHistoryEventDraft = { runID: 'rLive', sessionID: 'grand1', timestampMs: 3000, type: 'retry', attempt: 1 };
      const appendRes = persistence.append({ draft: liveDraft });
      assert.equal(appendRes.type, 'appended');
      if (!boot.cursor) throw new Error('bootstrap cursor missing');
      const newerPageRes = await fetchJSON(
        origin,
        `/events?rootSessionID=root1&selectedSessionID=child1&scope=subtree&includeSystem=false&limit=10&direction=newer&cursor=${encodeURIComponent(boot.cursor)}`,
        token,
        pageSchema
      );
      assert.equal(newerPageRes.status, 200);
      assert.ok(newerPageRes.json);
      if (!newerPageRes.json) throw new Error('newer page json missing');
      assert.equal(newerPageRes.json.events.length, 1, 'newer from bootstrap cursor yields exactly the live append');
      const liveEvent = newerPageRes.json.events[0];
      if (!liveEvent) throw new Error('live event missing');
      assert.equal(liveEvent.runID, 'rLive');

      // SSE cursor: direction=newer, boundary below all fixture events (ts=2000) so replay includes 3 fixture + rLive
      const sseInitialCursor = encodeHistoryCursor({
        version: HISTORY_CURSOR_VERSION,
        rootSessionID: 'root1',
        selectedSessionID: 'child1',
        scope: 'subtree',
        includeSystem: false,
        direction: 'newer',
        boundary: { timestampMs: 1999, sessionID: 'root1', runID: 'r1', sequence: 0 },
      });

      // 6. Cross-scope cursor rejection via real /events route
      const badCursor = encodeHistoryCursor({
        version: HISTORY_CURSOR_VERSION,
        rootSessionID: 'otherRoot',
        selectedSessionID: 'child1',
        scope: 'session',
        includeSystem: false,
        direction: 'older',
        boundary: { timestampMs: 1999, sessionID: 'root1', runID: 'r1', sequence: 0 },
      });
      const rej = await fetchJSON(origin, `/events?rootSessionID=root1&selectedSessionID=child1&scope=subtree&includeSystem=false&limit=5&direction=older&cursor=${encodeURIComponent(badCursor)}`, token, pageSchema);
      assert.equal(rej.status, 400);
      assert.equal(rej.errorCode, 'CURSOR_SCOPE_MISMATCH');

      // 7. Real SSE with narrow subscribe wrapper for append-at-boundary race (real persistence path, no manual hub)
      const ssePath = `/events/stream?rootSessionID=root1&selectedSessionID=child1&scope=subtree&includeSystem=false`;
      const raceDraft: SessionHistoryEventDraft = { runID: 'rRace', sessionID: 'grand1', timestampMs: 4000, type: 'retry', attempt: 1 };
      let raceInjected = false;
      const raceSubscribeWrapper = (listener: (event: SessionHistoryEvent) => void) => {
        const unsub = persistence.subscribeToAppends(listener);
        if (!raceInjected) {
          raceInjected = true;
          const res = persistence.append({ draft: raceDraft });
          assert.equal(res.type, 'appended');
        }
        return unsub;
      };
      await stopServer(server);
      const { server: server2, token: token2 } = makeAcceptanceServer(queryService, persistence, diagnostics, raceSubscribeWrapper);
      const started2 = await server2.start();
      const origin2 = started2.origin;

      let sseEvents: Awaited<ReturnType<typeof collectSSE>> = [];
      try {
        // exact replay (3 fixture + rLive) + race exactly once via cursor
        sseEvents = await collectSSE(origin2, `${ssePath}&cursor=${encodeURIComponent(sseInitialCursor)}`, token2, 5, 5000);
        const expectedRunIDs = ['r2', 'r3', 'r1', 'rLive', 'rRace'];
        const actualRunIDs = sseEvents.map((e) => e.event?.runID).filter(Boolean);
        assert.deepEqual(actualRunIDs, expectedRunIDs, 'exact ordered runIDs including replay and single race');
        const raceEvents = sseEvents.filter((e) => e.event?.runID === 'rRace');
        assert.equal(raceEvents.length, 1, 'exactly one race event');
        assert.equal(actualRunIDs[actualRunIDs.length - 1], 'rRace', 'rRace is final newest boundary');
        const sseIDs = sseEvents.map((e) => e.event?.eventID).filter(Boolean);
        assert.equal(new Set(sseIDs).size, sseIDs.length, 'no duplicate SSE frames');

        // 8. Reconnect from last cursor (rRace) emits exactly the new event, no old IDs
        const lastCursor = sseEvents[sseEvents.length - 1]?.cursor;
        if (!lastCursor) throw new Error('last cursor missing for reconnect');
        const reconnectDraft: SessionHistoryEventDraft = { runID: 'rReconnect', sessionID: 'grand1', timestampMs: 5000, type: 'retry', attempt: 1 };
        const recAppend = persistence.append({ draft: reconnectDraft });
        assert.equal(recAppend.type, 'appended');
        const reconnectEvents = await collectSSE(origin2, `${ssePath}&cursor=${encodeURIComponent(lastCursor)}`, token2, 1, 3000);
        assert.equal(reconnectEvents.length, 1);
        const recEvent = reconnectEvents[0]?.event;
        if (!recEvent) throw new Error('reconnect event missing');
        assert.equal(recEvent.runID, 'rReconnect');
        assert.ok(!sseIDs.includes(recEvent.eventID));
      } finally {
        await stopServer(server2);
      }

      // 9. Server stop + persistence shutdown + port release (both servers)
      await expectConnectionRefused(origin2);
      assert.ok(await canRebind(started2.port));
      await stopServer(server).catch(() => {});
      await persistence.shutdown();

      assert.equal(diagnostics.length, 0, 'no diagnostics in successful flow');
    } finally {
      // cleanup in case of early exit
      await stopServer(server).catch(() => {});
      await persistence.shutdown().catch(() => {});
    }
  });
});
