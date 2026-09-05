import type http from 'node:http';
import { z } from 'zod';

import type { SessionHistoryEvent } from './history-domain';
import {
  HISTORY_CURSOR_VERSION,
  checkCompatibility,
  compareBoundaries,
  decodeHistoryCursor,
  encodeHistoryCursor,
  type DecodeHistoryCursorResult,
  type HistoryCursorBoundary,
  type HistoryCursorContext,
  type HistoryCursorPayload
} from './history-cursor';
import type { HistoryQueryService } from './history-query';
import type { ListEventsInput, ListEventsResult } from './history-query-contracts';
import type { RouteRequest } from './server-routes';
import { securityHeaders } from './server-security';
import { hasValidHistoryScope, historyScopeShape } from './history-scope';

export type StreamDiagnosticCode = 'STREAM_CLIENT_DROPPED' | 'STREAM_LISTENER_FAILED' | 'STREAM_WRITE_FAILED';

export interface DashboardStreamRegistry {
  add(connection: DashboardStreamConnection): void;
  delete(connection: DashboardStreamConnection): void;
  closeAll(): Promise<void>;
  size(): number;
}

export interface DashboardStreamConnection {
  close(): void;
  readonly closed: Promise<void>;
}

export interface DashboardStreamHandlerDeps {
  readonly queryService: HistoryQueryService;
  readonly subscribe: (listener: (event: SessionHistoryEvent) => void) => () => void;
  readonly heartbeatIntervalMs?: number;
  readonly backpressureLimitBytes?: number;
  readonly onDiagnostic?: (code: StreamDiagnosticCode) => void;
  readonly encodeCursor?: (payload: HistoryCursorPayload) => string;
  readonly decodeCursor?: (cursor: string) => DecodeHistoryCursorResult;
  readonly registry?: DashboardStreamRegistry;
}

const HEARTBEAT_INTERVAL_MS = 15_000;
const BACKPRESSURE_LIMIT_BYTES = 1024 * 1024;
const streamQuerySchema = z.object({
  ...historyScopeShape,
  includeSystem: z.enum(['true', 'false']).transform((value) => value === 'true'),
  cursor: z.string().min(1).optional()
}).strict().refine(hasValidHistoryScope);

export function createDashboardStreamRegistry(): DashboardStreamRegistry {
  const connections = new Set<DashboardStreamConnection>();
  return {
    add: (connection) => { connections.add(connection); },
    delete: (connection) => { connections.delete(connection); },
    closeAll: async () => {
      const closing = [...connections].map((connection) => {
        connection.close();
        return connection.closed;
      });
      await Promise.all(closing);
    },
    size: () => connections.size
  };
}

export function createDashboardStreamHandler(deps: DashboardStreamHandlerDeps) {
  const registry = deps.registry ?? createDashboardStreamRegistry();
  const encodeCursor = deps.encodeCursor ?? encodeHistoryCursor;
  const decodeCursor = deps.decodeCursor ?? decodeHistoryCursor;
  return async (request: RouteRequest, raw: { readonly req: http.IncomingMessage; readonly res: http.ServerResponse }): Promise<boolean> => {
    if (request.method !== 'GET') return false;
    const parsed = parseStreamQuery(request.query);
    if (!parsed.ok) {
      writeJson(raw.res, 400, parsed.code);
      return true;
    }
    const context: HistoryCursorContext = { ...parsed.value, direction: 'newer' };
    const scope = deps.queryService.resolveScope(parsed.value);
    if (!scope.ok) {
      writeJson(raw.res, 400, scope.code);
      return true;
    }
    if (parsed.value.cursor !== undefined) {
      const cursor = decodeCursor(parsed.value.cursor);
      if (!cursor.ok) {
        writeJson(raw.res, 400, cursor.code);
        return true;
      }
      const compatible = checkCompatibility(cursor.value, context);
      if (!compatible.ok) {
        writeJson(raw.res, 400, compatible.code);
        return true;
      }
    }
    await runStream({ request: raw.req, response: raw.res, context, membership: new Set(scope.sessionIDs), cursor: parsed.value.cursor, deps, registry, encodeCursor });
    return true;
  };
}

type ParsedStreamQuery = z.infer<typeof streamQuerySchema>;
type StreamQueryResult = { readonly ok: true; readonly value: ParsedStreamQuery } | { readonly ok: false; readonly code: 'PARAM_INVALID' | 'PARAM_AMBIGUOUS' };
type RunStreamInput = {
  readonly request: http.IncomingMessage;
  readonly response: http.ServerResponse;
  readonly context: HistoryCursorContext;
  readonly membership: ReadonlySet<string>;
  readonly cursor: string | undefined;
  readonly deps: DashboardStreamHandlerDeps;
  readonly registry: DashboardStreamRegistry;
  readonly encodeCursor: (payload: HistoryCursorPayload) => string;
};

