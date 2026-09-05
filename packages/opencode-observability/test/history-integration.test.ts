import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import type { StorageScanOptions, StorageScanResult, StorageEntry } from '@opencode-ai/plugin/storage';
import type { Schema } from 'effect';
import { HistoryPersistence } from '../src/history-persistence';
import type { SessionHistoryEvent, SessionHistoryEventDraft, SessionLineage } from '../src/history-domain';
import { createHistoryQuery, type HistoryQueryService } from '../src/history-query';
import type { ListEventsInput, ListEventsResult } from '../src/history-query-contracts';
import { compareBoundaries, decodeHistoryCursor, type HistoryCursorBoundary } from '../src/history-cursor';

// ---------------------------------------------------------------------------
// In-memory StorageDomain fake — the ONLY faked boundary (pattern copied from
// test/history-persistence.test.ts TestStorageFake). Everything above it
// (HistoryPersistence, InMemoryHistoryEventStore, query layer, cursor codec)
// is real production code under integration proof.
// ---------------------------------------------------------------------------

class IntegrationStorageFake implements StorageDomain {
  private readonly store = new Map<string, Schema.Json>();

  keys(): string[] {
    return [...this.store.keys()];
  }

  async get(key: string): Promise<Schema.Json | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: Schema.Json): Promise<void> {
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
  }

  async scan(options: StorageScanOptions): Promise<StorageScanResult> {
    const { prefix, limit = 100 } = options;
    const matching: StorageEntry[] = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix) && matching.length < limit) {
        matching.push({ key: k, value: v });
      }
    }
    matching.sort((a, b) => a.key.localeCompare(b.key));
    return { entries: matching } satisfies StorageScanResult;
  }
}

// ---------------------------------------------------------------------------
// Makers + helpers
// ---------------------------------------------------------------------------

const lin = (
  sessionID: string,
  parentSessionID: string | null,
  over: Partial<Pick<SessionLineage, 'kind' | 'observedAtMs' | 'sanitizedTitle' | 'agent'>> = {}
): SessionLineage =>
  ({
    sessionID,
    parentSessionID,
    agent: over.agent ?? null,
    sanitizedTitle: over.sanitizedTitle ?? sessionID,
    kind: over.kind ?? 'work',
    observedAtMs: over.observedAtMs ?? 0
  }) satisfies SessionLineage;

const retryDraft = (runID: string, sessionID: string, timestampMs: number): SessionHistoryEventDraft =>
  ({ runID, sessionID, timestampMs, type: 'retry', attempt: 1 }) satisfies SessionHistoryEventDraft;

function appendAll(p: HistoryPersistence, drafts: readonly SessionHistoryEventDraft[]): SessionHistoryEvent[] {
  const events: SessionHistoryEvent[] = [];
  for (const draft of drafts) {
    const res = p.append({ draft });
    if (res.type !== 'appended') assert.fail(`expected appended, got ${res.type}`);
    events.push(res.event);
  }
  return events;
}

function recordAll(p: HistoryPersistence, lineages: readonly SessionLineage[]): void {
  for (const lineage of lineages) p.recordLineage(lineage);
}

const toB = (e: SessionHistoryEvent): HistoryCursorBoundary =>
  ({ timestampMs: e.timestampMs, sessionID: e.sessionID, runID: e.runID, sequence: e.sequence });

const sortedByBoundary = (es: readonly SessionHistoryEvent[]): SessionHistoryEvent[] =>
  [...es].sort((a, b) => compareBoundaries(toB(a), toB(b)));

const eventIDs = (es: readonly SessionHistoryEvent[]): string[] => es.map((e) => e.eventID);

function assertPage(r: ListEventsResult): asserts r is Extract<ListEventsResult, { ok: true }> {
  assert.ok(r.ok, `expected listEvents success, got failure ${r.ok ? '' : r.code}`);
}

