import assert from 'node:assert/strict';
import { describe, it, beforeEach } from 'node:test';
import type { SessionHistoryEventDraft, SessionLineage } from '../src/history-domain';
import { HistoryObserver } from '../src/history-observer';



type SessionPromptShape = { readonly sessionID: string; readonly messageID: string; readonly prompt: { readonly text: string; readonly files?: readonly unknown[]; readonly agents?: readonly unknown[]; readonly skills?: readonly unknown[] }; readonly delivery: string; readonly metadata?: Record<string, unknown> };
type RunStartedShape = { readonly sessionID: string; readonly parentID?: string | null; readonly runID: string };
type RunEndedShape = { readonly sessionID: string; readonly runID: string; readonly status: 'succeeded' | 'failed' | 'interrupted'; readonly parentSessionID?: string | null };
type SkillLoadedShape = { readonly runID: string; readonly sessionID: string; readonly skillID: string; readonly skillName: string };

class TestClock {
  private t = 1000;
  now() { return this.t++; }
}

class FakePersistence {
  drafts: Array<{ draft: SessionHistoryEventDraft; upstreamEventID?: string }> = [];
  lineages: SessionLineage[] = [];
  append(input: { readonly draft: SessionHistoryEventDraft; readonly upstreamEventID?: string }) {
    this.drafts.push(input);
    return { type: 'appended' as const, event: { ...input.draft, eventID: 'e', sequence: 1 }, evicted: [] as const };
  }
  recordLineage(l: SessionLineage) { this.lineages.push(l); }
  deleteLineage(sessionID: string) { this.deletedSessionIDs.push(sessionID); }
  deletedSessionIDs: string[] = [];
  finishRun(_runID: string) { this.finishedRuns.push(_runID); }
  finishedRuns: string[] = [];
  static async create() { return new FakePersistence(); }
}

