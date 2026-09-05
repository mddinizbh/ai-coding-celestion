import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createDashboardState,
  dashboardReducer,
  POLL_INTERVAL_MS,
  selectConnection,
  selectHasOlder,
  selectStatus,
  selectTimeline
} from '../src/dashboard/state.js';
import type { DashboardAction, HistoryEvent } from '../src/dashboard/state.js';

function ev(sessionID: string, runID: string, sequence: number, timestampMs: number, suffix = ''): HistoryEvent {
  return { eventID: `${timestampMs}:${sessionID}:${runID}:${sequence}${suffix}`, runID, sessionID, sequence, timestampMs, type: 'run.started' };
}

function eventIDs(events: readonly HistoryEvent[]): string[] {
  return events.map((event) => event.eventID);
}

describe('dashboard state bootstrap and selection', () => {
  it('stores roots tree and subtree membership from bootstrap when ready', () => {
    const roots = [{ sessionID: 'root', sanitizedTitle: 'Root', agent: null, kind: 'work', observedAtMs: 1 }];
    const tree = { sessionID: 'root', children: [{ sessionID: 'child', children: [] }] };
    const state = dashboardReducer(createDashboardState(), {
      type: 'bootstrapReady',
      roots,
      tree,
      subtreeSessionIDs: ['root', 'child'],
      page: { events: [ev('child', 'r', 1, 2)], hasMore: true, nextCursor: 'older-1' }
    });

    assert.equal(selectStatus(state), 'ready');
    assert.deepStrictEqual(state.roots, roots);
    assert.deepStrictEqual(state.tree, tree);
    assert.deepStrictEqual(state.subtreeSessionIDs, ['root', 'child']);
    assert.deepStrictEqual(eventIDs(selectTimeline(state)), ['2:child:r:1']);
    assert.equal(selectHasOlder(state), true);
  });

  it('filters all session and subtree timelines and clears cursors when selection changes', () => {
    const ready = dashboardReducer(createDashboardState(), {
      type: 'bootstrapReady',
      roots: [],
      tree: null,
      subtreeSessionIDs: ['s2', 's3'],
      page: { events: [ev('s1', 'a', 1, 1), ev('s2', 'a', 1, 2), ev('s3', 'a', 1, 3)], hasMore: true, nextCursor: 'old' }
    });

    const session = dashboardReducer(ready, { type: 'selectionChanged', mode: 'session', sessionID: 's2' });
    const subtree = dashboardReducer(session, { type: 'selectionChanged', mode: 'subtree', sessionID: 's2' });

    assert.deepStrictEqual(eventIDs(selectTimeline(ready)), ['1:s1:a:1', '2:s2:a:1', '3:s3:a:1']);
    assert.deepStrictEqual(eventIDs(selectTimeline(session)), ['2:s2:a:1']);
    assert.deepStrictEqual(eventIDs(selectTimeline(subtree)), ['2:s2:a:1', '3:s3:a:1']);
    assert.equal(session.status, 'loading');
    assert.equal(session.olderCursor, null);
    assert.equal(session.newerCursor, null);
  });

  it('clears cursors and resets the SSE attempt when includeSystem changes', () => {
    const failedTwice = dashboardReducer(dashboardReducer(createDashboardState(), { type: 'streamFailure' }), { type: 'streamFailure' });
    const withCursor = dashboardReducer(failedTwice, {
      type: 'pageAppended',
      page: { events: [ev('s', 'r', 1, 1)], hasMore: true, nextCursor: 'older' },
      cursor: 'newer'
    });

    const changed = dashboardReducer(withCursor, { type: 'includeSystemChanged', includeSystem: true });

    assert.equal(changed.includeSystem, true);
    assert.equal(changed.olderCursor, null);
    assert.equal(changed.newerCursor, null);
    assert.deepStrictEqual(selectConnection(changed), { mode: 'sse', consecutiveFailures: 0, pollIntervalMs: POLL_INTERVAL_MS });
    assert.equal(selectStatus(changed), 'loading');
  });
});

