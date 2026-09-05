import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import type { StorageScanOptions, StorageScanResult, StorageEntry } from '@opencode-ai/plugin/storage';
import type { Schema } from 'effect';
import { HistoryPersistence, type HistoryPersistenceDiagnosticCode } from '../src/history-persistence';
import type { SessionHistoryEvent, SessionLineage } from '../src/history-domain';

type OpLog = { op: 'get' | 'set' | 'remove' | 'scan'; key: string; value?: Schema.Json };

class TestStorageFake implements StorageDomain {
  private store = new Map<string, Schema.Json>();
  public readonly ops: OpLog[] = [];
  public failSet = new Set<string>();
  public failRemove = new Set<string>();
  public failScan = false;

  async get(key: string): Promise<Schema.Json | undefined> {
    this.ops.push({ op: 'get', key });
    return this.store.get(key);
  }

  async set(key: string, value: Schema.Json): Promise<void> {
    this.ops.push({ op: 'set', key, value });
    if (this.failSet.has(key)) throw new Error('set failed');
    this.store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.ops.push({ op: 'remove', key });
    if (this.failRemove.has(key)) throw new Error('remove failed');
    this.store.delete(key);
  }

  async scan(options: StorageScanOptions): Promise<StorageScanResult> {
    this.ops.push({ op: 'scan', key: options.prefix });
    if (this.failScan) throw new Error('scan failed');
    const { prefix, limit = 100 } = options;
    const matching: StorageEntry[] = [];
    for (const [k, v] of this.store) {
      if (k.startsWith(prefix) && matching.length < limit) {
        matching.push({ key: k, value: v });
      }
    }
    matching.sort((a, b) => a.key.localeCompare(b.key));
    return { entries: matching } satisfies StorageScanResult;
  }

  seedEvent(e: SessionHistoryEvent): void {
    const k = `history/event/${encodeURIComponent(e.runID)}/${e.sequence.toString().padStart(10, '0')}`;
    this.store.set(k, { ...e } satisfies Schema.Json);
  }

  seedLineage(l: SessionLineage): void {
    const k = `history/lineage/${encodeURIComponent(l.sessionID)}`;
    this.store.set(k, { ...l } satisfies Schema.Json);
  }
}

const ev = (runID: string, seq: number, parent: string | null = null): SessionHistoryEvent =>
  ({ eventID: `${runID}:run.started:${seq}`, runID, sessionID: 's1', sequence: seq, timestampMs: 1000 + seq, type: 'run.started', parentSessionID: parent } satisfies SessionHistoryEvent);

const lin = (sid: string, parent: string | null = null): SessionLineage =>
  ({ sessionID: sid, parentSessionID: parent, agent: null, sanitizedTitle: 't', kind: 'work', observedAtMs: 1000 } satisfies SessionLineage);

