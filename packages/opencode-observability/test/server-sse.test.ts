import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { SessionHistoryEvent, SessionLineage } from '../src/history-domain';
import { HISTORY_CURSOR_VERSION, decodeHistoryCursor, encodeHistoryCursor } from '../src/history-cursor';
import { createHistoryQuery, type HistoryQueryService } from '../src/history-query';
import type { ListEventsInput } from '../src/history-query-contracts';
import { createDashboardAssets } from '../src/server-assets';
import { createDashboardServer, type DashboardServer } from '../src/server';
import { createDashboardStreamHandler, createDashboardStreamRegistry, type StreamDiagnosticCode } from '../src/server-sse';

const TOKEN = 'sse-token';
const ROOT = 'root';

class AppendHub {
  readonly listeners = new Set<(event: SessionHistoryEvent) => void>();
  subscribe = (listener: (event: SessionHistoryEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  emit(event: SessionHistoryEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function event(sequence: number, sessionID = ROOT, timestampMs = sequence): SessionHistoryEvent {
  return { eventID: `event-${sessionID}-${sequence}`, runID: 'run', sessionID, sequence, timestampMs, type: 'model.request', provider: 'p', model: 'm' };
}

function lineage(sessionID: string, parentSessionID: string | null = null, kind: SessionLineage['kind'] = 'work'): SessionLineage {
  return { sessionID, parentSessionID, kind, agent: 'agent', sanitizedTitle: sessionID, observedAtMs: sessionID === ROOT ? 1 : 2 };
}

function source(events: readonly SessionHistoryEvent[], lineages: readonly SessionLineage[] = [lineage(ROOT)]): HistoryQueryService {
  return createHistoryQuery({ getAllEvents: () => [...events], listLineages: () => [...lineages] });
}

function streamURL(origin: string, cursor?: string, selected = ROOT): string {
  const params = new URLSearchParams({ rootSessionID: ROOT, selectedSessionID: selected, scope: 'subtree', includeSystem: 'false' });
  if (cursor !== undefined) params.set('cursor', cursor);
  return `${origin}/events/stream?${params}`;
}

function cursorFor(boundary: SessionHistoryEvent, selectedSessionID = ROOT): string {
  return encodeHistoryCursor({
    version: HISTORY_CURSOR_VERSION,
    rootSessionID: ROOT,
    selectedSessionID,
    scope: 'subtree',
    includeSystem: false,
    direction: 'newer',
    boundary: { timestampMs: boundary.timestampMs, sessionID: boundary.sessionID, runID: boundary.runID, sequence: boundary.sequence }
  });
}

async function withServer(queryService: HistoryQueryService, hub: AppendHub, diagnostics: StreamDiagnosticCode[] = []): Promise<{ readonly server: DashboardServer; readonly origin: string }> {
  const registry = createDashboardStreamRegistry();
  const server = createDashboardServer({
    queryService,
    tokenFactory: { generateToken: () => TOKEN },
    assets: createDashboardAssets(),
    streamRegistry: registry,
    streamHandler: createDashboardStreamHandler({ queryService, subscribe: hub.subscribe, heartbeatIntervalMs: 25, backpressureLimitBytes: 1_000_000, registry, onDiagnostic: (code) => diagnostics.push(code) })
  });
  const descriptor = await server.start();
  return { server, origin: descriptor.origin };
}

async function openStream(url: string, signal?: AbortSignal): Promise<Response> {
  const init: RequestInit = signal === undefined
    ? { headers: { Authorization: `Bearer ${TOKEN}` } }
    : { headers: { Authorization: `Bearer ${TOKEN}` }, signal };
  const response = await fetch(url, init);
  assert.equal(response.status, 200);
  return response;
}

async function collectDataFrames(response: Response, count: number): Promise<readonly { readonly cursor: string; readonly event: SessionHistoryEvent }[]> {
  const body = response.body;
  assert.ok(body);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const frames: { readonly cursor: string; readonly event: SessionHistoryEvent }[] = [];
  const deadline = Date.now() + 2_000;
  while (frames.length < count && Date.now() < deadline) {
    const read = await reader.read();
    if (read.done) break;
    text += decoder.decode(read.value, { stream: true });
    let split = text.indexOf('\n\n');
    while (split >= 0) {
      const frame = text.slice(0, split);
      text = text.slice(split + 2);
      if (frame.startsWith('data: ')) frames.push(JSON.parse(frame.slice(6)));
      split = text.indexOf('\n\n');
    }
  }
  assert.equal(frames.length, count);
  return frames;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

describe('authenticated dashboard SSE stream', () => {
  it('replays every event newer than the cursor across multiple pages with cursor+event envelopes', async () => {
    // Given
    const hub = new AppendHub();
    const all = Array.from({ length: 205 }, (_, i) => event(i + 1));
    const beforeAll = event(0);
    const { server, origin } = await withServer(source(all), hub);
    try {
      // When
      const response = await openStream(streamURL(origin, cursorFor(beforeAll)));
      const frames = await collectDataFrames(response, 205);

      // Then
      assert.deepEqual(frames.map((f) => f.event.eventID), all.map((e) => e.eventID));
      const firstKeys = Object.keys(frames[0] ?? {}).sort();
      assert.deepEqual(firstKeys, ['cursor', 'event']);
      const decoded = decodeHistoryCursor(frames[204]?.cursor ?? '');
      assert.equal(decoded.ok, true);
      if (decoded.ok) assert.deepEqual(decoded.value.boundary, { timestampMs: 205, sessionID: ROOT, runID: 'run', sequence: 205 });
    } finally {
      await server.stop();
    }
  });

  it('subscribes before replay and emits replay plus concurrent live appends exactly once', async () => {
    // Given
    const hub = new AppendHub();
    const replay = [event(1), event(2), event(3), event(4), event(5)];
    const live = [event(6), event(7), event(8)];
    let called = false;
    const queryService: HistoryQueryService = {
      ...source(replay),
      listEvents: (input: ListEventsInput) => {
        if (!called) {
          called = true;
          for (const item of live) hub.emit(item);
        }
        return source(replay).listEvents(input);
      }
    };
    const { server, origin } = await withServer(queryService, hub);
    try {
      // When
      const response = await openStream(streamURL(origin, cursorFor(event(0))));
      const frames = await collectDataFrames(response, 8);

      // Then
      assert.deepEqual(frames.map((f) => f.event.eventID), [...replay, ...live].map((e) => e.eventID));
      assert.equal(new Set(frames.map((f) => f.event.eventID)).size, 8);
    } finally {
      await server.stop();
    }
  });

  it('filters live events by the connect-time scope and cleans up on abort and stop', async () => {
    // Given
    const hub = new AppendHub();
    const registry = createDashboardStreamRegistry();
    const queryService = source([], [lineage(ROOT), lineage('child', ROOT), lineage('outside', null)]);
    const server = createDashboardServer({
      queryService,
      tokenFactory: { generateToken: () => TOKEN },
      assets: createDashboardAssets(),
      streamRegistry: registry,
      streamHandler: createDashboardStreamHandler({ queryService, subscribe: hub.subscribe, heartbeatIntervalMs: 20, registry })
    });
    const descriptor = await server.start();
    try {
      // When
      const abort = new AbortController();
      const response = await openStream(streamURL(descriptor.origin), abort.signal);
      hub.emit(event(1, 'outside'));
      hub.emit(event(2, 'child'));
      const frames = await collectDataFrames(response, 1);
      abort.abort();

      // Then
      assert.deepEqual(frames.map((f) => f.event.sessionID), ['child']);
      await waitUntil(() => hub.listeners.size === 0 && registry.size() === 0, 'expected stream abort cleanup');

      const held = await openStream(streamURL(descriptor.origin));
      assert.equal(hub.listeners.size, 1);
      await server.stop();
      assert.equal(hub.listeners.size, 0);
      assert.equal(registry.size(), 0);
      await held.body?.cancel();
    } finally {
      await server.stop();
    }
  });

  it('emits comment-only heartbeats and reports sanitized backpressure without affecting another client', async () => {
    // Given
    const diagnostics: StreamDiagnosticCode[] = [];
    const hub = new AppendHub();
    const queryService = source([]);
    const { server, origin } = await withServer(queryService, hub, diagnostics);
    try {
      // When
      const heartbeat = await openStream(streamURL(origin));
      const slow = await openStream(streamURL(origin));
      const fast = await openStream(streamURL(origin));
      hub.emit(event(1));
      const fastFrames = await collectDataFrames(fast, 1);
      const heartbeatReader = heartbeat.body?.getReader();
      assert.ok(heartbeatReader);
      const read = await heartbeatReader.read();
      await heartbeatReader.cancel();
      await slow.body?.cancel();

      // Then
      assert.deepEqual(fastFrames.map((f) => f.event.eventID), ['event-root-1']);
      assert.ok(new TextDecoder().decode(read.value).includes(': hb\n\n'));
      assert.equal(diagnostics.every((code) => typeof code === 'string'), true);
    } finally {
      await server.stop();
    }
  });

  it('rejects malformed and cross-scope cursors before opening the stream', async () => {
    // Given
    const hub = new AppendHub();
    const { server, origin } = await withServer(source([]), hub);
    try {
      // When
      const malformed = await fetch(streamURL(origin, 'not-valid*'), { headers: { Authorization: `Bearer ${TOKEN}` } });
      const mismatch = await fetch(streamURL(origin, cursorFor(event(1), 'other')), { headers: { Authorization: `Bearer ${TOKEN}` } });

      // Then
      assert.equal(malformed.status, 400);
      assert.deepEqual(await malformed.json(), { error: 'CURSOR_INVALID' });
      assert.equal(mismatch.status, 400);
      assert.deepEqual(await mismatch.json(), { error: 'CURSOR_SCOPE_MISMATCH' });
    } finally {
      await server.stop();
    }
  });
});
