import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createDashboardClient } from '../src/dashboard/app.js';
import { selectTimeline } from '../src/dashboard/state.js';
import type { SessionHistoryEvent, SessionLineage } from '../src/history-domain';
import { createHistoryQuery } from '../src/history-query';
import { createDashboardServer } from '../src/server';
import { createDashboardAssets } from '../src/server-assets';
import { createDashboardStreamHandler, createDashboardStreamRegistry } from '../src/server-sse';

const lineage = (sessionID: string, parentSessionID: string | null = null, kind: SessionLineage['kind'] = 'work'): SessionLineage => ({
  sessionID, parentSessionID, kind, agent: 'coder', sanitizedTitle: sessionID, observedAtMs: 1
});
const event = (sessionID: string, sequence: number): SessionHistoryEvent => ({
  eventID: `e${sequence}`, sessionID, sequence, timestampMs: sequence, runID: 'run', type: 'run.started', parentSessionID: null
});

async function harness(empty = false) {
  const lineages = empty ? [] : [lineage('a'), lineage('b'), lineage('child', 'b'), lineage('system', null, 'system'), lineage('promoted', 'system')];
  const events = empty ? [] : [event('a', 1), event('b', 2), event('child', 3), event('system', 4), event('promoted', 5)];
  const listeners = new Set<(event: SessionHistoryEvent) => void>();
  const queryService = createHistoryQuery({ listLineages: () => lineages, getAllEvents: () => events });
  const registry = createDashboardStreamRegistry();
  const server = createDashboardServer({
    queryService, assets: createDashboardAssets(), tokenFactory: { generateToken: () => 'test-access' }, streamRegistry: registry,
    streamHandler: createDashboardStreamHandler({ queryService, registry, heartbeatIntervalMs: 10, subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    } })
  });
  server.setActiveSession('a');
  const { origin } = await server.start();
  const values = new Map<string, string>();
  const sessionStorage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
  const clients: ReturnType<typeof createDashboardClient>[] = [];
  const requests: string[] = [];
  let intercept: ((url: string, forward: () => Promise<Response>) => Promise<Response>) | null = null;
  function createClient(hash = '#test-access') {
    const location = { hash, pathname: '/', search: '' };
    const client = createDashboardClient({
      fetch: (url: string, init: RequestInit) => {
        requests.push(url);
        const forward = () => fetch(origin + url, init);
        return intercept ? intercept(url, forward) : forward();
      }, location,
      history: { replaceState: () => { location.hash = ''; } }, sessionStorage,
      timers: { setTimeout, setInterval, clearInterval }
    });
    clients.push(client);
    return { client, location };
  }
  return {
    ...createClient(), createClient, lineages, requests,
    interceptFetch(handler: NonNullable<typeof intercept>) { intercept = handler; },
    append(item: SessionHistoryEvent) { events.push(item); for (const listener of listeners) listener(item); },
    async stop() { for (const client of clients) client.stop(); await server.stop(); }
  };
}

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 1500;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'atualização do dashboard não chegou');
}

