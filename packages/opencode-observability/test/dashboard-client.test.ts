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

function createFetch(script: readonly (ScriptedResponse | Error | Promise<ScriptedResponse>)[]) {
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
    ...bootResponses(),
    { ok: true, status: 200, body }
  ];
}

function bootResponses(): readonly ScriptedResponse[] {
  return [
    json({ roots: [{ sessionID: 'root' }] }),
    json({ tree: { sessionID: 'root', children: [{ sessionID: 'child' }] } }),
    json({ events: [event('e1').event], hasMore: true, nextCursor: 'older-1', newerCursor: 'page-cur' })
  ];
}

function tabStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); }
  };
}

function createHarness(script: readonly (ScriptedResponse | Error | Promise<ScriptedResponse>)[], hash = '#topsecret', sessionStorage = tabStorage()) {
  const fetcher = createFetch(script);
  const timers = createTimers();
  const historyCalls: string[] = [];
  const rendered: DashboardState[] = [];
  const location = { hash, pathname: '/dash', search: '?x=1' };
  const client = createDashboardClient({
    fetch: fetcher.fetch,
    location,
    sessionStorage,
    history: { replaceState: (_state: null, _title: string, url: string) => { historyCalls.push(url); location.hash = ''; } },
    timers,
    renderApp: (_root: unknown, state: DashboardState) => { rendered.push(state); }
  });
  return { client, fetcher, timers, historyCalls, rendered, location, sessionStorage };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('dashboard browser client token and bootstrap contract', () => {
  it('keeps access after a browser reload without putting the credential back in the URL or state', async () => {
    const first = createHarness(baseScript());
    await first.client.start();
    first.client.stop();
    const refreshed = createHarness(baseScript(), first.location.hash, first.sessionStorage);
    await refreshed.client.start();
    assert.equal(refreshed.client.getState().status, 'ready');
    assert.equal(refreshed.fetcher.calls[0]?.init.headers?.['Authorization'], 'Bearer topsecret');
    assert.equal(refreshed.location.hash, '');
    assert.equal(JSON.stringify(refreshed.rendered).includes('topsecret'), false);
    refreshed.client.stop();
  });

  it('a fresh launch replaces a stale credential saved in the tab', async () => {
    const first = createHarness(baseScript());
    await first.client.start();
    first.client.stop();
    const relaunched = createHarness(baseScript(), '#replacement', first.sessionStorage);
    await relaunched.client.start();
    relaunched.client.stop();
    const refreshed = createHarness(baseScript(), '', first.sessionStorage);
    await refreshed.client.start();
    assert.equal(refreshed.fetcher.calls[0]?.init.headers?.['Authorization'], 'Bearer replacement');
    refreshed.client.stop();
  });

  it('invalid credentials clear tab access and stop SSE retries and polling', async () => {
    const harness = createHarness([...bootResponses(), { ok: false, status: 401 }]);
    await harness.client.start();
    harness.timers.runTimeouts();
    harness.timers.tick(POLL_INTERVAL_MS);
    await flushAsync();
    assert.equal(harness.client.getState().status, 'error');
    assert.match(harness.client.getState().errorMessage ?? '', /\/celestion-history/);
    assert.equal(harness.fetcher.calls.length, 4);
    assert.deepEqual(harness.timers.intervalMs(), []);
    const refreshed = createHarness([], '', harness.sessionStorage);
    await refreshed.client.start();
    assert.equal(refreshed.fetcher.calls.length, 0);
    assert.match(refreshed.client.getState().errorMessage ?? '', /\/celestion-history/);
  });

  it('a blocked tab storage does not break a valid launch', async () => {
    const blocked = {
      getItem: (_key: string): string | null => { throw new Error('blocked'); },
      setItem: (_key: string, _value: string) => { throw new Error('blocked'); },
      removeItem: (_key: string) => { throw new Error('blocked'); }
    };
    const harness = createHarness(baseScript(), '#valid', blocked);
    await harness.client.start();
    assert.equal(harness.client.getState().status, 'ready');
    harness.client.stop();
  });

  it('server unavailability gives a recoverable error rather than an unhandled rejection', async () => {
    const harness = createHarness([new TypeError('private connection details')]);
    await assert.doesNotReject(harness.client.start());
    assert.equal(harness.client.getState().status, 'error');
    assert.match(harness.client.getState().errorMessage ?? '', /servidor|Servidor/);
    assert.equal(JSON.stringify(harness.rendered).includes('private connection details'), false);
  });
  it('strips the fragment before requests and sends the token only in Authorization headers', async () => {
    const stream = new FakeBody();
    const { client, fetcher, historyCalls, rendered } = createHarness(baseScript(stream));

    await client.start();

    assert.deepStrictEqual(historyCalls, ['/dash?x=1']);
    assert.deepStrictEqual(fetcher.calls.map((call) => call.url), [
      '/sessions/roots?includeSystem=false',
      '/sessions/root/tree?includeSystem=false',
      '/events?scope=all&includeSystem=false&limit=200',
      '/events/stream?scope=all&includeSystem=false&cursor=page-cur'
    ]);
    for (const call of fetcher.calls) assert.equal(call.init.headers?.['Authorization'], 'Bearer topsecret');
    assert.equal(JSON.stringify(fetcher.calls).includes('topsecret'), true);
    assert.equal(fetcher.calls.some((call) => call.url.includes('topsecret')), false);
    assert.equal(JSON.stringify(rendered).includes('topsecret'), false);
  });

  it('asks to reopen the dashboard without making requests when the tab has no credential', async () => {
    const { client, fetcher } = createHarness([], '#');

    await client.start();

    assert.equal(fetcher.calls.length, 0);
    assert.equal(client.getState().status, 'error');
    assert.match(client.getState().errorMessage ?? '', /\/celestion-history/);
    await client.reload();
    assert.equal(fetcher.calls.length, 0);
  });

  it('loads every historical root without depending on the invoked session', async () => {
    const stream = new FakeBody();
    const { client, fetcher } = createHarness([
      json({ roots: [{ sessionID: 'older-root' }, { sessionID: 'newest-root' }] }),
      json({ tree: { sessionID: 'older-root', children: [] } }),
      json({ tree: { sessionID: 'newest-root', children: [] } }),
      json({ events: [{ ...event('e1').event, sessionID: 'newest-root' }], hasMore: false, nextCursor: null }),
      { ok: true, status: 200, body: stream }
    ]);

    await client.start();

    assert.equal(client.getState().status, 'ready');
    assert.deepStrictEqual(fetcher.calls.map((call) => call.url), [
      '/sessions/roots?includeSystem=false',
      '/sessions/older-root/tree?includeSystem=false',
      '/sessions/newest-root/tree?includeSystem=false',
      '/events?scope=all&includeSystem=false&limit=200',
      '/events/stream?scope=all&includeSystem=false'
    ]);
  });

  it('loads older events with direction older and the stored older cursor', async () => {
    const { client, fetcher } = createHarness([...baseScript(), json({ events: [event('e2').event], hasMore: false, nextCursor: null })]);
    await client.start();

    await client.loadOlder();

    assert.equal(fetcher.calls.at(-1)?.url, '/events?scope=all&includeSystem=false&direction=older&cursor=older-1&limit=200');
  });
});

describe('dashboard browser client streaming and polling contract', () => {
  it('does not reconnect or accept queued frames after the client is stopped', async () => {
    const body = new FakeBody();
    const { client, fetcher, timers } = createHarness(baseScript(body));
    await client.start();
    client.stop();
    body.push('data: ' + JSON.stringify(event('e99')) + '\n\n');
    body.close();
    await flushAsync();
    timers.runTimeouts();
    await flushAsync();
    assert.equal(client.getState().events.some((item) => item.eventID === 'e99'), false);
    assert.equal(fetcher.calls.length, 4);
    assert.deepEqual(timers.intervalMs(), []);
  });

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
    assert.equal(fetcher.calls.at(-1)?.url, '/events/stream?scope=all&includeSystem=false&cursor=cur-9');
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
    const { client, fetcher, timers } = createHarness([...bootResponses(), json({}, false), json({}, false), json({}, false), json({ events: [event('e3').event], hasMore: false, nextCursor: null, newerCursor: 'cur-3' }), json({ events: [], hasMore: false, nextCursor: null })]);
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
    assert.equal(call?.url, '/events?scope=all&includeSystem=false&direction=newer&cursor=page-cur&limit=200');
    assert.equal(call?.init.headers?.['Authorization'], 'Bearer topsecret');
    assert.equal(client.getState().connection.mode, 'polling');
    timers.tick(POLL_INTERVAL_MS);
    await flushAsync();
    assert.equal(fetcher.calls.at(-1)?.url, '/events?scope=all&includeSystem=false&direction=newer&cursor=cur-3&limit=200');
  });
});

