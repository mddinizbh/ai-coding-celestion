import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import { InMemoryHistoryEventStore, type HistoryEventAppendResult } from './history-event-store';
import { HistoryStorageAdapter, type HistoryStorageDiagnosticCode } from './history-storage-adapter';
import type { SessionHistoryEvent, SessionHistoryEventDraft, SessionLineage } from './history-domain';

export type HistoryPersistenceDiagnosticCode =
  | HistoryStorageDiagnosticCode
  | 'EVENT_SAVE_FAILED'
  | 'EVENT_REMOVE_FAILED'
  | 'LINEAGE_SAVE_FAILED'
  | 'LINEAGE_REMOVE_FAILED';

export interface HistoryPersistenceOptions {
  readonly maxEventsPerRun?: number;
  readonly onDiagnostic?: (code: HistoryPersistenceDiagnosticCode) => void;
}

type HistoryAppendListener = (event: SessionHistoryEvent) => void;

export class HistoryPersistence {
  private queueTail: Promise<void> = Promise.resolve();

  private readonly appendListeners = new Set<HistoryAppendListener>();

  private constructor(
    private readonly store: InMemoryHistoryEventStore,
    private readonly adapter: HistoryStorageAdapter,
    private readonly lineages: Map<string, SessionLineage>,
    private readonly onDiagnostic?: (code: HistoryPersistenceDiagnosticCode) => void
  ) {}

  static async create(storage: StorageDomain, options?: HistoryPersistenceOptions): Promise<HistoryPersistence> {
    const safeReporter = (code: HistoryStorageDiagnosticCode) => {
      if (!options?.onDiagnostic) return;
      try { options.onDiagnostic(code); } catch { return; }
    };
    const adapter = new HistoryStorageAdapter(storage, safeReporter);
    const events = await adapter.loadEvents();
    const lineageList = await adapter.loadLineages();
    const max = options?.maxEventsPerRun;
    const store = new InMemoryHistoryEventStore(max != null ? { maxEventsPerRun: max } : undefined);
    const { rejected, evicted } = store.restore(events);
    const lineages = new Map<string, SessionLineage>();
    for (const l of lineageList) lineages.set(l.sessionID, l);
    const p = new HistoryPersistence(store, adapter, lineages, options?.onDiagnostic);
    for (const ev of [...rejected, ...evicted]) {
      p.enqueue(() => adapter.removeEvent(ev.runID, ev.sequence), 'EVENT_REMOVE_FAILED');
    }
    return p;
  }

  private enqueue(operation: () => Promise<void>, failureCode: Extract<HistoryPersistenceDiagnosticCode, `${string}_FAILED`>): void {
    this.queueTail = this.queueTail.then(async () => {
      try { await operation(); } catch { this.report(failureCode); }
    });
  }

  private report(code: HistoryPersistenceDiagnosticCode): void {
    if (!this.onDiagnostic) return;
    try { this.onDiagnostic(code); } catch { return; }
  }

  private deliverAppend(listener: HistoryAppendListener, event: SessionHistoryEvent): void {
    try { listener(event); } catch { return; }
  }

  subscribeToAppends(listener: HistoryAppendListener): () => void {
    this.appendListeners.add(listener);
    return () => {
      this.appendListeners.delete(listener);
    };
  }

  append(input: { readonly draft: SessionHistoryEventDraft; readonly upstreamEventID?: string }): HistoryEventAppendResult {
    const result = this.store.append(input);
    if (result.type === 'appended') {
      for (const listener of this.appendListeners) {
        this.deliverAppend(listener, result.event);
      }
      this.enqueue(() => this.adapter.saveEvent(result.event), 'EVENT_SAVE_FAILED');
      for (const ev of result.evicted) {
        this.enqueue(() => this.adapter.removeEvent(ev.runID, ev.sequence), 'EVENT_REMOVE_FAILED');
      }
    }
    return result;
  }

  getRunEvents(runID: string): ReadonlyArray<SessionHistoryEvent> {
    return this.store.getRunEvents(runID);
  }

  getAllEvents(): ReadonlyArray<SessionHistoryEvent> {
    return this.store.getAllEvents();
  }

  finishRun(runID: string): void {
    this.store.finishRun(runID);
  }

  recordLineage(lineage: SessionLineage): void {
    this.lineages.set(lineage.sessionID, lineage);
    this.enqueue(() => this.adapter.saveLineage(lineage), 'LINEAGE_SAVE_FAILED');
  }

  deleteLineage(sessionID: string): void {
    this.lineages.delete(sessionID);
    this.enqueue(() => this.adapter.removeLineage(sessionID), 'LINEAGE_REMOVE_FAILED');
  }

  listLineages(): readonly SessionLineage[] {
    return Array.from(this.lineages.values()).sort((a, b) => a.sessionID.localeCompare(b.sessionID) || a.observedAtMs - b.observedAtMs);
  }

  async shutdown(): Promise<void> {
    await this.queueTail;
    this.appendListeners.clear();
  }
}