describe('cliente com histórico HTTP/SSE real', () => {
  it('recupera todos os eventos que chegam após a página vazia e antes da assinatura SSE', async () => {
    const h = await harness(true);
    let inserted = false;
    h.interceptFetch(async (url, forward) => {
      if (!inserted && url.startsWith('/events/stream?')) {
        inserted = true;
        h.lineages.push(lineage('first'));
        for (let sequence = 1; sequence <= 205; sequence++) h.append(event('first', sequence));
      }
      return forward();
    });
    try {
      await h.client.start();
      await waitFor(() => h.client.getState().events.length === 205);
      assert.equal(h.client.getState().events[0]?.eventID, 'e1');
      assert.equal(h.client.getState().events.at(-1)?.eventID, 'e205');
      await waitFor(() => h.client.getState().trees.some((tree) => tree.sessionID === 'first'));
      assert.equal(h.client.getState().status, 'ready');
    } finally { await h.stop(); }
  });

  it('refaz a leitura se outra sessão chegar durante um refresh com snapshot antigo', async () => {
    const h = await harness();
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = false;
    let held = false;
    h.interceptFetch(async (url, forward) => {
      const response = await forward();
      if (armed && !held && url.startsWith('/sessions/roots')) {
        held = true;
        await gate;
      }
      return response;
    });
    try {
      await h.client.start();
      armed = true;
      h.lineages.push(lineage('new-b'));
      h.append(event('new-b', 6));
      await waitFor(() => held);
      h.lineages.push(lineage('new-c'));
      h.append(event('new-c', 7));
      await waitFor(() => h.client.getState().events.some((e) => e.eventID === 'e7'));
      release();
      await waitFor(() => h.client.getState().trees.some((tree) => tree.sessionID === 'new-c'));
      assert.ok(h.client.getState().trees.some((tree) => tree.sessionID === 'new-b'));
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e1', 'e2', 'e3', 'e5', 'e6', 'e7']);
    } finally { release(); await h.stop(); }
  });

  it('reconcilia uma sessão criada entre a leitura das árvores e a página inicial', async () => {
    const h = await harness();
    let inserted = false;
    h.interceptFetch(async (url, forward) => {
      if (!inserted && url.startsWith('/events?')) {
        inserted = true;
        h.lineages.push(lineage('new-root'));
        h.append(event('new-root', 6));
      }
      return forward();
    });
    try {
      await h.client.start();
      assert.ok(h.client.getState().events.some((e) => e.eventID === 'e6'));
      await waitFor(() => h.client.getState().trees.some((tree) => tree.sessionID === 'new-root'));
      await h.client.selectSession('new-root');
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e6']);
    } finally { await h.stop(); }
  });

  it('abre todas as raízes e mantém o mesmo acesso após F5, independentemente da sessão ativa', async () => {
    const h = await harness();
    try {
      await h.client.start();
      assert.equal(h.client.getState().status, 'ready');
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e1', 'e2', 'e3', 'e5']);
      assert.deepEqual(h.client.getState().trees.map((tree) => tree.sessionID), ['a', 'b', 'promoted']);
      assert.equal(h.location.hash, '');
      h.client.stop();
      const refreshed = h.createClient(h.location.hash);
      await refreshed.client.start();
      assert.deepEqual(selectTimeline(refreshed.client.getState()).map((e) => e.eventID), ['e1', 'e2', 'e3', 'e5']);
    } finally { await h.stop(); }
  });

  it('navega para outra raiz, filtra só a sessão ou sua subárvore e volta para todas', async () => {
    const h = await harness();
    try {
      await h.client.start();
      await h.client.selectSession('b');
      assert.equal(h.client.getState().status, 'ready');
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e2']);
      await h.client.selectSubtree('b');
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e2', 'e3']);
      await h.client.selectSubtree('child');
      assert.deepEqual(h.client.getState().subtreeSessionIDs, ['child']);
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e3']);
      await h.client.selectAll();
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e1', 'e2', 'e3', 'e5']);
      assert.ok(h.requests.some((url) => url.startsWith('/events?rootSessionID=b&selectedSessionID=child&scope=subtree')));
    } finally { await h.stop(); }
  });

  it('mostra raízes de sistema ao habilitar o filtro e volta a todas se a seleção ficar oculta', async () => {
    const h = await harness();
    try {
      await h.client.start();
      await h.client.setIncludeSystem(true);
      assert.equal(h.client.getState().status, 'ready');
      assert.deepEqual(h.client.getState().trees.map((tree) => tree.sessionID), ['a', 'b', 'system']);
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e1', 'e2', 'e3', 'e4', 'e5']);
      await h.client.selectSession('system');
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e4']);
      await h.client.setIncludeSystem(false);
      assert.equal(h.client.getState().selection.mode, 'all');
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e1', 'e2', 'e3', 'e5']);
    } finally { await h.stop(); }
  });

  it('inclui uma nova conversa e seus subagentes na árvore e na timeline sem reabrir a aba', async () => {
    const h = await harness();
    try {
      await h.client.start();
      h.lineages.push(lineage('new-root'), lineage('new-child', 'new-root'));
      h.append(event('new-root', 6));
      h.append(event('new-child', 7));
      await waitFor(() => h.client.getState().trees.some((tree) => tree.sessionID === 'new-root'));
      assert.deepEqual(selectTimeline(h.client.getState()).map((e) => e.eventID), ['e1', 'e2', 'e3', 'e5', 'e6', 'e7']);
      assert.equal(h.client.getState().trees.find((tree) => tree.sessionID === 'new-root')?.children?.[0]?.sessionID, 'new-child');
    } finally { await h.stop(); }
  });

  it('abre um histórico vazio e recebe a primeira sessão ao vivo', async () => {
    const h = await harness(true);
    try {
      await h.client.start();
      assert.equal(h.client.getState().status, 'empty');
      h.lineages.push(lineage('first'));
      h.append(event('first', 1));
      await waitFor(() => h.client.getState().events.length === 1);
      assert.equal(h.client.getState().status, 'ready');
    } finally { await h.stop(); }
  });
});