describe('HistoryPersistence (TDD)', () => {
  it('create hydrates materialized events from multiple runs + lineage, preserving exact IDs/sequences; next append uses max+1', async () => {
    const fake = new TestStorageFake();
    const e1 = ev('r1', 1);
    const e2 = ev('r2', 5, 'p1');
    fake.seedEvent(e1); fake.seedEvent(e2);
    const l1 = lin('s1', null); fake.seedLineage(l1);
    const codes: HistoryPersistenceDiagnosticCode[] = [];
    const p = await HistoryPersistence.create(fake, { onDiagnostic: c => codes.push(c) });
    assert.deepStrictEqual(p.getAllEvents(), [e1, e2]);
    assert.deepStrictEqual(p.listLineages(), [l1]);
    const res = p.append({ draft: { runID: 'r2', sessionID: 's1', timestampMs: 2000, type: 'run.started', parentSessionID: null } });
    assert.equal(res.type, 'appended');
    if (res.type === 'appended') assert.equal(res.event.sequence, 6);
    assert.equal(codes.length, 0);
    await p.shutdown();
  });

  it('maxEventsPerRun=1: appends persist set(seq1), set(seq2), remove(seq1) in that order; shutdown drains; restart contains only seq2; next is seq3', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake, { maxEventsPerRun: 1 });
    const d1 = { runID: 'r1', sessionID: 's1', timestampMs: 1, type: 'run.started', parentSessionID: null } as const;
    const d2 = { runID: 'r1', sessionID: 's1', timestampMs: 2, type: 'run.started', parentSessionID: null } as const;
    p.append({ draft: d1 }); p.append({ draft: d2 });
    await p.shutdown();
    const mutations = fake.ops.filter(o => o.op === 'set' || o.op === 'remove').map(o => `${o.op}:${o.key.split('/').pop()}`);
    assert.deepStrictEqual(mutations, ['set:0000000001', 'set:0000000002', 'remove:0000000001']);
    const p2 = await HistoryPersistence.create(fake, { maxEventsPerRun: 1 });
    assert.equal(p2.getAllEvents().length, 1);
    assert.equal(p2.getAllEvents()[0]?.sequence, 2);
    const res = p2.append({ draft: d2 });
    if (res.type === 'appended') assert.equal(res.event.sequence, 3);
    await p2.shutdown();
  });

  it('duplicate and collision enqueue zero writes', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake);
    const d = { runID: 'r1', sessionID: 's1', timestampMs: 1, type: 'prompt.observed', messageID: 'm1', delivery: 'd', partCount: 1, serializedBytes: 10 } as const;
    const d2 = { ...d, timestampMs: 2 } as const;
    const r1 = p.append({ draft: d, upstreamEventID: 'up1' });
    const r2 = p.append({ draft: d, upstreamEventID: 'up1' });
    const r3 = p.append({ draft: d2, upstreamEventID: 'up1' });
    assert.equal(r1.type, 'appended');
    assert.equal(r2.type, 'duplicate');
    assert.equal(r3.type, 'collision');
    await p.shutdown();
    const sets = fake.ops.filter(o => o.op === 'set').length;
    assert.equal(sets, 1);
  });

  it('restore rejected duplicate-eventID records and cap-evicted records are removed after shutdown', async () => {
    const fake = new TestStorageFake();
    const e1 = ev('r1', 1);
    const e2 = { ...e1, sequence: 2, eventID: e1.eventID, timestampMs: 9999 } as const satisfies SessionHistoryEvent;
    const e3 = ev('r1', 3);
    fake.seedEvent(e1); fake.seedEvent(e2); fake.seedEvent(e3);
    const p = await HistoryPersistence.create(fake, { maxEventsPerRun: 0 });
    await p.shutdown();
    const remKeys = fake.ops.filter(o => o.op === 'remove').map(o => o.key.split('/').pop());
    assert.deepStrictEqual(remKeys, ['0000000001', '0000000002', '0000000003']);
    assert.deepStrictEqual(p.getAllEvents(), []);
  });

  it('lineage record -> shutdown -> restart present; delete -> shutdown -> restart absent; deterministic listing', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake);
    const l1 = lin('s1'); const l2 = lin('s2');
    p.recordLineage(l1); p.recordLineage(l2);
    await p.shutdown();
    const p2 = await HistoryPersistence.create(fake);
    assert.deepStrictEqual(p2.listLineages().map(l => l.sessionID), ['s1', 's2']);
    p2.deleteLineage('s1');
    await p2.shutdown();
    const p3 = await HistoryPersistence.create(fake);
    assert.deepStrictEqual(p3.listLineages().map(l => l.sessionID), ['s2']);
  });

  it('first event set failure reports exactly EVENT_SAVE_FAILED, second event persists, both remain in memory, shutdown resolves (queue continues)', async () => {
    const fake = new TestStorageFake();
    const d1 = { runID: 'r1', sessionID: 's1', timestampMs: 1, type: 'run.started', parentSessionID: null } as const;
    const d2 = { runID: 'r1', sessionID: 's1', timestampMs: 2, type: 'run.started', parentSessionID: null } as const;
    const k1 = 'history/event/r1/0000000001';
    fake.failSet.add(k1);
    const codes: HistoryPersistenceDiagnosticCode[] = [];
    const p2 = await HistoryPersistence.create(fake, { onDiagnostic: c => codes.push(c) });
    p2.append({ draft: d1 });
    p2.append({ draft: d2 });
    await p2.shutdown();
    assert.deepStrictEqual(codes, ['EVENT_SAVE_FAILED']);
    assert.equal(p2.getAllEvents().length, 2);
    const p3 = await HistoryPersistence.create(fake);
    assert.deepStrictEqual(p3.getAllEvents().map(e => e.sequence), [2]);
    assert.equal(p3.getAllEvents()[0]?.eventID, 'r1:run.started:2');
    await p3.shutdown();
  });

  it('eviction remove failure reports exactly EVENT_REMOVE_FAILED without losing new saved event', async () => {
    const fake = new TestStorageFake();
    const _p = await HistoryPersistence.create(fake, { maxEventsPerRun: 1 });
    const d1 = { runID: 'r1', sessionID: 's1', timestampMs: 1, type: 'run.started', parentSessionID: null } as const;
    const d2 = { runID: 'r1', sessionID: 's1', timestampMs: 2, type: 'run.started', parentSessionID: null } as const;
    _p.append({ draft: d1 });
    await _p.shutdown();
    const k1 = 'history/event/r1/0000000001';
    fake.failRemove.add(k1);
    const codes: HistoryPersistenceDiagnosticCode[] = [];
    const p2 = await HistoryPersistence.create(fake, { maxEventsPerRun: 1, onDiagnostic: c => codes.push(c) });
    p2.append({ draft: d2 });
    await p2.shutdown();
    assert.deepStrictEqual(codes, ['EVENT_REMOVE_FAILED']);
    assert.equal(p2.getAllEvents().length, 1);
    assert.equal(p2.getAllEvents()[0]?.sequence, 2);
  });

  it('lineage save/remove failures map to exact codes', async () => {
    const fake = new TestStorageFake();
    const l1 = lin('s1');
    const k = 'history/lineage/s1';
    fake.failSet.add(k);
    const codes: HistoryPersistenceDiagnosticCode[] = [];
    const p2 = await HistoryPersistence.create(fake, { onDiagnostic: c => codes.push(c) });
    p2.recordLineage(l1);
    await p2.shutdown();
    assert.deepStrictEqual(codes, ['LINEAGE_SAVE_FAILED']);
    fake.failRemove.add(k);
    const codes2: HistoryPersistenceDiagnosticCode[] = [];
    const p3 = await HistoryPersistence.create(fake, { onDiagnostic: c => codes2.push(c) });
    p3.deleteLineage('s1');
    await p3.shutdown();
    assert.deepStrictEqual(codes2, ['LINEAGE_REMOVE_FAILED']);
  });

  it('diagnostic callback throwing never escapes create/append/record/delete/shutdown', async () => {
    const fake = new TestStorageFake();
    fake.failScan = true;
    let count = 0;
    const throwing = () => { count++; throw new Error('diag'); };
    const p = await HistoryPersistence.create(fake, { onDiagnostic: throwing });
    const d = { runID: 'r1', sessionID: 's1', timestampMs: 1, type: 'run.started', parentSessionID: null } as const;
    const k = 'history/event/r1/0000000001';
    fake.failSet.add(k);
    p.append({ draft: d });
    const lk = 'history/lineage/s1';
    fake.failSet.add(lk);
    p.recordLineage(lin('s1'));
    fake.failRemove.add(lk);
    p.deleteLineage('s1');
    await p.shutdown();
    assert.equal(count, 5);
  });
});