/** Walks pages in one direction; asserts hasMore never over-promises (page after hasMore=true is non-empty). */
function collectWalk(
  service: HistoryQueryService,
  base: Omit<ListEventsInput, 'cursor' | 'direction'>,
  direction: 'older' | 'newer',
  startCursor: string | null,
  limit: number
): SessionHistoryEvent[] {
  const collected: SessionHistoryEvent[] = [];
  let cursor: string | null = startCursor;
  let previousHadMore = false;
  let guard = 0;
  while (cursor !== null) {
    assert.ok(++guard < 1000, 'walk must terminate');
    const r = service.listEvents({ ...base, direction, cursor, limit });
    assertPage(r);
    if (previousHadMore) {
      assert.ok(r.page.events.length > 0, 'hasMore=true must never over-promise: the following page must be non-empty');
    }
    previousHadMore = r.page.hasMore;
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

// ---------------------------------------------------------------------------
// Integration proofs — the complete M6 stack: real HistoryPersistence over the
// in-memory StorageDomain fake, wired into the query layer via
// createHistoryQuery (persistence structurally satisfies HistoryEventReadSource
// = { listLineages(), getAllEvents() }). No unit under test is mocked.
// ---------------------------------------------------------------------------

describe('M6 integration — real persistence + query layer over in-memory storage', () => {
  describe('1. hydration across restart', () => {
    it('append + recordLineage → shutdown(drain) → second persistence hydrates identical events, lineages, resolveScope and listEvents (incl. nextCursor token equality)', async () => {
      const fake = new IntegrationStorageFake();
      const p1 = await HistoryPersistence.create(fake);
      recordAll(p1, [
        lin('rootA', null, { observedAtMs: 10, sanitizedTitle: 'a-root', agent: 'build' }),
        lin('workC', 'rootA', { observedAtMs: 30, sanitizedTitle: 'c-work', agent: 'coder' }),
        lin('rootX', null, { observedAtMs: 5, sanitizedTitle: 'x-root' })
      ]);
      appendAll(p1, [
        retryDraft('ra', 'rootA', 100),
        retryDraft('rc', 'workC', 200),
        retryDraft('rc', 'workC', 201),
        retryDraft('rx', 'rootX', 50)
      ]);
      const eventsBefore = p1.getAllEvents();
      const q1 = createHistoryQuery(p1);
      const scopeBefore = q1.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: false });
      const pageInput: ListEventsInput = { rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: false, limit: 2 };
      const pageBefore = q1.listEvents(pageInput);
      await p1.shutdown();

      const p2 = await HistoryPersistence.create(fake);
      assert.deepStrictEqual(p2.getAllEvents(), eventsBefore, 'all events must survive the restart in canonical order');
      assert.deepStrictEqual(p2.listLineages(), p1.listLineages(), 'all lineages must survive the restart');
      const q2 = createHistoryQuery(p2);
      assert.deepStrictEqual(
        q2.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: false }),
        scopeBefore,
        'resolveScope must behave identically after hydration'
      );
      assert.deepStrictEqual(q2.listEvents(pageInput), pageBefore, 'listEvents result — including the encoded nextCursor token — must be identical after hydration');
      await p2.shutdown();
    });

    it('empty-events restart hydrates zero events; lineage-only storage answers listEvents with an empty page, not a failure', async () => {
      const fake = new IntegrationStorageFake();
      const p1 = await HistoryPersistence.create(fake);
      recordAll(p1, [lin('rootA', null, { observedAtMs: 10 })]);
      await p1.shutdown();
      const p2 = await HistoryPersistence.create(fake);
      const q2 = createHistoryQuery(p2);
      assert.deepStrictEqual(p2.getAllEvents(), []);
      const r = q2.listEvents({ rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: false });
      assertPage(r);
      assert.deepStrictEqual(r.page, { events: [], hasMore: false, nextCursor: null });
      await p2.shutdown();
    });
  });

  describe('2. lineage filtering through real persistence', () => {
    it('recordLineage drives resolveScope membership (subtree preorder, hidden-system promotion) and listEvents scope filtering for session and subtree', async () => {
      const fake = new IntegrationStorageFake();
      const p = await HistoryPersistence.create(fake);
      recordAll(p, [
        lin('rootA', null, { observedAtMs: 10 }),
        lin('sysB', 'rootA', { kind: 'system', observedAtMs: 20 }),
        lin('workC', 'sysB', { observedAtMs: 30 }),
        lin('workD', 'rootA', { observedAtMs: 40 }),
        lin('rootX', null, { observedAtMs: 5 })
      ]);
      appendAll(p, [
        retryDraft('ra', 'rootA', 100),
        retryDraft('rb', 'sysB', 110),
        retryDraft('rc', 'workC', 120),
        retryDraft('rc', 'workC', 121),
        retryDraft('rd', 'workD', 130),
        retryDraft('rx', 'rootX', 50)
      ]);
      const q = createHistoryQuery(p);
      const subtreeBase = { rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree' as const, includeSystem: false };

      // Hidden sysB omitted but workC promoted; visible siblings by observedAtMs (workC 30 < workD 40).
      assert.deepStrictEqual(q.resolveScope({ ...subtreeBase }), { ok: true, sessionIDs: ['rootA', 'workC', 'workD'] });
      assert.deepStrictEqual(
        q.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: true }),
        { ok: true, sessionIDs: ['rootA', 'sysB', 'workC', 'workD'] }
      );
      assert.deepStrictEqual(
        q.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'workC', scope: 'session', includeSystem: false }),
        { ok: true, sessionIDs: ['workC'] }
      );
      assert.deepStrictEqual(
        q.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'sysB', scope: 'session', includeSystem: false }),
        { ok: false, code: 'SESSION_HIDDEN' }
      );

      // subtree includeSystem=false: rootX and sysB events filtered out; retained set ascending.
      const r = q.listEvents({ ...subtreeBase });
      assertPage(r);
      assert.deepStrictEqual(eventIDs(r.page.events), ['ra:retry:1', 'rc:retry:1', 'rc:retry:2', 'rd:retry:1']);
      assert.equal(r.page.hasMore, false);
      assert.equal(r.page.nextCursor, null);

      // includeSystem=true pulls the sysB event in at its canonical position between rootA and workC.
      const rSys = q.listEvents({ ...subtreeBase, includeSystem: true });
      assertPage(rSys);
      assert.deepStrictEqual(eventIDs(rSys.page.events), ['ra:retry:1', 'rb:retry:1', 'rc:retry:1', 'rc:retry:2', 'rd:retry:1']);

      // session scope: only workC events; single shared run resolved over the FULL matching set.
      const rSession = q.listEvents({ rootSessionID: 'rootA', selectedSessionID: 'workC', scope: 'session', includeSystem: false });
      assertPage(rSession);
      assert.deepStrictEqual(eventIDs(rSession.page.events), ['rc:retry:1', 'rc:retry:2']);
      assert.equal(rSession.page.hasMore, false);
      assert.equal(rSession.page.nextCursor, null);
      assert.equal(rSession.page.resolvedRunID, 'rc');
      await p.shutdown();
    });
  });

  describe('3. retained-event pagination under maxEventsPerRun', () => {
    it('evicted events appear in neither getAllEvents nor ANY listEvents page; walk is exactly-once over the retained set; drained storage keeps only retained keys; hydration honors retention', async () => {
      const fake = new IntegrationStorageFake();
      const p = await HistoryPersistence.create(fake, { maxEventsPerRun: 3 });
      recordAll(p, [lin('rootR', null, { observedAtMs: 1 }), lin('c1', 'rootR', { observedAtMs: 2 })]);
      appendAll(p, [1000, 1001, 1002, 1003, 1004, 1005, 1006, 1007].map((ts) => retryDraft('big', 'c1', ts)));
      appendAll(p, [retryDraft('small', 'rootR', 998), retryDraft('small', 'rootR', 999)]);

      const retained = ['small:retry:1', 'small:retry:2', 'big:retry:6', 'big:retry:7', 'big:retry:8'];
      const evictedIDs = ['big:retry:1', 'big:retry:2', 'big:retry:3', 'big:retry:4', 'big:retry:5'];
      assert.deepStrictEqual(eventIDs(p.getAllEvents()), retained, 'getAllEvents must expose only the retained window');

      const q = createHistoryQuery(p);
      const base = { rootSessionID: 'rootR', selectedSessionID: 'rootR', scope: 'subtree' as const, includeSystem: false };
      const initial = q.listEvents({ ...base, limit: 2 });
      assertPage(initial);
      assert.deepStrictEqual(eventIDs(initial.page.events), ['big:retry:7', 'big:retry:8']);
      assert.equal(initial.page.hasMore, true);
      assert.ok(initial.page.nextCursor !== null);
      const walkedPre = [initial.page.events, collectWalk(q, base, 'older', initial.page.nextCursor, 2)].flat();
      assert.ok(!walkedPre.some((e) => evictedIDs.includes(e.eventID)), 'no page may contain an evicted event');
      assertWalkExactlyOnce(walkedPre, p.getAllEvents(), 'retained walk pre-restart');
      await p.shutdown();

      const bigKeys = fake.keys().filter((k) => k.startsWith('history/event/big/')).sort();
      assert.deepStrictEqual(
        bigKeys,
        ['history/event/big/0000000006', 'history/event/big/0000000007', 'history/event/big/0000000008'],
        'drained storage must contain only the retained run window'
      );

      const p2 = await HistoryPersistence.create(fake, { maxEventsPerRun: 3 });
      const q2 = createHistoryQuery(p2);
      assert.deepStrictEqual(eventIDs(p2.getAllEvents()), retained, 'hydration honors the retention window');
      const initial2 = q2.listEvents({ ...base, limit: 2 });
      assertPage(initial2);
      assert.ok(initial2.page.nextCursor !== null);
      const walkedPost = [initial2.page.events, collectWalk(q2, base, 'older', initial2.page.nextCursor, 2)].flat();
      assert.ok(!walkedPost.some((e) => evictedIDs.includes(e.eventID)), 'no post-restart page may contain an evicted event');
      assertWalkExactlyOnce(walkedPost, p2.getAllEvents(), 'retained walk post-restart');
      await p2.shutdown();
    });
  });

  describe('4. live append read-back', () => {
    it('subscribeToAppends delivers the appended event and the SAME event is immediately the newest entry of the next listEvents page (session and subtree scope) — no staleness', async () => {
      const fake = new IntegrationStorageFake();
      const p = await HistoryPersistence.create(fake);
      recordAll(p, [lin('rootA', null, { observedAtMs: 10 }), lin('c1', 'rootA', { observedAtMs: 20 })]);
      appendAll(p, [retryDraft('rc', 'c1', 100)]);
      const q = createHistoryQuery(p);
      const sessionBase = { rootSessionID: 'rootA', selectedSessionID: 'c1', scope: 'session' as const, includeSystem: false };

      const before = q.listEvents({ ...sessionBase });
      assertPage(before);
      assert.ok(!eventIDs(before.page.events).includes('rc:retry:2'), 'target event must not exist yet');

      const received: SessionHistoryEvent[] = [];
      p.subscribeToAppends((e) => received.push(e));
      const res = p.append({ draft: retryDraft('rc', 'c1', 200) });
      if (res.type !== 'appended') assert.fail(`expected appended, got ${res.type}`);
      assert.equal(res.event.eventID, 'rc:retry:2');
      assert.equal(received.length, 1);
      assert.deepStrictEqual(received[0], res.event, 'listener must receive exactly the appended event');

      const after = q.listEvents({ ...sessionBase });
      assertPage(after);
      assert.equal(after.page.events.length, 2);
      const last = after.page.events[after.page.events.length - 1];
      assert.ok(last !== undefined);
      assert.deepStrictEqual(last, received[0], 'the SAME event must immediately appear as the newest page entry');

      const subtree = q.listEvents({ rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree', includeSystem: false });
      assertPage(subtree);
      assert.ok(eventIDs(subtree.page.events).includes('rc:retry:2'), 'live event must also appear via the subtree scope page');
      await p.shutdown();
    });
  });

  describe('5. lineage deletion', () => {
    it('deleteLineage removes membership: resolveScope/listEvents → SESSION_UNKNOWN, subtree pages exclude the events — but the events remain in getAllEvents AND storage across restart (no cascade delete)', async () => {
      const fake = new IntegrationStorageFake();
      const p = await HistoryPersistence.create(fake);
      recordAll(p, [lin('rootA', null, { observedAtMs: 10 }), lin('c1', 'rootA', { observedAtMs: 20 })]);
      appendAll(p, [retryDraft('ra', 'rootA', 100), retryDraft('rc', 'c1', 150)]);
      const q = createHistoryQuery(p);
      const base = { rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'subtree' as const, includeSystem: false };
      const pre = q.listEvents({ ...base });
      assertPage(pre);
      assert.ok(eventIDs(pre.page.events).includes('rc:retry:1'), 'c1 event is in scope before deletion');

      p.deleteLineage('c1');
      assert.deepStrictEqual(
        q.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'c1', scope: 'session', includeSystem: false }),
        { ok: false, code: 'SESSION_UNKNOWN' },
        'deleted lineage → no lineage record at all for that session'
      );
      assert.deepStrictEqual(
        q.listEvents({ rootSessionID: 'rootA', selectedSessionID: 'c1', scope: 'session', includeSystem: false }),
        { ok: false, code: 'SESSION_UNKNOWN' }
      );
      const post = q.listEvents({ ...base });
      assertPage(post);
      assert.deepStrictEqual(eventIDs(post.page.events), ['ra:retry:1'], 'subtree membership shrank to rootA; c1 events excluded from every page');
      assert.ok(eventIDs(p.getAllEvents()).includes('rc:retry:1'), 'deleteLineage must NOT delete events — they remain in the store');
      await p.shutdown();

      const p2 = await HistoryPersistence.create(fake);
      const q2 = createHistoryQuery(p2);
      assert.deepStrictEqual(
        q2.resolveScope({ rootSessionID: 'rootA', selectedSessionID: 'c1', scope: 'session', includeSystem: false }),
        { ok: false, code: 'SESSION_UNKNOWN' },
        'lineage deletion persists across restart'
      );
      assert.ok(eventIDs(p2.getAllEvents()).includes('rc:retry:1'), 'orphaned events persist across restart (no cascade delete)');
      const post2 = q2.listEvents({ ...base });
      assertPage(post2);
      assert.deepStrictEqual(eventIDs(post2.page.events), ['ra:retry:1']);
      await p2.shutdown();
    });
  });

  describe('6. restart-stable cursors', () => {
    // In-scope fixture (rootR subtree, includeSystem=false): 7 events with ties across sessions AND runs.
    // Canonical ascending: cr1:1(1000,c1) cr2:1(1000,c1) rr1:1(1000,rootR) cr3:1(1001,c2) cr3:2(1001,c2) dr:1(1002,deep) rr1:2(1003,rootR)
    // Outsider o1 events (ts 999 / 1005) must be filtered out of every page.
    async function seededTieFixture(): Promise<IntegrationStorageFake> {
      const fake = new IntegrationStorageFake();
      const p = await HistoryPersistence.create(fake);
      recordAll(p, [
        lin('rootR', null, { observedAtMs: 1 }),
        lin('c1', 'rootR', { observedAtMs: 2 }),
        lin('deep', 'c1', { observedAtMs: 3 }),
        lin('c2', 'rootR', { observedAtMs: 4 }),
        lin('rootO', null, { observedAtMs: 6 }),
        lin('o1', 'rootO', { observedAtMs: 7 })
      ]);
      appendAll(p, [
        retryDraft('rr1', 'rootR', 1000),
        retryDraft('rr1', 'rootR', 1003),
        retryDraft('cr1', 'c1', 1000),
        retryDraft('cr2', 'c1', 1000),
        retryDraft('cr3', 'c2', 1001),
        retryDraft('cr3', 'c2', 1001),
        retryDraft('dr', 'deep', 1002),
        retryDraft('or9', 'o1', 999),
        retryDraft('or9', 'o1', 1005)
      ]);
      await p.shutdown();
      return fake;
    }

    const tieBase = { rootSessionID: 'rootR', selectedSessionID: 'rootR', scope: 'subtree' as const, includeSystem: false };

    it('cursor from a pre-restart initial page pages losslessly post-restart: older continuation across the seam is exactly-once', async () => {
      const fake = await seededTieFixture();
      const p1 = await HistoryPersistence.create(fake);
      const q1 = createHistoryQuery(p1);
      const initial = q1.listEvents({ ...tieBase, limit: 3 });
      assertPage(initial);
      assert.deepStrictEqual(eventIDs(initial.page.events), ['cr3:retry:2', 'dr:retry:1', 'rr1:retry:2'], 'initial page = newest 3 ascending');
      assert.equal(initial.page.hasMore, true);
      const seamCursor = initial.page.nextCursor;
      assert.ok(seamCursor !== null);
      await p1.shutdown();

      const p2 = await HistoryPersistence.create(fake);
      const q2 = createHistoryQuery(p2);
      const firstPostRestart = q2.listEvents({ ...tieBase, direction: 'older', cursor: seamCursor, limit: 3 });
      assertPage(firstPostRestart);
      assert.deepStrictEqual(eventIDs(firstPostRestart.page.events), ['cr2:retry:1', 'rr1:retry:1', 'cr3:retry:1'], 'decoded pre-restart cursor drives the post-restart page exactly');
      assert.equal(firstPostRestart.page.hasMore, true);
      assert.ok(firstPostRestart.page.nextCursor !== null);

      const walked = [initial.page.events, firstPostRestart.page.events, collectWalk(q2, tieBase, 'older', firstPostRestart.page.nextCursor, 3)].flat();
      const inScope = p2.getAllEvents().filter((e) => e.sessionID !== 'o1');
      assertWalkExactlyOnce(walked, inScope, 'restart-seam older walk');
      assert.ok(!eventIDs(walked).some((id) => id.startsWith('or9:')), 'outsider events never leak into pages');
      await p2.shutdown();
    });

    it('projectBootstrap cursor (direction newer, scope = active session subtree) survives restart: newer page returns exactly the post-restart in-scope events, never pre-boundary ones', async () => {
      const fake = new IntegrationStorageFake();
      const p1 = await HistoryPersistence.create(fake);
      recordAll(p1, [lin('rootA', null, { observedAtMs: 10 }), lin('c1', 'rootA', { observedAtMs: 20 })]);
      appendAll(p1, [retryDraft('ra', 'rootA', 100), retryDraft('rc', 'c1', 200)]);
      const q1 = createHistoryQuery(p1);
      const boot = q1.projectBootstrap({ activeSessionID: 'c1' });
      assert.ok(boot.cursor !== null);
      assert.equal(boot.activeRootSessionID, 'rootA');
      const decoded = decodeHistoryCursor(boot.cursor);
      assert.ok(decoded.ok);
      assert.deepStrictEqual(decoded.value.boundary, { timestampMs: 200, sessionID: 'c1', runID: 'rc', sequence: 1 });
      assert.equal(decoded.value.direction, 'newer');
      assert.equal(decoded.value.rootSessionID, 'rootA');
      assert.equal(decoded.value.selectedSessionID, 'c1');
      await p1.shutdown();

      const p2 = await HistoryPersistence.create(fake);
      const q2 = createHistoryQuery(p2);
      // Post-restart appends into the SAME runs: per-run sequences continue (hydration restored nextSeq).
      appendAll(p2, [retryDraft('ra', 'rootA', 250), retryDraft('rc', 'c1', 300), retryDraft('rc', 'c1', 301)]);
      // Bootstrap stream scope = subtree of the ACTIVE session (c1 is a leaf → membership {c1}):
      // the newer walk returns exactly the post-restart c1 events; rootA@250 is out of stream scope.
      const r = q2.listEvents({
        rootSessionID: 'rootA', selectedSessionID: 'c1', scope: 'subtree', includeSystem: false,
        direction: 'newer', cursor: boot.cursor, limit: 10
      });
      assertPage(r);
      assert.deepStrictEqual(eventIDs(r.page.events), ['rc:retry:2', 'rc:retry:3'], 'newer walk from the pre-restart boundary returns exactly the post-restart in-scope events');
      assert.equal(r.page.hasMore, false);
      assert.equal(r.page.nextCursor, null);
      assert.ok(!eventIDs(r.page.events).includes('rc:retry:1'), 'no pre-boundary event may reappear');
      // The rootA post-restart event exists and stays queryable via its own session scope (outside the bootstrap stream).
      const rootAPage = q2.listEvents({ rootSessionID: 'rootA', selectedSessionID: 'rootA', scope: 'session', includeSystem: false });
      assertPage(rootAPage);
      assert.deepStrictEqual(eventIDs(rootAPage.page.events), ['ra:retry:1', 'ra:retry:2']);
      await p2.shutdown();
    });
  });
});
