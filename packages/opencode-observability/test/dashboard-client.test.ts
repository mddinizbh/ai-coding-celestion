import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { POLL_INTERVAL_MS } from '../src/dashboard/state.js';
import { createDashboardClient } from '../src/dashboard/app.js';
import type { DashboardState, HistoryEvent } from '../src/dashboard/state.js';

type FetchCall = { readonly url: string; readonly init: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal } };
type ScriptedResponse = { readonly ok: boolean; readonly status?: number; readonly json?: () => Promise<unknown>; readonly body?: FakeBody };

function event(eventID: string, cursor = eventID): { readonly cursor: string; readonly event: HistoryEvent } {
  return { cursor, event: { eventID, runID: 'run', sessionID: 'root', sequence: Number(eventID.replace(/\D/g, '')) || 1, timestampMs: Date.now(), type: 'test' } };
}

function createFetch(script: readonly (ScriptedResponse | Error)[]) {
  const queue = [...script];
  const calls: FetchCall[] = [];
  const fetch = async (url: string, init: { readonly headers?: Record<string, string>; readonly signal?: AbortSignal } = {}): Promise<ScriptedResponse> => {
    calls.push({ url, init });
    const next = queue.shift();
    if (next instanceof Error) throw next;
    if (next === undefined) throw new Error('unscripted fetch ' + url);
    return next;
  };
  return { fetch, calls };
}

function json(value: unknown, ok = true): ScriptedResponse {
  return { ok, status: ok ? 200 : 500, json: async () => value };
}

