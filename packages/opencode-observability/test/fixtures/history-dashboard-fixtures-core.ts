import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import type { StorageScanOptions, StorageScanResult, StorageEntry } from '@opencode-ai/plugin/storage';
import type { Schema } from 'effect';
import { HistoryPersistence } from '../../src/history-persistence';
import { createHistoryQuery, type HistoryQueryService } from '../../src/history-query';
import { createDashboardServer, type DashboardServer } from '../../src/server';
import { createDashboardAssets } from '../../src/server-assets';
import { createDashboardStreamHandler, createDashboardStreamRegistry } from '../../src/server-sse';
import type { ServerDiagnosticCode } from '../../src/server';
import type { SessionHistoryEvent, SessionHistoryEventDraft, SessionLineage } from '../../src/history-domain';

export const FIXTURE = {
  root: { sessionID: 'root1', parentSessionID: null, kind: 'work', observedAtMs: 1000, sanitizedTitle: 'Root', agent: 'coder' } satisfies SessionLineage,
  child: { sessionID: 'child1', parentSessionID: 'root1', kind: 'work', observedAtMs: 1001, sanitizedTitle: 'Child', agent: 'coder' } satisfies SessionLineage,
  grandchild: { sessionID: 'grand1', parentSessionID: 'child1', kind: 'work', observedAtMs: 1002, sanitizedTitle: 'Grand', agent: 'coder' } satisfies SessionLineage,
  hiddenSys: { sessionID: 'sys1', parentSessionID: 'root1', kind: 'system', observedAtMs: 1003, sanitizedTitle: 'HiddenSys', agent: null } satisfies SessionLineage,
  promotedDesc: { sessionID: 'prom1', parentSessionID: 'sys1', kind: 'work', observedAtMs: 1004, sanitizedTitle: 'Promoted', agent: 'coder' } satisfies SessionLineage,
  unknownKind: { sessionID: 'unk1', parentSessionID: 'root1', kind: 'unknown', observedAtMs: 1005, sanitizedTitle: 'UnknownKind', agent: 'tool' } satisfies SessionLineage,
  events: [
    { runID: 'r1', sessionID: 'root1', timestampMs: 2000, type: 'retry', attempt: 1 } as SessionHistoryEventDraft,
    { runID: 'r2', sessionID: 'child1', timestampMs: 2000, type: 'retry', attempt: 1 } as SessionHistoryEventDraft,
    { runID: 'r1', sessionID: 'grand1', timestampMs: 2000, type: 'retry', attempt: 1 } as SessionHistoryEventDraft,
    { runID: 'r3', sessionID: 'child1', timestampMs: 2000, type: 'retry', attempt: 2 } as SessionHistoryEventDraft,
  ] as const,
};

export class AcceptanceStorageFake implements StorageDomain {
  private readonly store = new Map<string, Schema.Json>();

  keys(): string[] { return [...this.store.keys()]; }
  async get(key: string): Promise<Schema.Json | undefined> { return this.store.get(key); }
  async set(key: string, value: Schema.Json): Promise<void> { this.store.set(key, value); }
  async remove(key: string): Promise<void> { this.store.delete(key); }
  async scan(options: StorageScanOptions): Promise<StorageScanResult> {
    const { prefix, limit = 100 } = options;
    const matching: StorageEntry[] = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix) && matching.length < limit) matching.push({ key: k, value: v });
    }
    matching.sort((a, b) => a.key.localeCompare(b.key));
    return { entries: matching } satisfies StorageScanResult;
  }
}

export async function makeAcceptancePersistence(storage = new AcceptanceStorageFake()) {
  const p = await HistoryPersistence.create(storage, { maxEventsPerRun: 1000 });
  p.recordLineage(FIXTURE.root);
  p.recordLineage(FIXTURE.child);
  p.recordLineage(FIXTURE.grandchild);
  p.recordLineage(FIXTURE.hiddenSys);
  p.recordLineage(FIXTURE.promotedDesc);
  p.recordLineage(FIXTURE.unknownKind);
  const seededEvents: SessionHistoryEvent[] = [];
  for (const draft of FIXTURE.events) {
    const res = p.append({ draft });
    if (res.type !== 'appended') throw new Error(`append failed: ${res.type}`);
    seededEvents.push(res.event);
  }
  return { persistence: p, storage, seededEvents };
}

export function makeAcceptanceQueryService(persistence: HistoryPersistence): HistoryQueryService {
  return createHistoryQuery(persistence);
}

export function makeAcceptanceServer(
  queryService: HistoryQueryService,
  persistence: HistoryPersistence,
  diagnostics: Array<ServerDiagnosticCode | string> = [],
  subscribeOverride?: (listener: (event: SessionHistoryEvent) => void) => () => void
): { server: DashboardServer; token: string } {
  const TOKEN = 'acceptance-token-xyz';
  const registry = createDashboardStreamRegistry();
  const subscribe = subscribeOverride ?? ((listener: (event: SessionHistoryEvent) => void) => persistence.subscribeToAppends(listener));
  const streamHandler = createDashboardStreamHandler({
    queryService,
    subscribe,
    heartbeatIntervalMs: 25,
    backpressureLimitBytes: 1_000_000,
    registry,
    onDiagnostic: (code) => diagnostics.push(code),
  });
  const server = createDashboardServer({
    queryService,
    tokenFactory: { generateToken: () => TOKEN },
    assets: createDashboardAssets(),
    streamRegistry: registry,
    streamHandler,
    onDiagnostic: (code) => diagnostics.push(code),
  });
  return { server, token: TOKEN };
}

export async function stopServer(server: DashboardServer) { await server.stop(); }
