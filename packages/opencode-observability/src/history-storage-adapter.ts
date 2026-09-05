import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import type { Schema } from 'effect';
import {
  sessionHistoryEventSchema,
  sessionLineageSchema,
  type SessionHistoryEvent,
  type SessionLineage
} from './history-domain';

export type HistoryStorageDiagnosticCode =
  | 'EVENT_SCAN_FAILED'
  | 'EVENT_PARSE_FAILED'
  | 'LINEAGE_SCAN_FAILED'
  | 'LINEAGE_PARSE_FAILED';

const PAGE_LIMIT = 100;

export class HistoryStorageAdapter {
  constructor(
    private readonly storage: StorageDomain,
    private readonly onDiagnostic?: (code: HistoryStorageDiagnosticCode) => void
  ) {}

  private rootEventPrefix(): string {
    return 'history/event/';
  }

  private eventPrefix(runID: string): string {
    return `${this.rootEventPrefix()}${encodeURIComponent(runID)}/`;
  }

  private eventKey(runID: string, sequence: number): string {
    return `${this.eventPrefix(runID)}${sequence.toString().padStart(10, '0')}`;
  }

  private lineagePrefix(): string {
    return 'history/lineage/';
  }

  private lineageKey(sessionID: string): string {
    return `${this.lineagePrefix()}${encodeURIComponent(sessionID)}`;
  }

  private report(code: HistoryStorageDiagnosticCode): void {
    if (!this.onDiagnostic) return;
    try {
      this.onDiagnostic(code);
    } catch {
      return;
    }
  }

  async saveEvent(event: SessionHistoryEvent): Promise<void> {
    const json = { ...event } satisfies Schema.Json;
    await this.storage.set(this.eventKey(event.runID, event.sequence), json);
  }

  async removeEvent(runID: string, sequence: number): Promise<void> {
    await this.storage.remove(this.eventKey(runID, sequence));
  }

  async saveLineage(lineage: SessionLineage): Promise<void> {
    const json = { ...lineage } satisfies Schema.Json;
    await this.storage.set(this.lineageKey(lineage.sessionID), json);
  }

  async removeLineage(sessionID: string): Promise<void> {
    await this.storage.remove(this.lineageKey(sessionID));
  }

  async loadEvents(): Promise<SessionHistoryEvent[]> {
    const prefix = this.rootEventPrefix();
    const results: SessionHistoryEvent[] = [];
    let after: string | undefined;
    while (true) {
      try {
        const opts: { prefix: string; limit: number; after?: string } = { prefix, limit: PAGE_LIMIT };
        if (after !== undefined) opts.after = after;
        const res = await this.storage.scan(opts);
        for (const entry of res.entries) {
          const parsed = sessionHistoryEventSchema.safeParse(entry.value);
          if (parsed.success) {
            results.push(parsed.data);
          } else {
            this.report('EVENT_PARSE_FAILED');
          }
        }
        if (!res.next) break;
        after = res.next;
      } catch {
        this.report('EVENT_SCAN_FAILED');
        break;
      }
    }
    return results;
  }

  async loadLineages(): Promise<SessionLineage[]> {
    const prefix = this.lineagePrefix();
    const results: SessionLineage[] = [];
    let after: string | undefined;
    while (true) {
      try {
        const opts: { prefix: string; limit: number; after?: string } = { prefix, limit: PAGE_LIMIT };
        if (after !== undefined) opts.after = after;
        const res = await this.storage.scan(opts);
        for (const entry of res.entries) {
          const parsed = sessionLineageSchema.safeParse(entry.value);
          if (parsed.success) {
            results.push(parsed.data);
          } else {
            this.report('LINEAGE_PARSE_FAILED');
          }
        }
        if (!res.next) break;
        after = res.next;
      } catch {
        this.report('LINEAGE_SCAN_FAILED');
        break;
      }
    }
    return results;
  }
}
