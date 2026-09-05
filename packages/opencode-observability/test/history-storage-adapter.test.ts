import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import type { StorageScanOptions, StorageScanResult, StorageEntry } from '@opencode-ai/plugin/storage';
import type { Schema } from 'effect';
import { HistoryStorageAdapter, type HistoryStorageDiagnosticCode } from '../src/history-storage-adapter';
import type { SessionHistoryEvent, SessionLineage } from '../src/history-domain';

class InMemoryStorageFake implements StorageDomain {
  private store = new Map<string, Schema.Json>();
  public readonly keys: string[] = [];
  public maxPageSize: number;
  public failScanAfter: number | null;
  private scanCount = 0;

  constructor(options?: {
    readonly seed?: Record<string, Schema.Json>;
    readonly maxPageSize?: number;
    readonly failScanAfter?: number;
  }) {
    this.maxPageSize = options?.maxPageSize ?? 100;
    this.failScanAfter = options?.failScanAfter ?? null;
    if (options?.seed) {
      for (const [k, v] of Object.entries(options.seed)) {
        this.store.set(k, v);
        this.keys.push(k);
      }
    }
  }

  async get(key: string): Promise<Schema.Json | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: Schema.Json): Promise<void> {
    if (!this.store.has(key)) this.keys.push(key);
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.store.delete(key);
    const idx = this.keys.indexOf(key);
    if (idx >= 0) this.keys.splice(idx, 1);
  }

  async scan(options: StorageScanOptions): Promise<StorageScanResult> {
    this.scanCount++;
    if (this.failScanAfter != null && this.scanCount > this.failScanAfter) {
      throw new Error('simulated scan failure');
    }
    const { prefix, after, limit } = options;
    const pageLimit = Math.min(limit ?? this.maxPageSize, this.maxPageSize);
    const allKeys = [...this.keys].sort();
    let startIdx = 0;
    if (after) {
      const afterIdx = allKeys.indexOf(after);
      startIdx = afterIdx >= 0 ? afterIdx + 1 : 0;
    }
    const matching: StorageEntry[] = [];
    for (let i = startIdx; i < allKeys.length && matching.length < pageLimit; i++) {
      const k = allKeys[i];
      if (k !== undefined && k.startsWith(prefix)) {
        const v = this.store.get(k);
        if (v !== undefined) {
          matching.push({ key: k, value: v });
        }
      }
    }
    const next = matching.length === pageLimit && startIdx + matching.length < allKeys.length
      ? allKeys[startIdx + matching.length]
      : undefined;
    const lastKey = matching.length > 0 ? matching[matching.length - 1]?.key : undefined;
    if (next && lastKey) {
      return { entries: matching, next: lastKey } satisfies StorageScanResult;
    }
    return { entries: matching } satisfies StorageScanResult;
  }
}