describe('dashboard browser client reset and malformed input contract', () => {
  it('aborts in-flight stream clears timers and reboots when includeSystem changes', async () => {
    const { client, fetcher, timers } = createHarness([...baseScript(), json({ roots: [{ sessionID: 'root' }] }), json({ tree: { sessionID: 'root' } }), json({ events: [], hasMore: false, nextCursor: null }), { ok: true, status: 200, body: new FakeBody() }]);
    await client.start();
    const streamSignal = fetcher.calls.at(-1)?.init.signal;
    assert.equal(streamSignal?.aborted, false);

    await client.setIncludeSystem(true);

    assert.equal(streamSignal?.aborted, true);
    assert.equal(fetcher.calls.at(-4)?.url, '/sessions/roots?includeSystem=true');
    assert.equal(fetcher.calls.at(-1)?.url, '/events/stream?scope=all&includeSystem=true');
    assert.deepStrictEqual(timers.intervalMs(), []);
  });

  it('ignores a delayed reload after a newer selection has completed', async () => {
    let complete = (_value: ScriptedResponse) => {};
    const delayed = new Promise<ScriptedResponse>((resolve) => { complete = resolve; });
    const { client, fetcher } = createHarness([...baseScript(), delayed, ...baseScript()]);
    await client.start();
    const reloading = client.reload();
    await client.selectSession('child');
    const count = fetcher.calls.length;
    complete(json({ roots: [{ sessionID: 'obsolete' }] }));
    await reloading;
    assert.equal(client.getState().status, 'ready');
    assert.equal(client.getState().selection.sessionID, 'child');
    assert.deepEqual(client.getState().roots.map((root) => root.sessionID), ['root']);
    assert.equal(fetcher.calls.length, count);
    client.stop();
  });

  it('turns malformed JSON bodies into a generic error without throwing', async () => {
    const { client } = createHarness([{ ok: true, status: 200, json: async () => { throw new SyntaxError('token leaked raw'); } }]);

    await assert.doesNotReject(client.start());

    assert.equal(client.getState().status, 'error');
    assert.equal(client.getState().errorMessage, 'Dashboard unavailable.');
    assert.equal(JSON.stringify(client.getState()).includes('token leaked raw'), false);
  });
});
