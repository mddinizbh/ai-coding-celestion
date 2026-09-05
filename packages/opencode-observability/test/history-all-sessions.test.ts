import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decodeHistoryCursor } from '../src/history-cursor';
import type { SessionHistoryEvent, SessionLineage } from '../src/history-domain';
import { createHistoryQuery } from '../src/history-query';
import { listEventsInputSchema } from '../src/history-query-contracts';
import { handleRouteRequest } from '../src/server-routes';

const lineages: SessionLineage[] = [
  { sessionID: 'a', parentSessionID: null, kind: 'work', agent: null, sanitizedTitle: 'A', observedAtMs: 1 },
  { sessionID: 'b', parentSessionID: null, kind: 'work', agent: null, sanitizedTitle: 'B', observedAtMs: 2 },
  { sessionID: 'sys', parentSessionID: 'b', kind: 'system', agent: null, sanitizedTitle: 'Sistema', observedAtMs: 3 },
  { sessionID: 'child', parentSessionID: 'sys', kind: 'work', agent: null, sanitizedTitle: 'Filho', observedAtMs: 4 }
];
const events: SessionHistoryEvent[] = ['a', 'b', 'sys', 'child', 'a', 'b'].map((sessionID, i) => ({
  eventID: `e${i + 1}`, runID: 'run', sessionID, sequence: i + 1, timestampMs: i + 1, type: 'run.started', parentSessionID: null
}));
const queryService = createHistoryQuery({ listLineages: () => lineages, getAllEvents: () => events });
const all = { scope: 'all' as const, includeSystem: false };

function request(search: string) {
  return handleRouteRequest({ method: 'GET', pathname: '/events', query: [...new URLSearchParams(search)] }, {
    queryService, getActiveSessionID: () => 'a'
  });
}

describe('histórico de todas as sessões', () => {
  it('agrega raízes independentes e descendentes visíveis, sem incluir sistema por padrão', () => {
    const response = request('scope=all&includeSystem=false');
    assert.equal(response.status, 200);
    const page = JSON.parse(response.body);
    assert.deepEqual(page.events.map((e: SessionHistoryEvent) => e.eventID), ['e1', 'e2', 'e4', 'e5', 'e6']);
    assert.equal(page.resolvedRunID, undefined);
    assert.equal(page.hasMore, false);
    const withSystem = request('scope=all&includeSystem=true');
    assert.equal(withSystem.status, 200);
    assert.deepEqual(JSON.parse(withSystem.body).events.map((e: SessionHistoryEvent) => e.eventID), ['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
  });

  it('pagina entre raízes sem repetir nem perder eventos', () => {
    const first = queryService.listEvents({ ...all, limit: 2 });
    assert.ok(first.ok);
    assert.deepEqual(first.page.events.map((e) => e.eventID), ['e5', 'e6']);
    assert.ok(first.page.nextCursor);
    const second = queryService.listEvents({ ...all, limit: 2, direction: 'older', cursor: first.page.nextCursor });
    assert.ok(second.ok);
    assert.deepEqual(second.page.events.map((e) => e.eventID), ['e2', 'e4']);
    assert.ok(second.page.nextCursor);
    const final = queryService.listEvents({ ...all, limit: 2, direction: 'older', cursor: second.page.nextCursor });
    assert.ok(final.ok);
    assert.deepEqual(final.page.events.map((e) => e.eventID), ['e1']);
    assert.equal(final.page.hasMore, false);
    assert.equal(final.page.nextCursor, null);
  });

  it('fornece cursor de atualização inclusive na última página para o polling avançar', () => {
    const page = queryService.listEvents(all);
    assert.ok(page.ok);
    const decoded = decodeHistoryCursor(page.page.newerCursor ?? '');
    assert.ok(decoded.ok);
    assert.equal(decoded.value.scope, 'all');
    assert.equal(decoded.value.rootSessionID, undefined);
    assert.equal(decoded.value.selectedSessionID, undefined);
    assert.equal(decoded.value.direction, 'newer');
    assert.deepEqual(decoded.value.boundary, { timestampMs: 6, sessionID: 'b', runID: 'run', sequence: 6 });
    const newer = queryService.listEvents({ ...all, direction: 'newer', cursor: page.page.newerCursor ?? undefined });
    assert.ok(newer.ok);
    assert.deepEqual(newer.page.events, []);
  });

  it('não reutiliza cursor global ao selecionar sessão ou mudar o filtro de sistema', () => {
    const first = queryService.listEvents({ ...all, limit: 1 });
    assert.ok(first.ok && first.page.nextCursor);
    const cursor = first.page.nextCursor;
    assert.deepEqual(queryService.listEvents({ rootSessionID: 'a', selectedSessionID: 'a', scope: 'session', includeSystem: false, direction: 'older', cursor }), { ok: false, code: 'CURSOR_SCOPE_MISMATCH' });
    assert.deepEqual(queryService.listEvents({ ...all, includeSystem: true, direction: 'older', cursor }), { ok: false, code: 'CURSOR_SCOPE_MISMATCH' });
  });

  it('aceita histórico vazio sem inventar uma raiz', () => {
    const empty = createHistoryQuery({ listLineages: () => [], getAllEvents: () => [] });
    const result = empty.listEvents(all);
    assert.ok(result.ok);
    assert.deepEqual(result.page.events, []);
    assert.equal(result.page.hasMore, false);
  });

  it('exige all explícito: parâmetros ausentes ou mistura com seleção não ampliam o acesso', () => {
    assert.equal(listEventsInputSchema.safeParse(all).success, true);
    for (const input of [
      { scope: 'session', includeSystem: false },
      { scope: 'subtree', includeSystem: false },
      { ...all, rootSessionID: 'a' },
      { ...all, selectedSessionID: 'a' }
    ]) assert.equal(listEventsInputSchema.safeParse(input).success, false);
    for (const search of [
      'includeSystem=false', 'scope=session&includeSystem=false',
      'scope=all&includeSystem=false&rootSessionID=a', 'scope=all&includeSystem=false&selectedSessionID=a',
      'scope=all&includeSystem=false&scope=session', 'scope=all&includeSystem=TRUE'
    ]) assert.equal(request(search).status, 400, search);
  });
});