describe('HistoryStorageAdapter (TDD)', () => {
  it('constructs with StorageDomain and optional diagnostic callback', () => {
    const fake = new InMemoryStorageFake();
    const codes: HistoryStorageDiagnosticCode[] = [];
    const adapter = new HistoryStorageAdapter(fake, (code) => { codes.push(code); });
    assert.ok(adapter);
    assert.equal(codes.length, 0);
  });

  it('saveEvent uses exact encoded key with runID and 10-digit padded sequence; removeEvent removes exact key', async () => {
    const fake = new InMemoryStorageFake();
    const adapter = new HistoryStorageAdapter(fake);
    const event = {
      eventID: 'e1',
      runID: 'run/雪%',
      sessionID: 's1',
      sequence: 42,
      timestampMs: 1000,
      type: 'run.started',
      parentSessionID: null
    } as const satisfies SessionHistoryEvent;
    await adapter.saveEvent(event);
    const expectedKey = 'history/event/run%2F%E9%9B%AA%25/0000000042';
    assert.ok(fake.keys.includes(expectedKey));
    await adapter.removeEvent('run/雪%', 42);
    assert.ok(!fake.keys.includes(expectedKey));
  });

  it('saveLineage / removeLineage use exact encoded lineage key', async () => {
    const fake = new InMemoryStorageFake();
    const adapter = new HistoryStorageAdapter(fake);
    const lineage = {
      sessionID: 'sess/雪%',
      parentSessionID: null,
      agent: 'work',
      sanitizedTitle: 't',
      kind: 'work',
      observedAtMs: 1000
    } as const satisfies SessionLineage;
    await adapter.saveLineage(lineage);
    const expectedKey = 'history/lineage/sess%2F%E9%9B%AA%25';
    assert.ok(fake.keys.includes(expectedKey));
    await adapter.removeLineage('sess/雪%');
    assert.ok(!fake.keys.includes(expectedKey));
  });

  it('loadEvents (zero-arg) scans root prefix and returns events from every persisted run across pages', async () => {
    const seed: Record<string, Schema.Json> = {
      'history/event/run1/0000000001': { eventID: 'e1', runID: 'run1', sessionID: 's1', sequence: 1, timestampMs: 1, type: 'run.started', parentSessionID: null },
      'history/event/run%2F%E9%9B%AA%25/0000000042': { eventID: 'e42', runID: 'run/雪%', sessionID: 's2', sequence: 42, timestampMs: 2, type: 'run.started', parentSessionID: null }
    };
    const fake = new InMemoryStorageFake({ seed, maxPageSize: 1 });
    const adapter = new HistoryStorageAdapter(fake);
    const events = await adapter.loadEvents();
    const projections = events.map(e => ({ id: e.eventID, run: e.runID, seq: e.sequence })).sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(projections, [
      { id: 'e1', run: 'run1', seq: 1 },
      { id: 'e42', run: 'run/雪%', seq: 42 }
    ]);
  });

  it('loadEvents and loadLineages fully paginate with limit 100 until no next; pageSize=1 forces >=3 event pages and >=2 lineage pages', async () => {
    const seed: Record<string, Schema.Json> = {};
    for (let i = 1; i <= 3; i++) {
      seed[`history/event/run1/${i.toString().padStart(10, '0')}`] = {
        eventID: `e${i}`, runID: 'run1', sessionID: 's1', sequence: i, timestampMs: 1000 + i, type: 'run.started', parentSessionID: null
      };
    }
    seed['history/lineage/s1'] = { sessionID: 's1', parentSessionID: null, agent: null, sanitizedTitle: '', kind: 'unknown', observedAtMs: 1 };
    seed['history/lineage/s2'] = { sessionID: 's2', parentSessionID: 's1', agent: null, sanitizedTitle: '', kind: 'unknown', observedAtMs: 2 };
    const fake = new InMemoryStorageFake({ seed, maxPageSize: 1 });
    const adapter = new HistoryStorageAdapter(fake);
    const events = await adapter.loadEvents();
    const lineages = await adapter.loadLineages();
    const eventIds = events.map(e => e.eventID).sort();
    assert.deepEqual(eventIds, ['e1', 'e2', 'e3']);
    const lineageIds = lineages.map(l => l.sessionID).sort();
    assert.deepEqual(lineageIds, ['s1', 's2']);
  });

  it('malformed event/lineage values are skipped; exact parse codes reported; valid siblings load', async () => {
    const seed: Record<string, Schema.Json> = {
      'history/event/run1/0000000001': { eventID: 'e1', runID: 'run1', sessionID: 's1', sequence: 1, timestampMs: 1, type: 'run.started', parentSessionID: null },
      'history/event/run1/0000000002': { bad: true },
      'history/lineage/s1': { sessionID: 's1', parentSessionID: null, agent: null, sanitizedTitle: '', kind: 'unknown', observedAtMs: 1 },
      'history/lineage/s2': { bad: true }
    };
    const fake = new InMemoryStorageFake({ seed });
    const codes: HistoryStorageDiagnosticCode[] = [];
    const adapter = new HistoryStorageAdapter(fake, (c) => codes.push(c));
    const events = await adapter.loadEvents();
    const lineages = await adapter.loadLineages();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.sequence, 1);
    assert.equal(lineages.length, 1);
    assert.equal(lineages[0]?.sessionID, 's1');
    assert.deepEqual(codes, ['EVENT_PARSE_FAILED', 'LINEAGE_PARSE_FAILED']);
  });

  it('scan failure after first page returns partial valid records + exact scan code; does not throw', async () => {
    const seed: Record<string, Schema.Json> = {
      'history/event/run1/0000000001': { eventID: 'e1', runID: 'run1', sessionID: 's1', sequence: 1, timestampMs: 1, type: 'run.started', parentSessionID: null },
      'history/event/run1/0000000002': { eventID: 'e2', runID: 'run1', sessionID: 's1', sequence: 2, timestampMs: 2, type: 'run.started', parentSessionID: null }
    };
    const fake = new InMemoryStorageFake({ seed, maxPageSize: 1, failScanAfter: 1 });
    const codes: HistoryStorageDiagnosticCode[] = [];
    const adapter = new HistoryStorageAdapter(fake, (c) => codes.push(c));
    const events = await adapter.loadEvents();
    assert.equal(events.length, 1);
    assert.equal(events[0]?.sequence, 1);
    assert.deepEqual(codes, ['EVENT_SCAN_FAILED']);
  });

  it('scan failure after first page for lineages returns partial valid records + exact lineage scan code; does not throw', async () => {
    const seed: Record<string, Schema.Json> = {
      'history/lineage/s1': { sessionID: 's1', parentSessionID: null, agent: null, sanitizedTitle: '', kind: 'unknown', observedAtMs: 1 },
      'history/lineage/s2': { sessionID: 's2', parentSessionID: 's1', agent: null, sanitizedTitle: '', kind: 'unknown', observedAtMs: 2 }
    };
    const fake = new InMemoryStorageFake({ seed, maxPageSize: 1, failScanAfter: 1 });
    const codes: HistoryStorageDiagnosticCode[] = [];
    const adapter = new HistoryStorageAdapter(fake, (c) => codes.push(c));
    const lineages = await adapter.loadLineages();
    assert.equal(lineages.length, 1);
    assert.equal(lineages[0]?.sessionID, 's1');
    assert.deepEqual(codes, ['LINEAGE_SCAN_FAILED']);
  });

  it('throwing diagnostic callback does not reject load', async () => {
    const seed: Record<string, Schema.Json> = {
      'history/event/run1/0000000001': { bad: true }
    };
    const fake = new InMemoryStorageFake({ seed });
    const adapter = new HistoryStorageAdapter(fake, () => { throw new Error('diag boom'); });
    const events = await adapter.loadEvents();
    assert.equal(events.length, 0);
  });
});
