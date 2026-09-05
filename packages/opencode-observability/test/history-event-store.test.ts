import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryHistoryEventStore } from '../src/history-event-store';
import type { SessionHistoryEventDraft } from '../src/history-domain';

type ToolStartedDraft = Extract<SessionHistoryEventDraft, { readonly type: 'tool.started' }>;
type ToolFinishedDraft = Extract<SessionHistoryEventDraft, { readonly type: 'tool.finished' }>;
type RetryDraft = Extract<SessionHistoryEventDraft, { readonly type: 'retry' }>;
type RunStartedDraft = Extract<SessionHistoryEventDraft, { readonly type: 'run.started' }>;

const base = { runID: 'r1', sessionID: 's1', timestampMs: 1000 } as const;

describe('HistoryEventStore', () => {
  it('per-run sequences start at 1 and are monotonic', () => {
    const store = new InMemoryHistoryEventStore();
    const d1 = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const d2 = { ...base, type: 'retry', attempt: 2 } satisfies RetryDraft;
    const r1 = store.append({ draft: d1 });
    const r2 = store.append({ draft: d2 });
    assert.equal(r1.type, 'appended');
    assert.equal(r2.type, 'appended');
    assert.equal(r1.event.sequence, 1);
    assert.equal(r2.event.sequence, 2);
    assert.equal(store.getRunEvents('r1').length, 2);

    const base2 = { runID: 'r2', sessionID: 's2', timestampMs: 2000 } as const;
    const d3 = { ...base2, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const r3 = store.append({ draft: d3 });
    assert.equal(r3.type, 'appended');
    if (r3.type === 'appended') assert.equal(r3.event.sequence, 1);
    assert.equal(store.getRunEvents('r2').length, 1);
  });

  it('computes exact four identity paths', () => {
    const store = new InMemoryHistoryEventStore();
    const started = { ...base, type: 'tool.started', callID: 'c1', name: null } satisfies ToolStartedDraft;
    const finished = { ...base, type: 'tool.finished', callID: 'c1', status: 'ok', durationMs: null, orphan: false } satisfies ToolFinishedDraft;
    const upstream = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const other = { ...base, type: 'run.started', parentSessionID: null } satisfies RunStartedDraft;

    const r1 = store.append({ draft: started });
    const r2 = store.append({ draft: finished });
    const r3 = store.append({ draft: upstream, upstreamEventID: 'u1' });
    const r4 = store.append({ draft: other });

    assert.equal(r1.type, 'appended');
    assert.equal(r2.type, 'appended');
    assert.equal(r3.type, 'appended');
    assert.equal(r4.type, 'appended');
    if (r1.type === 'appended') assert.equal(r1.event.eventID, 'r1:tool:c1:started');
    if (r2.type === 'appended') assert.equal(r2.event.eventID, 'r1:tool:c1:finished');
    if (r3.type === 'appended') assert.equal(r3.event.eventID, 'retry:u1');
    if (r4.type === 'appended') assert.equal(r4.event.eventID, 'r1:run.started:4');
  });

  it('started and finished have distinct IDs even with same callID', () => {
    const store = new InMemoryHistoryEventStore();
    const started = { ...base, type: 'tool.started', callID: 'c1', name: null } satisfies ToolStartedDraft;
    const finished = { ...base, type: 'tool.finished', callID: 'c1', status: 'ok', durationMs: null, orphan: false } satisfies ToolFinishedDraft;
    store.append({ draft: started });
    store.append({ draft: finished });
    const events = store.getRunEvents('r1');
    const ev0 = events.find(e => e.eventID.includes('started'));
    const ev1 = events.find(e => e.eventID.includes('finished'));
    assert.ok(ev0);
    assert.ok(ev1);
    assert.equal(ev0.eventID.includes('started'), true);
    assert.equal(ev1.eventID.includes('finished'), true);
    assert.notEqual(ev0.eventID, ev1.eventID);
  });

  it('identical draft on same identity ID returns duplicate no-op', () => {
    const store = new InMemoryHistoryEventStore();
    const d = { ...base, type: 'tool.started', callID: 'c1', name: null } satisfies ToolStartedDraft;
    const r1 = store.append({ draft: d });
    const r2 = store.append({ draft: d });
    assert.equal(r1.type, 'appended');
    assert.equal(r2.type, 'duplicate');
    assert.equal(store.getRunEvents('r1').length, 1);
    assert.equal(store.getAllEvents().length, 1);
  });

  it('divergent draft on same identity ID returns collision, no sequence consumed', () => {
    const store = new InMemoryHistoryEventStore();
    const d1 = { ...base, type: 'tool.started', callID: 'c1', name: null } satisfies ToolStartedDraft;
    const d2 = { ...base, type: 'tool.started', callID: 'c1', name: 'fs' } satisfies ToolStartedDraft;
    const fallback = { ...base, type: 'retry', attempt: 9 } satisfies RetryDraft;
    const r1 = store.append({ draft: d1 });
    const r2 = store.append({ draft: d2 });
    const r3 = store.append({ draft: fallback });
    assert.equal(r1.type, 'appended');
    assert.deepStrictEqual(r2, { type: 'collision', eventID: 'r1:tool:c1:started' });
    assert.equal(r3.type, 'appended');
    if (r3.type === 'appended') {
      assert.equal(r3.event.sequence, 2);
      assert.equal(r3.event.eventID, 'r1:retry:2');
    }
    assert.equal(store.getRunEvents('r1').length, 2);
    const ev = store.getRunEvents('r1').find(e => e.eventID.includes('started'));
    assert.equal(ev?.type, 'tool.started');
    if (ev && ev.type === 'tool.started') assert.equal(ev.name, null);
  });

  it('Promise.all appends produce unique contiguous sequences', async () => {
    const store = new InMemoryHistoryEventStore();
    const drafts = Array.from({ length: 5 }, (_, i) => ({ ...base, type: 'retry', attempt: i } satisfies RetryDraft));
    const results = await Promise.all(drafts.map(d => Promise.resolve(store.append({ draft: d }))));
    const seqs = results.map(r => r.type === 'appended' ? r.event.sequence : -1);
    assert.deepStrictEqual(seqs, [1,2,3,4,5]);
    assert.equal(store.getRunEvents('r1').length, 5);
  });

  it('injected small cap evicts exactly during append', () => {
    const store = new InMemoryHistoryEventStore({ maxEventsPerRun: 2 });
    const d1 = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const d2 = { ...base, type: 'retry', attempt: 2 } satisfies RetryDraft;
    const d3 = { ...base, type: 'retry', attempt: 3 } satisfies RetryDraft;
    store.append({ draft: d1 });
    store.append({ draft: d2 });
    store.append({ draft: d3 });
    const run = store.getRunEvents('r1');
    assert.equal(run.length, 2);
    const first = run.find(e => e.sequence === 2);
    const second = run.find(e => e.sequence === 3);
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.sequence, 2);
    assert.equal(second.sequence, 3);
  });

  it('default 5000 cap keeps exactly 5000 after 5001 lightweight appends', () => {
    const store = new InMemoryHistoryEventStore();
    for (let i = 1; i <= 5001; i++) {
      const d = { ...base, type: 'retry', attempt: i } satisfies RetryDraft;
      store.append({ draft: d });
    }
    const runEvents = store.getRunEvents('r1');
    assert.equal(runEvents.length, 5000);
    const first = runEvents.find(e => e.sequence === 2);
    const last = runEvents.find(e => e.sequence === 5001);
    assert.ok(first);
    assert.ok(last);
    assert.equal(first.sequence, 2);
    assert.equal(last.sequence, 5001);
  });

  it('finishRun is idempotent and reapplies cap', () => {
    const store = new InMemoryHistoryEventStore({ maxEventsPerRun: 1 });
    const d1 = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const d2 = { ...base, type: 'retry', attempt: 2 } satisfies RetryDraft;
    store.append({ draft: d1 });
    store.append({ draft: d2 });
    store.finishRun('r1');
    store.finishRun('r1');
    assert.equal(store.getRunEvents('r1').length, 1);
  });

  it('global getAllEvents sorts by (timestampMs, sessionID, runID, sequence)', () => {
    const store = new InMemoryHistoryEventStore();
    const baseTs = { runID: 'r1', sessionID: 's1', timestampMs: 100, type: 'retry', attempt: 0 } as const;
    const dA = { ...baseTs, attempt: 1 } satisfies RetryDraft; // r1 s1 100 seq1
    const dB = { ...baseTs, runID: 'r1', attempt: 2 } satisfies RetryDraft; // r1 s1 100 seq2 (seq tiebreaker)
    const dC = { ...baseTs, runID: 'r2', sessionID: 's1', attempt: 3 } satisfies RetryDraft; // r2 s1 100
    const dD = { ...baseTs, sessionID: 's2', attempt: 4 } satisfies RetryDraft; // r1 s2 100
    const dE = { ...baseTs, timestampMs: 200, attempt: 5 } satisfies RetryDraft; // later ts
    store.append({ draft: dA });
    store.append({ draft: dB });
    store.append({ draft: dC });
    store.append({ draft: dD });
    store.append({ draft: dE });
    const all = store.getAllEvents();
    assert.equal(all.length, 5);
    const order = all.map(e => ({ ts: e.timestampMs, sid: e.sessionID, rid: e.runID, seq: e.sequence }));
    assert.deepStrictEqual(order, [
      { ts: 100, sid: 's1', rid: 'r1', seq: 1 },
      { ts: 100, sid: 's1', rid: 'r1', seq: 2 },
      { ts: 100, sid: 's1', rid: 'r2', seq: 1 },
      { ts: 100, sid: 's2', rid: 'r1', seq: 3 },
      { ts: 200, sid: 's1', rid: 'r1', seq: 4 }
    ]);
  });

  it('returned arrays are fresh copies; mutation does not affect store', () => {
    const store = new InMemoryHistoryEventStore();
    const d = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    store.append({ draft: d });
    const runArr = store.getRunEvents('r1');
    const allArr = store.getAllEvents();
    const mutatedRun = [...runArr, runArr[0]];
    const mutatedAll = allArr.slice(0, -1);
    assert.equal(mutatedRun.length, 2);
    assert.equal(mutatedAll.length, 0);
    assert.equal(store.getRunEvents('r1').length, 1);
    assert.equal(store.getAllEvents().length, 1);
  });

  it('restore hydrates seq>1 exactly and next append uses max accepted seq + 1', () => {
    const ev3 = { runID: 'r1', sessionID: 's1', timestampMs: 1000, type: 'retry', attempt: 3, eventID: 'r1:retry:3', sequence: 3 } as const;
    const ev4 = { runID: 'r1', sessionID: 's1', timestampMs: 1000, type: 'retry', attempt: 4, eventID: 'r1:retry:4', sequence: 4 } as const;

    const fresh = new InMemoryHistoryEventStore();
    const outcome = fresh.restore([ev4, ev3]); // unsorted input order
    assert.equal(outcome.restored.length, 2);
    assert.equal(outcome.rejected.length, 0);
    assert.equal(outcome.evicted.length, 0);
    const restored = fresh.getRunEvents('r1');
    assert.equal(restored.length, 2);
    const r0 = restored[0];
    const r1 = restored[1];
    assert.ok(r0 && r1);
    assert.equal(r0.eventID, 'r1:retry:3');
    assert.equal(r0.sequence, 3);
    assert.equal(r1.eventID, 'r1:retry:4');
    assert.equal(r1.sequence, 4);

    const d5 = { runID: 'r1', sessionID: 's1', timestampMs: 1000, type: 'retry', attempt: 5 } satisfies RetryDraft;
    const r5 = fresh.append({ draft: d5 });
    assert.equal(r5.type, 'appended');
    if (r5.type === 'appended') {
      assert.equal(r5.event.sequence, 5);
      assert.equal(r5.event.eventID, 'r1:retry:5');
    }
  });

  it('restore preserves identity duplicate and collision semantics for subsequent appends', () => {
    const store = new InMemoryHistoryEventStore();
    const d1 = { ...base, type: 'tool.started', callID: 'c1', name: null } satisfies ToolStartedDraft;
    const r1 = store.append({ draft: d1 });
    assert.equal(r1.type, 'appended');
    if (r1.type !== 'appended') throw new Error('setup');
    const materialized = store.getRunEvents('r1');

    const fresh = new InMemoryHistoryEventStore();
    fresh.restore(materialized);

    const rDup = fresh.append({ draft: d1 });
    assert.equal(rDup.type, 'duplicate');

    const d2 = { ...base, type: 'tool.started', callID: 'c1', name: 'fs' } satisfies ToolStartedDraft;
    const rCol = fresh.append({ draft: d2 });
    assert.deepStrictEqual(rCol, { type: 'collision', eventID: 'r1:tool:c1:started' });
  });

  it('restore rejects all divergent duplicate eventID records independent of input order', () => {
    const d1 = { ...base, type: 'tool.started', callID: 'c1', name: null } satisfies ToolStartedDraft;
    const d2 = { ...base, type: 'tool.started', callID: 'c1', name: 'fs' } satisfies ToolStartedDraft;
    const ev1 = { ...d1, eventID: 'r1:tool:c1:started', sequence: 1 } as const;
    const ev2 = { ...d2, eventID: 'r1:tool:c1:started', sequence: 1 } as const;

    const fresh1 = new InMemoryHistoryEventStore();
    const out1 = fresh1.restore([ev1, ev2]);
    assert.equal(out1.restored.length, 0);
    assert.equal(out1.rejected.length, 2);

    const fresh2 = new InMemoryHistoryEventStore();
    const out2 = fresh2.restore([ev2, ev1]);
    assert.equal(out2.restored.length, 0);
    assert.equal(out2.rejected.length, 2);
  });

  it('restore rejects all records sharing duplicate run sequence slot independent of input order', () => {
    const d1 = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const d2 = { ...base, type: 'retry', attempt: 99 } satisfies RetryDraft;
    const ev1 = { ...d1, eventID: 'r1:retry:5', sequence: 5 } as const;
    const ev2 = { ...d2, eventID: 'r1:retry:5x', sequence: 5 } as const;

    const fresh1 = new InMemoryHistoryEventStore();
    const out1 = fresh1.restore([ev1, ev2]);
    assert.equal(out1.restored.length, 0);
    assert.equal(out1.rejected.length, 2);

    const fresh2 = new InMemoryHistoryEventStore();
    const out2 = fresh2.restore([ev2, ev1]);
    assert.equal(out2.restored.length, 0);
    assert.equal(out2.rejected.length, 2);
  });

  it('restore cap keeps highest sequences and reports evicted', () => {
    const store = new InMemoryHistoryEventStore({ maxEventsPerRun: 2 });
    const d1 = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const d2 = { ...base, type: 'retry', attempt: 2 } satisfies RetryDraft;
    const d3 = { ...base, type: 'retry', attempt: 3 } satisfies RetryDraft;
    const ev1 = { ...d1, eventID: 'r1:retry:1', sequence: 1 } as const;
    const ev2 = { ...d2, eventID: 'r1:retry:2', sequence: 2 } as const;
    const ev3 = { ...d3, eventID: 'r1:retry:3', sequence: 3 } as const;

    const outcome = store.restore([ev1, ev2, ev3]);
    assert.equal(outcome.restored.length, 2);
    assert.equal(outcome.evicted.length, 1);
    assert.equal(outcome.rejected.length, 0);
    const keptSeqs = outcome.restored.map(e => e.sequence).sort((a,b)=>a-b);
    assert.deepStrictEqual(keptSeqs, [2, 3]);
    const e0 = outcome.evicted[0];
    assert.ok(e0);
    assert.equal(e0.sequence, 1);
  });

  it('append above cap returns exactly the shifted evicted events', () => {
    const store = new InMemoryHistoryEventStore({ maxEventsPerRun: 2 });
    const d1 = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const d2 = { ...base, type: 'retry', attempt: 2 } satisfies RetryDraft;
    const d3 = { ...base, type: 'retry', attempt: 3 } satisfies RetryDraft;
    const r1 = store.append({ draft: d1 });
    const r2 = store.append({ draft: d2 });
    const r3 = store.append({ draft: d3 });
    assert.equal(r1.type, 'appended');
    assert.equal(r2.type, 'appended');
    assert.equal(r3.type, 'appended');
    if (r3.type === 'appended') {
      assert.equal(r3.evicted.length, 1);
      const ev0 = r3.evicted[0];
      assert.ok(ev0);
      assert.equal(ev0.sequence, 1);
      assert.equal(r3.event.sequence, 3);
    }
    assert.equal(store.getRunEvents('r1').length, 2);
  });

  it('restore deduplicates identical persisted copies (distinct object instances) and sets next seq correctly', () => {
    const d = { ...base, type: 'retry', attempt: 7 } satisfies RetryDraft;
    const evA = { ...d, eventID: 'r1:retry:7', sequence: 7 } as const;
    const evB = { ...d, eventID: 'r1:retry:7', sequence: 7 } as const;

    const fresh = new InMemoryHistoryEventStore();
    const outcome = fresh.restore([evA, evB]);
    assert.equal(outcome.restored.length, 1);
    assert.equal(outcome.rejected.length, 0);
    assert.equal(outcome.evicted.length, 0);
    assert.equal(fresh.getRunEvents('r1').length, 1);

    const dNext = { ...base, type: 'retry', attempt: 8 } satisfies RetryDraft;
    const rNext = fresh.append({ draft: dNext });
    assert.equal(rNext.type, 'appended');
    if (rNext.type === 'appended') {
      assert.equal(rNext.event.sequence, 8);
    }
  });

  it('restore after append sharing runID+sequence rejects full batch with no mutation and next append gets seq 2', () => {
    const store = new InMemoryHistoryEventStore();
    const d1 = { ...base, type: 'retry', attempt: 1 } satisfies RetryDraft;
    const r1 = store.append({ draft: d1 });
    assert.equal(r1.type, 'appended');
    if (r1.type !== 'appended') throw new Error('setup');
    assert.equal(r1.event.sequence, 1);

    const conflicting = { runID: 'r1', sessionID: 's1', timestampMs: 1000, type: 'retry', attempt: 99, eventID: 'r1:retry:1x', sequence: 1 } as const;
    const outcome = store.restore([conflicting]);
    assert.equal(outcome.restored.length, 0);
    assert.equal(outcome.rejected.length, 1);
    assert.equal(outcome.evicted.length, 0);
    assert.equal(store.getRunEvents('r1').length, 1);
    const orig0 = store.getRunEvents('r1')[0];
    assert.ok(orig0);
    assert.equal(orig0.sequence, 1);

    const d2 = { ...base, type: 'retry', attempt: 2 } satisfies RetryDraft;
    const r2 = store.append({ draft: d2 });
    assert.equal(r2.type, 'appended');
    if (r2.type === 'appended') {
      assert.equal(r2.event.sequence, 2);
    }
  });

  it('restore after successful restore rejects second batch and preserves first state', () => {
    const ev = { runID: 'r9', sessionID: 's9', timestampMs: 1, type: 'retry', attempt: 1, eventID: 'r9:retry:1', sequence: 1 } as const;
    const store = new InMemoryHistoryEventStore();
    const first = store.restore([ev]);
    assert.equal(first.restored.length, 1);

    const second = { runID: 'r9', sessionID: 's9', timestampMs: 2, type: 'retry', attempt: 2, eventID: 'r9:retry:2', sequence: 2 } as const;
    const outcome = store.restore([second]);
    assert.equal(outcome.restored.length, 0);
    assert.equal(outcome.rejected.length, 1);
    assert.equal(store.getRunEvents('r9').length, 1);
    const r90 = store.getRunEvents('r9')[0];
    assert.ok(r90);
    assert.equal(r90.sequence, 1);
  });

});