function parseStreamQuery(query: RouteRequest['query']): StreamQueryResult {
  const values: Record<string, string> = {};
  for (const [key, value] of query) {
    if (key in values) return { ok: false, code: 'PARAM_AMBIGUOUS' };
    values[key] = value;
  }
  const parsed = streamQuerySchema.safeParse(values);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, code: 'PARAM_INVALID' };
}

/**
 * Seleções locais usam o snapshot de conexão. all resolve o conjunto atual
 * para incluir sessões novas sem perder o filtro de sessões de sistema.
 */
async function runStream(input: RunStreamInput): Promise<void> {
  const buffered: SessionHistoryEvent[] = [];
  const sent = new Set<string>();
  let replaying = true;
  let closed = false;
  let unsubscribe = (): void => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let resolveClosed = (): void => {};
  const closedPromise = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const connection: DashboardStreamConnection = { close: () => cleanup(true), closed: closedPromise };
  const report = (code: StreamDiagnosticCode): void => {
    try { input.deps.onDiagnostic?.(code); } catch { return; }
  };
  const cleanup = (destroy: boolean): void => {
    if (closed) return;
    closed = true;
    if (heartbeat !== undefined) clearInterval(heartbeat);
    unsubscribe();
    input.registry.delete(connection);
    if (destroy && !input.response.destroyed) input.response.destroy();
    resolveClosed();
  };
  const listener = (event: SessionHistoryEvent): void => {
    try {
      if (input.context.scope === 'all') {
        const current = input.deps.queryService.resolveScope(input.context);
        if (!current.ok || !current.sessionIDs.includes(event.sessionID)) return;
      } else if (!input.membership.has(event.sessionID)) return;
      if (replaying) buffered.push(event);
      else emit(event);
    } catch {
      report('STREAM_LISTENER_FAILED');
      cleanup(true);
    }
  };
  const emit = (event: SessionHistoryEvent): void => {
    if (closed || sent.has(event.eventID)) return;
    sent.add(event.eventID);
    const payload = JSON.stringify({ cursor: input.encodeCursor({ version: HISTORY_CURSOR_VERSION, ...input.context, boundary: boundaryOf(event) }), event });
    if (!input.response.write(`data: ${payload}\n\n`)) checkBackpressure(input.response, input.deps.backpressureLimitBytes ?? BACKPRESSURE_LIMIT_BYTES, report, cleanup);
  };
  unsubscribe = input.deps.subscribe(listener);
  input.registry.add(connection);
  input.request.on('aborted', () => cleanup(false));
  input.response.on('close', () => cleanup(false));
  input.response.on('finish', () => cleanup(false));
  input.response.writeHead(200, { ...securityHeaders(), 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  heartbeat = setInterval(() => {
    if (closed) return;
    if (!input.response.write(': hb\n\n')) checkBackpressure(input.response, input.deps.backpressureLimitBytes ?? BACKPRESSURE_LIMIT_BYTES, report, cleanup);
  }, input.deps.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS);
  // all sem cursor vem de uma página inicialmente vazia. A assinatura acima
  // precede o replay para cobrir eventos que chegaram entre a página e o SSE.
  if (input.cursor !== undefined || input.context.scope === 'all') await replayAll(input.cursor, input.context, input.deps.queryService, emit);
  replaying = false;
  buffered.sort((a, b) => compareBoundaries(boundaryOf(a), boundaryOf(b)));
  for (const event of buffered) emit(event);
}

async function replayAll(cursor: string | undefined, context: HistoryCursorContext, queryService: HistoryQueryService, emit: (event: SessionHistoryEvent) => void): Promise<void> {
  let nextCursor: string | undefined = cursor;
  do {
    const input: ListEventsInput = { ...context, direction: 'newer', cursor: nextCursor };
    const result: ListEventsResult = queryService.listEvents(input);
    if (!result.ok) return;
    for (const event of result.page.events) emit(event);
    nextCursor = result.page.nextCursor ?? undefined;
  } while (nextCursor !== undefined);
}

function checkBackpressure(response: http.ServerResponse, limit: number, report: (code: StreamDiagnosticCode) => void, cleanup: (destroy: boolean) => void): void {
  if (response.writableLength <= limit) return;
  report('STREAM_CLIENT_DROPPED');
  cleanup(true);
}

function writeJson(response: http.ServerResponse, status: number, code: string): void {
  response.writeHead(status, { ...securityHeaders(), 'Content-Type': 'application/json' });
  response.end(JSON.stringify({ error: code }));
}

function boundaryOf(event: SessionHistoryEvent): HistoryCursorBoundary {
  return { timestampMs: event.timestampMs, sessionID: event.sessionID, runID: event.runID, sequence: event.sequence };
}