describe('HistoryPersistence.subscribeToAppends (TDD)', () => {
  const draft = (ts: number) =>
    ({ runID: 'r1', sessionID: 's1', timestampMs: ts, type: 'run.started', parentSessionID: null } as const);

  it('listener receives exactly the appended event (fields match) when result is appended', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake);
    const received: SessionHistoryEvent[] = [];
    p.subscribeToAppends(e => received.push(e));
    const res = p.append({ draft: draft(1) });
    assert.equal(res.type, 'appended');
    if (res.type !== 'appended') return;
    assert.equal(received.length, 1);
    assert.deepStrictEqual(received[0], res.event);
    const first = received[0];
    assert.ok(first);
    assert.equal(first.eventID, 'r1:run.started:1');
    assert.equal(first.sequence, 1);
    assert.equal(first.timestampMs, 1);
    assert.equal(first.type, 'run.started');
    await p.shutdown();
  });

  it('duplicate and collision appends do not emit', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake);
    const received: SessionHistoryEvent[] = [];
    p.subscribeToAppends(e => received.push(e));
    const d = { runID: 'r1', sessionID: 's1', timestampMs: 1, type: 'prompt.observed', messageID: 'm1', delivery: 'd', partCount: 1, serializedBytes: 10 } as const;
    const r1 = p.append({ draft: d, upstreamEventID: 'up1' });
    const r2 = p.append({ draft: d, upstreamEventID: 'up1' });
    const r3 = p.append({ draft: { ...d, timestampMs: 2 }, upstreamEventID: 'up1' });
    assert.equal(r1.type, 'appended');
    assert.equal(r2.type, 'duplicate');
    assert.equal(r3.type, 'collision');
    assert.equal(received.length, 1);
    await p.shutdown();
  });

  it('evicted events are not emitted — only the appended ones are', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake, { maxEventsPerRun: 1 });
    const received: SessionHistoryEvent[] = [];
    p.subscribeToAppends(e => received.push(e));
    const r1 = p.append({ draft: draft(1) });
    const r2 = p.append({ draft: draft(2) });
    assert.equal(r1.type, 'appended');
    assert.equal(r2.type, 'appended');
    if (r2.type !== 'appended') return;
    assert.equal(r2.evicted.length, 1);
    assert.deepStrictEqual(received.map(e => e.eventID), ['r1:run.started:1', 'r1:run.started:2']);
    await p.shutdown();
  });

  it('throwing listener does not break append nor starve the other listener; all 3 events persist; no diagnostics', async () => {
    const fake = new TestStorageFake();
    const codes: HistoryPersistenceDiagnosticCode[] = [];
    const p = await HistoryPersistence.create(fake, { onDiagnostic: c => codes.push(c) });
    const receivedA: SessionHistoryEvent[] = [];
    const receivedB: SessionHistoryEvent[] = [];
    let aCalls = 0;
    p.subscribeToAppends(e => {
      aCalls++;
      receivedA.push(e);
      if (aCalls === 2) throw new Error('listener A explodes');
    });
    p.subscribeToAppends(e => receivedB.push(e));
    const expectedIDs = ['r1:run.started:1', 'r1:run.started:2', 'r1:run.started:3'];
    for (const ts of [1, 2, 3]) {
      const res = p.append({ draft: draft(ts) });
      assert.equal(res.type, 'appended');
    }
    assert.deepStrictEqual(receivedA.map(e => e.eventID), expectedIDs);
    assert.deepStrictEqual(receivedB.map(e => e.eventID), expectedIDs);
    await p.shutdown();
    const eventSets = fake.ops.filter(o => o.op === 'set' && o.key.startsWith('history/event/')).length;
    assert.equal(eventSets, 3);
    assert.deepStrictEqual(codes, []);
  });

  it('unsubscribe stops delivery and calling it twice is safe', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake);
    const received: SessionHistoryEvent[] = [];
    const unsub = p.subscribeToAppends(e => received.push(e));
    p.append({ draft: draft(1) });
    unsub();
    unsub();
    p.append({ draft: draft(2) });
    assert.deepStrictEqual(received.map(e => e.eventID), ['r1:run.started:1']);
    await p.shutdown();
  });

  it('after shutdown drains, listeners are cleared — later appends do not reach them', async () => {
    const fake = new TestStorageFake();
    const p = await HistoryPersistence.create(fake);
    const received: SessionHistoryEvent[] = [];
    p.subscribeToAppends(e => received.push(e));
    p.append({ draft: draft(1) });
    await p.shutdown();
    assert.equal(p['appendListeners'].size, 0);
    const res = p.append({ draft: draft(2) });
    assert.equal(res.type, 'appended');
    assert.deepStrictEqual(received.map(e => e.eventID), ['r1:run.started:1']);
    await p.shutdown();
  });
});