describe('HistoryObserver normalization seam (Module 5)', () => {
  let clock: TestClock;
  let pers: FakePersistence;
  let diags: string[];
  let obs: HistoryObserver;

  beforeEach(async () => {
    clock = new TestClock();
    pers = new FakePersistence();
    diags = [];
    obs = new HistoryObserver(pers, clock, (c) => diags.push(c));
    pers.drafts = [];
    pers.lineages = [];
    pers.finishedRuns = [];
    pers.deletedSessionIDs = [];
  });

  it('maps session.prompt -> prompt.observed draft with upstream messageID, no prompt body copied', () => {
    const input = { sessionID: 's1', messageID: 'm1', prompt: { text: 'hello', files: [{}], agents: [], skills: [{}] }, delivery: 'async' } satisfies SessionPromptShape;
    obs.observeSessionPrompt(input, 'r1');
    assert.equal(pers.drafts.length, 1);
    const d0 = pers.drafts[0];
    if (!d0) throw new Error('expected d0');
    const d = d0.draft;
    assert.equal(d.type, 'prompt.observed');
    assert.equal(d.runID, 'r1');
    assert.equal(d.sessionID, 's1');
    assert.equal(d.messageID, 'm1');
    assert.equal(d.delivery, 'async');
    assert.equal(d.partCount, 3);
    assert.ok(d.serializedBytes > 0);
    const up = pers.drafts[0];
    if (!up) throw new Error('expected up');
    assert.equal(up.upstreamEventID, 'm1');
    assert.equal(JSON.stringify(d).includes('hello'), false);
  });

  it('prompt metrics use actual UTF-8 bytes of prompt JSON (multibyte fixture) and never persist body', () => {
    const input = { sessionID: 's1', messageID: 'm1', prompt: { text: 'café' }, delivery: 'sync' } satisfies SessionPromptShape;
    obs.observeSessionPrompt(input, 'r1');
    const d = pers.drafts[pers.drafts.length - 1];
    assert.ok(d);
    if (d.draft.type === 'prompt.observed') {
      assert.equal(d.draft.serializedBytes, 16);
      assert.equal(d.draft.partCount, 1);
      assert.equal(JSON.stringify(d.draft).includes('café'), false);
    }
  });

  it('maps tool execute.before/after with duration calc and separate phase IDs via callID', () => {
    const before = { tool: 'fs', sessionID: 's1', id: 'call1', input: { path: 'SECRET_INPUT' } } satisfies ToolBeforeShape;
    const after = { tool: 'fs', sessionID: 's1', id: 'call1', status: 'completed', result: { ok: true } } satisfies ToolAfterShape;
    obs.observeToolBefore(before, 'r1');
    obs.observeToolAfter(after, 'r1');
    assert.equal(pers.drafts.length, 2);
    const d0 = pers.drafts[0];
    assert.ok(d0);
    const start = d0.draft;
    const d1 = pers.drafts[1];
    assert.ok(d1);
    const fin = d1.draft;
    assert.equal(start.type, 'tool.started');
    assert.equal(start.callID, 'call1');
    assert.equal(fin.type, 'tool.finished');
    assert.equal(fin.callID, 'call1');
    assert.equal(fin.orphan, false);
    if (fin.type === 'tool.finished') {
      assert.ok(fin.durationMs != null);
    }
    assert.equal(JSON.stringify([start, fin]).includes('SECRET_INPUT'), false);
  });

  it('tool.finished without started is orphan with duration null', () => {
    const after = { tool: 'x', sessionID: 's1', id: 'c2', status: 'error', error: { message: 'boom' } } satisfies ToolAfterShape;
    obs.observeToolAfter(after, 'r1');
    const d0 = pers.drafts[0];
    assert.ok(d0);
    const fin = d0.draft;
    assert.equal(fin.type, 'tool.finished');
    assert.equal(fin.orphan, true);
    if (fin.type === 'tool.finished') {
      assert.equal(fin.durationMs, null);
    }
  });

  it('agent.observed on first, agent.changed on transition, supports null-first observation', () => {
    obs.observeAgentTransition('s1', null, 'r1');
    obs.observeAgentTransition('s1', 'agentA', 'r1');
    const d0 = pers.drafts[0];
    assert.ok(d0);
    const d1 = pers.drafts[1];
    assert.ok(d1);
    const types = [d0.draft.type, d1.draft.type];
    assert.deepStrictEqual(types, ['agent.observed', 'agent.changed']);
  });

  it('records sanitized SessionLineage with correct kind classification (system/work/unknown)', () => {
    obs.recordSessionLineage({ sessionID: 's1', parentID: 's0', agent: 'title', title: 'sk-abc123def456 secret' });
    obs.recordSessionLineage({ sessionID: 's2', parentID: null, agent: 'workAgent', title: 'normal' });
    obs.recordSessionLineage({ sessionID: 's3', parentID: null, agent: null, title: '' });
    const l0 = pers.lineages[0];
    assert.ok(l0);
    const l1 = pers.lineages[1];
    assert.ok(l1);
    const l2 = pers.lineages[2];
    assert.ok(l2);
    assert.equal(l0.kind, 'system');
    assert.equal(l1.kind, 'work');
    assert.equal(l2.kind, 'unknown');
    assert.equal(JSON.stringify(l0).includes('sk-'), false);
  });

  it('maps run.started with parentSessionID and upstream ID', () => {
    const input = { sessionID: 's1', parentID: 's0', runID: 'r1' } satisfies RunStartedShape;
    obs.observeRunStarted(input, 'up1');
    const d = pers.drafts[0];
    assert.ok(d);
    if (d.draft.type === 'run.started') {
      assert.equal(d.draft.parentSessionID, 's0');
    }
    assert.equal(d.upstreamEventID, 'up1');
  });

  it('maps run.ended with all 3 statuses using one captured clock per observation', () => {
    const s1 = { sessionID: 's1', runID: 'r1', status: 'succeeded', parentSessionID: 'p1' } satisfies RunEndedShape;
    const s2 = { sessionID: 's1', runID: 'r1', status: 'failed', parentSessionID: null } satisfies RunEndedShape;
    const s3 = { sessionID: 's1', runID: 'r1', status: 'interrupted' } satisfies RunEndedShape;
    obs.observeRunEnded(s1, 'up1');
    obs.observeRunEnded(s2, 'up2');
    obs.observeRunEnded(s3, 'up3');
    const ended = pers.drafts.filter(x => x.draft.type === 'run.ended');
    assert.equal(ended.length, 3);
    const e0 = ended[0];
    assert.ok(e0);
    if (e0.draft.type === 'run.ended') {
      assert.equal(e0.draft.status, 'succeeded');
      assert.equal(e0.draft.parentSessionID, 'p1');
    }
    assert.equal(e0.upstreamEventID, 'up1');
    const e1 = ended[1];
    assert.ok(e1);
    if (e1.draft.type === 'run.ended') {
      assert.equal(e1.draft.status, 'failed');
      assert.equal(e1.draft.parentSessionID, null);
    }
    assert.equal(e1.upstreamEventID, 'up2');
    const e2 = ended[2];
    assert.ok(e2);
    if (e2.draft.type === 'run.ended') {
      assert.equal(e2.draft.status, 'interrupted');
      assert.equal(e2.draft.parentSessionID, null);
    }
    assert.equal(e2.upstreamEventID, 'up3');
  });

  it('maps skill.loaded with upstream ID, no raw data copied', () => {
    const input = { runID: 'r1', sessionID: 's1', skillID: 'sk1', skillName: 'git' } satisfies SkillLoadedShape;
    obs.observeSkillLoaded(input, 'ev1');
    const d = pers.drafts[0];
    assert.ok(d);
    if (d.draft.type === 'skill.loaded') {
      assert.equal(d.draft.runID, 'r1');
      assert.equal(d.draft.skillID, 'sk1');
    }
    assert.equal(d.upstreamEventID, 'ev1');
  });

  it('supports lineage delete via persistence port', () => {
    obs.recordSessionLineage({ sessionID: 's1', parentID: null, agent: null, title: '' });
    obs.deleteLineage('s1');
    assert.deepStrictEqual(pers.deletedSessionIDs, ['s1']);
  });

  it('accepts real context.snapshot reference input without inventing sequence 0', () => {
    const ref = { runID: 'r1', sessionID: 's1', sequence: 42 };
    obs.observeContextSnapshot({ snapshotRef: ref });
    const d = pers.drafts[0];
    assert.ok(d);
    if (d.draft.type === 'context.snapshot') {
      assert.equal(d.draft.snapshotRef.sequence, 42);
    }
  });

  it('fail-open on bad input: reports diagnostic, no throw, no sensitive leak', () => {
    const badPers = new FakePersistence();
    badPers.append = () => { throw new Error('boom'); };
    const badObs = new HistoryObserver(badPers, clock, (c) => diags.push(c));
    assert.doesNotThrow(() => badObs.observeSessionPrompt({ sessionID: 's', messageID: 'm', prompt: { text: '' }, delivery: 'sync' } satisfies SessionPromptShape, 'r1'));
    assert.ok(diags.length > 0);
    const firstDiag = diags[0];
    assert.ok(firstDiag);
    assert.ok(firstDiag.includes('NORMALIZATION_FAILED'));
  });

  it('uses injected clock for all timestamps, deterministic', () => {
    const input = { sessionID: 's', messageID: 'm', prompt: { text: '' }, delivery: 'sync' } satisfies SessionPromptShape;
    obs.observeSessionPrompt(input, 'r1');
    const first = pers.drafts[0];
    assert.ok(first);
    assert.equal(first.draft.timestampMs, 1000);
  });

  it('observeRunEnded calls persistence.finishRun with the runID (narrow port includes finishRun)', () => {
    const input = { sessionID: 's1', runID: 'r1', status: 'succeeded' } satisfies RunEndedShape;
    obs.observeRunEnded(input);
    assert.equal(pers.finishedRuns.length, 1);
    assert.equal(pers.finishedRuns[0], 'r1');
  });

  it('maps error.sanitized with closed code union to fixed message; raw details structurally impossible', () => {
    const input = { sessionID: 's1', code: 'NORMALIZATION_FAILED' } satisfies { readonly sessionID: string; readonly code: 'NORMALIZATION_FAILED' | 'SERIALIZATION_FAILED' };
    obs.observeErrorSanitized(input, 'r1');
    const d = pers.drafts[pers.drafts.length - 1];
    assert.ok(d);
    if (d.draft.type === 'error.sanitized') {
      assert.equal(d.draft.message, 'normalization failed');
      assert.equal(JSON.stringify(d.draft).includes('stack'), false);
      assert.equal(JSON.stringify(d.draft).includes('/secret'), false);
    }
  });
});

type ToolBeforeShape = { readonly sessionID: string; readonly id: string; readonly tool?: string; readonly input?: unknown };
type ToolAfterShape = { readonly sessionID: string; readonly id: string; readonly tool?: string; readonly status?: string; readonly result?: unknown; readonly error?: { readonly message?: string } };