describe('dashboard event store semantics', () => {
  it('dedupes by eventID and orders by timestamp session run and sequence', () => {
    const first = ev('a', 'r9', 9, 1);
    const second = ev('b', 'r1', 1, 1);
    const third = ev('b', 'r2', 2, 1);
    const fourth = ev('b', 'r2', 3, 1);
    const fifth = ev('c', 'r1', 1, 2);
    const duplicate = third;
    const ordered = [first, second, third, fourth, fifth];
    const state = dashboardReducer(createDashboardState(), {
      type: 'pageAppended',
      page: { events: [fifth, duplicate, fourth, third, second, first], hasMore: false, nextCursor: null }
    });

    assert.deepStrictEqual(eventIDs(selectTimeline(state)), ordered.map((event) => event.eventID));
  });

  it('keeps one entry when SSE replays an already paged event after reconnect', () => {
    const event = ev('s', 'r', 1, 1);
    const paged = dashboardReducer(createDashboardState(), { type: 'pageAppended', page: { events: [event], hasMore: false, nextCursor: null } });
    const replayed = dashboardReducer(paged, { type: 'streamEvent', event });

    assert.deepStrictEqual(eventIDs(selectTimeline(replayed)), [event.eventID]);
    assert.deepStrictEqual(selectTimeline(replayed), selectTimeline(paged));
  });

  it('caps canonical events at 1000 and evicts the oldest canonical keys across pages and stream events', () => {
    const pageEvents = Array.from({ length: 900 }, (_, index) => ev('s', 'page', index, index));
    const streamEvents = Array.from({ length: 150 }, (_, index) => ev('s', 'stream', index, 900 + index));
    let state = dashboardReducer(createDashboardState(), { type: 'pageAppended', page: { events: pageEvents, hasMore: true, nextCursor: 'older' } });
    for (const event of streamEvents) {
      state = dashboardReducer(state, { type: 'streamEvent', event });
    }

    const timeline = selectTimeline(state);
    assert.equal(timeline.length, 1000);
    assert.deepStrictEqual(eventIDs(timeline.slice(0, 3)), ['50:s:page:50', '51:s:page:51', '52:s:page:52']);
    assert.deepStrictEqual(eventIDs(timeline.slice(-3)), ['1047:s:stream:147', '1048:s:stream:148', '1049:s:stream:149']);
  });
});

describe('dashboard cursors and connection states', () => {
  it('replaces page cursors and derives hasOlder from older cursor presence', () => {
    const first = dashboardReducer(createDashboardState(), {
      type: 'pageAppended',
      page: { events: [ev('s', 'r', 1, 1)], hasMore: true, nextCursor: 'older-1' },
      cursor: 'newer-1'
    });
    const second = dashboardReducer(first, { type: 'pageAppended', page: { events: [], hasMore: false, nextCursor: null } });

    assert.equal(first.olderCursor, 'older-1');
    assert.equal(first.newerCursor, 'newer-1');
    assert.equal(selectHasOlder(first), true);
    assert.equal(second.olderCursor, null);
    assert.equal(second.newerCursor, 'newer-1');
    assert.equal(selectHasOlder(second), false);
  });

  it('transitions loading ready empty and error from reducer actions', () => {
    const loading = dashboardReducer(createDashboardState(), { type: 'bootstrapStarted' });
    const empty = dashboardReducer(loading, { type: 'bootstrapReady', roots: [], tree: null, subtreeSessionIDs: [], page: { events: [], hasMore: false, nextCursor: null } });
    const ready = dashboardReducer(empty, { type: 'streamEvent', event: ev('s', 'r', 1, 1) });
    const error = dashboardReducer(ready, { type: 'errorEntered', message: 'sanitized failure' });

    assert.equal(selectStatus(loading), 'loading');
    assert.equal(selectStatus(empty), 'empty');
    assert.equal(selectStatus(ready), 'ready');
    assert.deepStrictEqual({ status: selectStatus(error), errorMessage: error.errorMessage }, { status: 'error', errorMessage: 'sanitized failure' });
  });

  it('falls back to polling after three consecutive SSE failures and resets on success reload or selection change', () => {
    const one = dashboardReducer(createDashboardState(), { type: 'streamFailure' });
    const two = dashboardReducer(one, { type: 'streamFailure' });
    const three = dashboardReducer(two, { type: 'streamFailure' });
    const success = dashboardReducer(three, { type: 'streamSuccess' });
    const reload = dashboardReducer(three, { type: 'reloadRequested' });
    const selection = dashboardReducer(three, { type: 'selectionChanged', mode: 'all' });

    assert.equal(POLL_INTERVAL_MS, 2000);
    assert.deepStrictEqual(selectConnection(two), { mode: 'sse', consecutiveFailures: 2, pollIntervalMs: POLL_INTERVAL_MS });
    assert.deepStrictEqual(selectConnection(three), { mode: 'polling', consecutiveFailures: 3, pollIntervalMs: POLL_INTERVAL_MS });
    assert.deepStrictEqual(selectConnection(success), { mode: 'sse', consecutiveFailures: 0, pollIntervalMs: POLL_INTERVAL_MS });
    assert.deepStrictEqual(selectConnection(reload), { mode: 'sse', consecutiveFailures: 0, pollIntervalMs: POLL_INTERVAL_MS });
    assert.deepStrictEqual(selectConnection(selection), { mode: 'sse', consecutiveFailures: 0, pollIntervalMs: POLL_INTERVAL_MS });
  });

  it('is deterministic for the same action sequence', () => {
    const actions: readonly DashboardAction[] = [
      { type: 'bootstrapStarted' },
      { type: 'pageAppended', page: { events: [ev('s2', 'r', 1, 2), ev('s1', 'r', 1, 1)], hasMore: true, nextCursor: 'older' }, cursor: 'newer' },
      { type: 'streamFailure' },
      { type: 'streamSuccess' },
      { type: 'selectionChanged', mode: 'session', sessionID: 's1' }
    ];
    const reduce = () => actions.reduce(dashboardReducer, createDashboardState());

    assert.deepStrictEqual(reduce(), reduce());
  });
});