class FakeBody {
  readonly #reads: Array<(value: { readonly done: boolean; readonly value?: Uint8Array }) => void> = [];
  readonly #chunks: Array<{ readonly done: boolean; readonly value?: Uint8Array }> = [];
  getReader() {
    return { read: () => new Promise<{ readonly done: boolean; readonly value?: Uint8Array }>((resolve) => this.#next(resolve)) };
  }
  push(text: string): void { this.#emit({ done: false, value: new TextEncoder().encode(text) }); }
  close(): void { this.#emit({ done: true }); }
  #next(resolve: (value: { readonly done: boolean; readonly value?: Uint8Array }) => void): void {
    const chunk = this.#chunks.shift();
    if (chunk) resolve(chunk);
    else this.#reads.push(resolve);
  }
  #emit(chunk: { readonly done: boolean; readonly value?: Uint8Array }): void {
    const read = this.#reads.shift();
    if (read) read(chunk);
    else this.#chunks.push(chunk);
  }
}

function createTimers() {
  let id = 0;
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, { readonly ms: number; readonly fn: () => void }>();
  return {
    setTimeout: (fn: () => void) => { id += 1; timeouts.set(id, fn); return id; },
    setInterval: (fn: () => void, ms: number) => { id += 1; intervals.set(id, { ms, fn }); return id; },
    clearInterval: (timer: number) => { intervals.delete(timer); timeouts.delete(timer); },
    runTimeouts: () => { const pending = [...timeouts.values()]; timeouts.clear(); for (const fn of pending) fn(); },
    tick: (ms: number) => { for (const interval of intervals.values()) if (interval.ms === ms) interval.fn(); },
    intervalMs: () => [...intervals.values()].map((interval) => interval.ms)
  };
}

function baseScript(body = new FakeBody()): readonly ScriptedResponse[] {
  return [
    json({ roots: [{ sessionID: 'root' }], activeRootSessionID: 'root', cursor: 'boot-cur' }),
    json({ tree: { sessionID: 'root', children: [{ sessionID: 'child' }] } }),
    json({ events: [event('e1').event], hasMore: true, nextCursor: 'older-1' }),
    { ok: true, status: 200, body }
  ];
}

function bootResponses(): readonly ScriptedResponse[] {
  return [
    json({ roots: [{ sessionID: 'root' }], activeRootSessionID: 'root', cursor: 'boot-cur' }),
    json({ tree: { sessionID: 'root', children: [{ sessionID: 'child' }] } }),
    json({ events: [event('e1').event], hasMore: true, nextCursor: 'older-1' })
  ];
}

function createHarness(script: readonly (ScriptedResponse | Error)[], hash = '#topsecret') {
  const fetcher = createFetch(script);
  const timers = createTimers();
  const historyCalls: string[] = [];
  const rendered: DashboardState[] = [];
  const client = createDashboardClient({
    fetch: fetcher.fetch,
    location: { hash, pathname: '/dash', search: '?x=1' },
    history: { replaceState: (_state: null, _title: string, url: string) => { historyCalls.push(url); } },
    timers,
    renderApp: (_root: unknown, state: DashboardState) => { rendered.push(state); }
  });
  return { client, fetcher, timers, historyCalls, rendered };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('dashboard browser client token and bootstrap contract', () => {
  it('strips the fragment before requests and sends the token only in Authorization headers', async () => {
    const stream = new FakeBody();
    const { client, fetcher, historyCalls, rendered } = createHarness(baseScript(stream));

    await client.start();

    assert.deepStrictEqual(historyCalls, ['/dash?x=1']);
    assert.deepStrictEqual(fetcher.calls.map((call) => call.url), [
      '/bootstrap',
      '/sessions/root/tree?includeSystem=false',
      '/events?rootSessionID=root&selectedSessionID=root&scope=subtree&includeSystem=false&limit=200',
      '/events/stream?rootSessionID=root&selectedSessionID=root&scope=subtree&includeSystem=false&cursor=boot-cur'
    ]);
    for (const call of fetcher.calls) assert.equal(call.init.headers?.['Authorization'], 'Bearer topsecret');
    assert.equal(JSON.stringify(fetcher.calls).includes('topsecret'), true);
    assert.equal(fetcher.calls.some((call) => call.url.includes('topsecret')), false);
    assert.equal(JSON.stringify(rendered).includes('topsecret'), false);
  });

  it('enters a generic error and performs zero requests when the fragment is empty', async () => {
    const { client, fetcher } = createHarness([], '#');

    await client.start();

    assert.equal(fetcher.calls.length, 0);
    assert.equal(client.getState().status, 'error');
    assert.equal(client.getState().errorMessage, 'Dashboard unavailable.');
  });

  it('loads the newest historical root when the invoked session has no recorded lineage', async () => {
    const stream = new FakeBody();
    const { client, fetcher } = createHarness([
      json({ roots: [{ sessionID: 'older-root' }, { sessionID: 'newest-root' }], activeRootSessionID: null, cursor: 'boot-cur' }),
      json({ tree: { sessionID: 'newest-root', children: [] } }),
      json({ events: [event('e1').event], hasMore: false, nextCursor: null }),
      { ok: true, status: 200, body: stream }
    ]);

    await client.start();

    assert.equal(client.getState().status, 'ready');
    assert.deepStrictEqual(fetcher.calls.map((call) => call.url), [
      '/bootstrap',
      '/sessions/newest-root/tree?includeSystem=false',
      '/events?rootSessionID=newest-root&selectedSessionID=newest-root&scope=subtree&includeSystem=false&limit=200',
      '/events/stream?rootSessionID=newest-root&selectedSessionID=newest-root&scope=subtree&includeSystem=false'
    ]);
  });

  it('loads older events with direction older and the stored older cursor', async () => {
    const { client, fetcher } = createHarness([...baseScript(), json({ events: [event('e2').event], hasMore: false, nextCursor: null })]);
    await client.start();

    await client.loadOlder();

    assert.equal(fetcher.calls.at(-1)?.url, '/events?rootSessionID=root&selectedSessionID=root&scope=subtree&includeSystem=false&direction=older&cursor=older-1&limit=200');
  });
});

describe('dashboard browser client streaming and polling contract', () => {
  it('parses data frames, ignores heartbeats and malformed frames, and reconnects from the latest cursor', async () => {
    const first = new FakeBody();
    const second = new FakeBody();
    const { client, fetcher, timers } = createHarness([...baseScript(first), { ok: true, status: 200, body: second }]);
    await client.start();

    first.push(': hb\n\n');
    first.push('data: not-json\n\n');
    first.push('data: ' + JSON.stringify(event('e9', 'cur-9')) + '\n\n');
    first.close();
    await flushAsync();
    timers.runTimeouts();
    await flushAsync();

    assert.equal(client.getState().events.some((item) => item.eventID === 'e9'), true);
    assert.equal(fetcher.calls.at(-1)?.url, '/events/stream?rootSessionID=root&selectedSessionID=root&scope=subtree&includeSystem=false&cursor=cur-9');
  });

  it('retries SSE after two failures and arms polling exactly on the third failure', async () => {
    const { client, fetcher, timers } = createHarness([...bootResponses(), json({ error: 'bad' }, false), json({ error: 'bad' }, false), json({ error: 'bad' }, false)]);
    await client.start();

    timers.runTimeouts();
    await flushAsync();
    assert.equal(fetcher.calls.filter((call) => call.url.startsWith('/events/stream')).length, 2);
    assert.deepStrictEqual(timers.intervalMs(), []);

    timers.runTimeouts();
    await flushAsync();

    assert.deepStrictEqual(timers.intervalMs(), [POLL_INTERVAL_MS]);
  });

  it('polls newer pages at 2000ms from the latest cursor with bearer auth', async () => {
    const { client, fetcher, timers } = createHarness([...bootResponses(), json({}, false), json({}, false), json({}, false), json({ events: [event('e3').event], hasMore: false, nextCursor: 'cur-3' })]);
    await client.start();
    timers.runTimeouts();
    await flushAsync();
    timers.runTimeouts();
    await flushAsync();
    timers.runTimeouts();
    await flushAsync();

    timers.tick(POLL_INTERVAL_MS);
    await flushAsync();

    const call = fetcher.calls.at(-1);
    assert.equal(call?.url, '/events?rootSessionID=root&selectedSessionID=root&scope=subtree&includeSystem=false&direction=newer&cursor=boot-cur&limit=200');
    assert.equal(call?.init.headers?.['Authorization'], 'Bearer topsecret');
  });
});

describe('dashboard browser client reset and malformed input contract', () => {
  it('aborts in-flight stream clears timers and reboots when includeSystem changes', async () => {
    const { client, fetcher, timers } = createHarness([...baseScript(), json({ roots: [{ sessionID: 'root' }], activeRootSessionID: 'root', cursor: 'again' }), json({ tree: { sessionID: 'root' } }), json({ events: [], hasMore: false, nextCursor: null }), { ok: true, status: 200, body: new FakeBody() }]);
    await client.start();
    const streamSignal = fetcher.calls.at(-1)?.init.signal;
    assert.equal(streamSignal?.aborted, false);

    await client.setIncludeSystem(true);

    assert.equal(streamSignal?.aborted, true);
    assert.equal(fetcher.calls.at(-4)?.url, '/bootstrap');
    assert.equal(fetcher.calls.at(-1)?.url, '/events/stream?rootSessionID=root&selectedSessionID=root&scope=subtree&includeSystem=true&cursor=again');
    assert.deepStrictEqual(timers.intervalMs(), []);
  });

  it('turns malformed JSON bodies into a generic error without throwing', async () => {
    const { client } = createHarness([{ ok: true, status: 200, json: async () => { throw new SyntaxError('token leaked raw'); } }]);

    await assert.doesNotReject(client.start());

    assert.equal(client.getState().status, 'error');
    assert.equal(client.getState().errorMessage, 'Dashboard unavailable.');
    assert.equal(JSON.stringify(client.getState()).includes('token leaked raw'), false);
  });
});
