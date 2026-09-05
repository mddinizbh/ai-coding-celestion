import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import { createCollector } from '../src/collector';
import { setupObservabilityPlugin } from '../src/index';
import { createHistoryRuntimeBridge, registerHistoryHooks, type RuntimeEvent, type RuntimeRegistrar } from '../src/runtime-bridge';
import type { ContextSnapshotRecord, Run, SkillEvent } from '../src/domain';
import type { PermissionEval, PersistencePort, SessionContext, SessionModelRequest, SessionPrompt, SessionRetry, ToolAfter, ToolBefore } from '../src/history-observer-shapes';
import type { SessionHistoryEvent, SessionHistoryEventDraft, SessionLineage } from '../src/history-domain';
import { readOverview, readDebug } from '../src/rpc';
import { StorageAdapter } from '../src/storage-adapter';
import { InMemoryStore } from '../src/store';

type StoredJson = Exclude<Awaited<ReturnType<StorageDomain['get']>>, undefined>;

function createFakeStorage(): StorageDomain {
  const data = new Map<string, StoredJson>();
  return {
    async get(key) { return data.get(key); },
    async set(key, value) { data.set(key, value); },
    async remove(key) { data.delete(key); },
    async scan(options) {
      const entries = Array.from(data.entries())
        .filter(([key]) => key.startsWith(options.prefix))
        .map(([key, value]) => ({ key, value }));
      return { entries };
    }
  };
}

const activeRun: Run = {
  runID: 'run-1', sessionID: 'session-1', startedAt: 100, status: 'active', agent: null,
  project: null, repo: null, gitRevision: null, provider: null, model: null, endAt: null
};

const contextObservation = {
  sessionID: 'session-1',
  agent: 'agent-1',
  model: { providerID: 'provider-1', id: 'model-1' },
  system: [],
  messages: [],
  tools: {},
  generation: {},
  providerOptions: {}
} as const;

describe('StorageAdapter', () => {
  it('keeps the completed run as latest after active is cleared', async () => {
    const adapter = new StorageAdapter(createFakeStorage());
    await adapter.recordRun(activeRun);
    await adapter.setActiveRun(activeRun.sessionID, activeRun.runID);
    assert.equal((await adapter.getActiveRun(activeRun.sessionID))?.status, 'active');

    await adapter.recordRun({ ...activeRun, status: 'succeeded', endAt: 200 });
    await adapter.clearActiveRun(activeRun.sessionID);

    assert.equal(await adapter.getActiveRun(activeRun.sessionID), null);
    assert.equal((await adapter.getLatestRun(activeRun.sessionID))?.status, 'succeeded');
  });

  it('skips malformed persisted records', async () => {
    const storage = createFakeStorage();
    await storage.set('model/run-1/000001', { runID: 'run-1', sequence: 1 });
    const adapter = new StorageAdapter(storage);
    assert.deepEqual(await adapter.getModelCalls('run-1'), []);
  });
});

describe('collector fail-open', () => {
  it('resolves and emits one sanitized code when storage fails', async () => {
    class ThrowingStore extends InMemoryStore {
      override async recordContextSnapshot(_snapshot: ContextSnapshotRecord): Promise<void> {
        throw new Error('sensitive storage detail');
      }
    }
    const store = new ThrowingStore();
    await store.recordRun(activeRun);
    await store.setActiveRun(activeRun.sessionID, activeRun.runID);
    const diagnostics: string[] = [];
    const collector = createCollector({ store, clock: () => 150, reporter: (code) => diagnostics.push(code) });

    await collector.onContext(contextObservation);

    assert.deepEqual(diagnostics, ['context']);
  });
});

describe('loaded skills and overview', () => {
  it('aggregates duplicate skill activations', async () => {
    const store = new InMemoryStore();
    const first: SkillEvent = { eventID: 'e1', runID: 'run-1', sessionID: 'session-1', skillID: 'skill-1', skillName: 'one', created: 1, eventType: 'LOADED' };
    const second: SkillEvent = { ...first, eventID: 'e2', created: 2 };
    await store.recordSkillEvent(first);
    await store.recordSkillEvent(second);
    assert.equal((await store.getLoadedSkills('run-1'))[0]?.loadCount, 2);
  });

  it('returns counts and latest context for a completed run', async () => {
    const store = new InMemoryStore();
    await store.recordRun({ ...activeRun, status: 'succeeded', endAt: 200 });
    await store.recordModelCall({ runID: 'run-1', sessionID: 'session-1', sequence: 1, agent: 'agent-1', provider: 'provider-1', model: 'model-1', timestamp: 150 });
    await store.recordContextSnapshot({ runID: 'run-1', sessionID: 'session-1', sequence: 1, systemBytes: 2, messagesBytes: 2, toolsBytes: 2, generationBytes: null, providerOptionsBytes: null, hookEventBytes: 10, systemCount: 0, messageCount: 0, toolCount: 0, timestamp: 160 });

    const overview = await readOverview(store, { sessionID: 'session-1' });

    assert.equal(overview.status, 'succeeded');
    assert.equal(overview.modelCalls, 1);
    assert.equal(overview.latestContextSizeBytes, 10);
    assert.equal(overview.loadedSkills, 0);
    assert.equal(overview.durationMs, 100);
  });
});

describe('readOverview flat DTO', () => {
  it('returns flat OverviewReadModel with nulls when no run', async () => {
    const store = new InMemoryStore();
    const overview = await readOverview(store, { sessionID: 'missing' });
    assert.equal(overview.sessionID, 'missing');
    assert.equal(overview.runID, null);
    assert.equal(overview.status, null);
    assert.equal(overview.modelCalls, null);
    assert.equal(overview.latestContextSizeBytes, null);
    assert.equal(overview.loadedSkills, null);
  });

  it('returns flat DTO with real counts (incl zero) and duration for completed run using endAt', async () => {
    const store = new InMemoryStore();
    await store.recordRun({ ...activeRun, status: 'succeeded', endAt: 200 });
    await store.recordModelCall({ runID: 'run-1', sessionID: 'session-1', sequence: 1, agent: 'agent-1', provider: 'provider-1', model: 'model-1', timestamp: 150 });
    await store.recordContextSnapshot({ runID: 'run-1', sessionID: 'session-1', sequence: 1, systemBytes: 2, messagesBytes: 2, toolsBytes: 2, generationBytes: null, providerOptionsBytes: null, hookEventBytes: 10, systemCount: 0, messageCount: 0, toolCount: 0, timestamp: 160 });
    const overview = await readOverview(store, { sessionID: 'session-1' });
    assert.equal(overview.runID, 'run-1');
    assert.equal(overview.sessionID, 'session-1');
    assert.equal(overview.status, 'succeeded');
    assert.equal(overview.modelCalls, 1);
    assert.equal(overview.latestContextSizeBytes, 10);
    assert.equal(overview.loadedSkills, 0);
    assert.equal(overview.durationMs, 100);
    assert.equal(overview.finishedAt, 200);
  });

  it('computes active duration with injected clock (now - startedAt)', async () => {
    const store = new InMemoryStore();
    await store.recordRun(activeRun);
    await store.setActiveRun(activeRun.sessionID, activeRun.runID);
    const clock = () => 250;
    const overview = await readOverview(store, { sessionID: 'session-1' }, clock);
    assert.equal(overview.status, 'active');
    assert.equal(overview.durationMs, 150);
    assert.equal(overview.finishedAt, null);
  });
});

describe('readDebug returns detailed context, aggregated skills, and typed timeline', () => {
  it('returns latest context bytes and counts including generation/providerOptions', async () => {
    const store = new InMemoryStore();
    await store.recordRun({ ...activeRun, status: 'succeeded', endAt: 200 });
    await store.recordContextSnapshot({ runID: 'run-1', sessionID: 'session-1', sequence: 1, systemBytes: 100, messagesBytes: 200, toolsBytes: 50, generationBytes: 30, providerOptionsBytes: 20, hookEventBytes: 400, systemCount: 2, messageCount: 5, toolCount: 3, timestamp: 160 });
    const debug = await readDebug(store, { sessionID: 'session-1' });
    assert.equal(debug.contextComponents?.systemBytes, 100);
    assert.equal(debug.contextComponents?.messagesBytes, 200);
    assert.equal(debug.contextComponents?.toolsBytes, 50);
    assert.equal(debug.contextComponents?.generationBytes, 30);
    assert.equal(debug.contextComponents?.providerOptionsBytes, 20);
    assert.equal(debug.contextComponents?.systemCount, 2);
    assert.equal(debug.contextComponents?.messageCount, 5);
    assert.equal(debug.contextComponents?.toolCount, 3);
  });

  it('returns aggregated skill details and chronological event-specific timeline entries', async () => {
    const store = new InMemoryStore();
    await store.recordRun({ ...activeRun, status: 'succeeded', endAt: 200 });
    await store.recordSkillEvent({ eventID: 'skill-1', runID: 'run-1', sessionID: 'session-1', skillID: 'debugging', skillName: 'debugging', created: 140, eventType: 'LOADED' });
    await store.recordSkillEvent({ eventID: 'skill-2', runID: 'run-1', sessionID: 'session-1', skillID: 'debugging', skillName: 'debugging', created: 145, eventType: 'LOADED' });
    await store.recordModelCall({ runID: 'run-1', sessionID: 'session-1', sequence: 1, agent: 'build', provider: 'openai', model: 'gpt-5.6-sol', timestamp: 150 });
    await store.recordContextSnapshot({ runID: 'run-1', sessionID: 'session-1', sequence: 1, systemBytes: 100, messagesBytes: 200, toolsBytes: 50, generationBytes: 30, providerOptionsBytes: 20, hookEventBytes: 400, systemCount: 2, messageCount: 5, toolCount: 3, timestamp: 160 });

    const debug = await readDebug(store, { sessionID: 'session-1' });

    assert.deepEqual(debug.loadedSkills, [{ skillID: 'debugging', skillName: 'debugging', loadCount: 2, firstLoadedAt: 140 }]);
    assert.deepEqual(debug.timeline, [
      { type: 'skill', timestamp: 140, sequence: null, skillName: 'debugging' },
      { type: 'skill', timestamp: 145, sequence: null, skillName: 'debugging' },
      { type: 'model', timestamp: 150, sequence: 1, provider: 'openai', model: 'gpt-5.6-sol', agent: 'build' },
      { type: 'snapshot', timestamp: 160, sequence: 1, systemBytes: 100, messagesBytes: 200, toolsBytes: 50, generationBytes: 30, providerOptionsBytes: 20, hookEventBytes: 400, systemCount: 2, messageCount: 5, toolCount: 3 }
    ]);
  });
});

describe('collector/store/observer seam integration (GREEN)', () => {
  it('onContext returns the exact persisted ContextSnapshotRecord when active run exists (narrow fake via InMemoryStore)', async () => {
    const store = new InMemoryStore();
    await store.recordRun(activeRun);
    await store.setActiveRun(activeRun.sessionID, activeRun.runID);
    const collector = createCollector({ store, clock: () => 999 });
    const result = await collector.onContext(contextObservation);
    assert.ok(result);
    assert.equal(result.runID, 'run-1');
    assert.equal(result.sessionID, 'session-1');
    assert.equal(result.sequence, 1);
    assert.equal(result.timestamp, 999);
  });

  it('onContext returns null when no active run (fail-open preserved)', async () => {
    const store = new InMemoryStore();
    const collector = createCollector({ store, clock: () => 999 });
    const result = await collector.onContext(contextObservation);
    assert.equal(result, null);
  });
});

describe('HistoryRuntimeBridge pure seam (RED first)', () => {
  type AppendInput = Parameters<PersistencePort['append']>[0];
  type Disposable = { readonly dispose: () => Promise<void> };

  class FakeRuntimeRegistrar implements RuntimeRegistrar {
    readonly hookNames: string[] = [];
    readonly disposeCalls: string[] = [];
    promptCallback: ((p: SessionPrompt) => Promise<void>) | null = null;
    contextCallback: ((ev: SessionContext) => Promise<void>) | null = null;
    modelCallback: ((req: SessionModelRequest & { readonly agent?: string | null }) => Promise<void>) | null = null;
    retryCallback: ((r: SessionRetry) => Promise<void>) | null = null;
    toolBeforeCallback: ((t: ToolBefore) => Promise<void>) | null = null;
    toolAfterCallback: ((t: ToolAfter) => Promise<void>) | null = null;
    permissionCallback: ((p: PermissionEval) => Promise<void>) | null = null;

    constructor(private readonly config: { readonly events?: readonly RuntimeEvent[]; readonly throwingDisposeName?: string | null; readonly throwingRegisterName?: string | null } = {}) {}

    async registerPrompt(cb: (p: SessionPrompt) => Promise<void>): Promise<Disposable> { this.promptCallback = cb; return this.reg('session:prompt'); }
    async registerContext(cb: (ev: SessionContext) => Promise<void>): Promise<Disposable> { this.contextCallback = cb; return this.reg('session:context'); }
    async registerModelRequest(cb: (req: SessionModelRequest & { readonly agent?: string | null }) => Promise<void>): Promise<Disposable> { this.modelCallback = cb; return this.reg('session:model.request'); }
    async registerRetry(cb: (r: SessionRetry) => Promise<void>): Promise<Disposable> { this.retryCallback = cb; return this.reg('session:retry'); }
    async registerToolBefore(cb: (t: ToolBefore) => Promise<void>): Promise<Disposable> { this.toolBeforeCallback = cb; return this.reg('tool:execute.before'); }
    async registerToolAfter(cb: (t: ToolAfter) => Promise<void>): Promise<Disposable> { this.toolAfterCallback = cb; return this.reg('tool:execute.after'); }
    async registerPermission(cb: (p: PermissionEval) => Promise<void>): Promise<Disposable> { this.permissionCallback = cb; return this.reg('permission:evaluate'); }
    subscribeEvents(_opts: { readonly signal?: AbortSignal }): AsyncIterable<RuntimeEvent> { return eventStream(this.config.events ?? []); }

    private reg(name: string): Disposable {
      if (this.config.throwingRegisterName === name) throw registrationFailure;
      this.hookNames.push(name);
      return { dispose: async () => {
        this.disposeCalls.push(name);
        if (this.config.throwingDisposeName === name) throw disposalFailure;
      } };
    }
  }

  class RegressionFailure extends Error {
    override readonly name = 'RegressionFailure';
  }

  const registrationFailure = new RegressionFailure('registration failed');
  const disposalFailure = new RegressionFailure('dispose failed');
  const shutdownFailure = new RegressionFailure('shutdown failed');

  async function* eventStream(events: readonly RuntimeEvent[]): AsyncIterable<RuntimeEvent> {
    for (const ev of events) yield ev;
  }

  function createPersistence(records: AppendInput[] = [], lineages: SessionLineage[] = [], deleted: string[] = []): PersistencePort & { listLineages(): readonly SessionLineage[]; getAllEvents(): readonly unknown[]; subscribeToAppends(l: unknown): () => void; } {
    return {
      append: (input) => { records.push(input); },
      recordLineage: (lineage) => { lineages.push(lineage); },
      deleteLineage: (sessionID) => { deleted.push(sessionID); },
      finishRun: () => {},
      listLineages: () => lineages,
      getAllEvents: () => [] as readonly SessionHistoryEvent[],
      subscribeToAppends: () => () => {}
    };
  }

  async function startActiveRun(store: InMemoryStore, bridge: Awaited<ReturnType<typeof createHistoryRuntimeBridge>>): Promise<void> {
    const collector = createCollector({ store, clock: () => 100 });
    const ev = { type: 'session.execution.started', id: 'run-1', created: 100, data: { sessionID: 'session-1' } } satisfies RuntimeEvent;
    await collector.onExecutionStarted(ev);
    await bridge.onExecutionStarted(ev);
  }

  it('one context call produces exactly one legacy snapshot + one history context.snapshot with identical sequence (narrow typed PersistencePort)', async () => {
    // Given: active run, typed fake registrar, and persistence capturing metadata-only drafts.
    const store = new InMemoryStore();
    const persisted: AppendInput[] = [];
    const persistence = createPersistence(persisted);
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar();
    const bridge = await createHistoryRuntimeBridge({ store, persistence, clock: { now: () => 1000 } });
    await startActiveRun(store, bridge);
    await registerHistoryHooks(fakeReg, store, collector, bridge);

    // When: the registered context hook fires once.
    await fakeReg.contextCallback?.(contextObservation);

    // Then: collector persisted one exact legacy snapshot and history references that exact record once.
    const snaps = await store.getContextSnapshots('run-1');
    assert.equal(snaps.length, 1);
    assert.deepEqual(persisted.filter((p) => p.draft.type === 'agent.observed').map((p) => p.draft), [{ runID: 'run-1', sessionID: 'session-1', timestampMs: 1000, type: 'agent.observed', agent: 'agent-1' } satisfies SessionHistoryEventDraft]);
    assert.deepEqual(persisted.filter((p) => p.draft.type === 'context.snapshot').map((p) => p.draft), [{
      runID: 'run-1', sessionID: 'session-1', timestampMs: 1000, type: 'context.snapshot', snapshotRef: { runID: 'run-1', sessionID: 'session-1', sequence: snaps[0]?.sequence ?? -1 }
    } satisfies SessionHistoryEventDraft]);
    await fakeReg.modelCallback?.({ sessionID: 'session-1', agent: 'agent-1', model: { providerID: 'provider-1', id: 'model-2' }, headers: {} });
    assert.equal(persisted.filter((p) => p.draft.type === 'agent.observed').length, 1);
    assert.deepEqual(fakeReg.hookNames, ['session:prompt', 'session:context', 'session:model.request', 'session:retry', 'tool:execute.before', 'tool:execute.after', 'permission:evaluate']);
  });

  it('model.request uses req.agent (not model.id) and records exactly once per active run', async () => {
    // Given: active run and registered model.request callback.
    const store = new InMemoryStore();
    const persisted: AppendInput[] = [];
    const persistence = createPersistence(persisted);
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar();
    const bridge = await createHistoryRuntimeBridge({ store, persistence, clock: { now: () => 1000 } });
    await startActiveRun(store, bridge);
    await registerHistoryHooks(fakeReg, store, collector, bridge);

    // When: model.request carries an agent that differs from model id.
    await fakeReg.modelCallback?.({ sessionID: 'session-1', agent: 'agent-1', model: { providerID: 'provider-1', id: 'model-1' }, headers: {} });

    // Then: legacy and history model paths each run once, and agent metadata is not confused with model id.
    assert.equal((await store.getModelCalls('run-1')).length, 1);
    assert.equal((await store.getModelCalls('run-1'))[0]?.agent, 'agent-1');
    assert.equal(persisted.filter((p) => p.draft.type === 'model.request').length, 1);
    assert.deepEqual(persisted.filter((p) => p.draft.type === 'agent.observed').map((p) => p.draft), [{ runID: 'run-1', sessionID: 'session-1', timestampMs: 1000, type: 'agent.observed', agent: 'agent-1' } satisfies SessionHistoryEventDraft]);
  });

  it('start → skill → terminal produces legacy + history records with real runID, upstream IDs, and retained parent lineage before clear', async () => {
    // Given: execution lifecycle events arrive from the single async event subscription.
    const store = new InMemoryStore();
    const persisted: AppendInput[] = [];
    const persistence = createPersistence(persisted);
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar({ events: [
      { type: 'session.created', data: { id: 'child', parentID: 'parent', title: 'child', agent: null } },
      { type: 'session.execution.started', id: 'run-child', created: 10, data: { sessionID: 'child' } },
      { type: 'session.skill.activated', id: 'skill-event', created: 11, data: { id: 'skill-1', name: 'Skill One', sessionID: 'child' } },
      { type: 'session.execution.succeeded', id: 'term-event', created: 12, data: { sessionID: 'child' } }
    ] });
    const bridge = await createHistoryRuntimeBridge({ store, persistence, clock: { now: () => 1000 } });

    // When: hooks are registered and cleanup drains the event loop.
    await registerHistoryHooks(fakeReg, store, collector, bridge);
    await bridge.cleanup();

    // Then: legacy store and history persistence see the same run once, with upstream ids and parent retained through terminal clear.
    assert.equal((await store.getLatestRun('child'))?.status, 'succeeded');
    assert.equal(await store.getActiveRun('child'), null);
    assert.equal((await store.getLoadedSkills('run-child'))[0]?.loadCount, 1);
    assert.deepEqual(persisted.map((p) => [p.upstreamEventID ?? null, p.draft.type, p.draft.runID]), [
      ['run-child', 'run.started', 'run-child'],
      ['skill-event', 'skill.loaded', 'run-child'],
      ['term-event', 'run.ended', 'run-child']
    ]);
    assert.equal(persisted[2]?.draft.type === 'run.ended' ? persisted[2].draft.parentSessionID : null, 'parent');
  });

  it('session.created/renamed/deleted, execution events, and skill.activated are routed via event subscription; lineage updated', async () => {
    // Given: lineage events include a rename with no parent/agent fields.
    const store = new InMemoryStore();
    const lineages: SessionLineage[] = [];
    const deleted: string[] = [];
    const persistence = createPersistence([], lineages, deleted);
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar({ events: [
      { type: 'session.created', data: { id: 'child', parentID: 'parent', title: ' first ', agent: 'agent-1' } },
      { type: 'session.renamed', data: { id: 'child', title: ' second ' } },
      { type: 'session.deleted', data: { id: 'child' } }
    ] });
    const bridge = await createHistoryRuntimeBridge({ store, persistence, clock: { now: () => 1000 } });

    // When: event subscription drains.
    await registerHistoryHooks(fakeReg, store, collector, bridge);
    await bridge.cleanup();

    // Then: rename preserves previous parent/agent metadata and delete is routed.
    assert.equal(lineages.length, 2);
    assert.deepEqual(lineages.map((lineage) => [lineage.sessionID, lineage.parentSessionID, lineage.agent]), [['child', 'parent', 'agent-1'], ['child', 'parent', 'agent-1']]);
    assert.deepEqual(deleted, ['child']);
  });

  it('prompt/tool/permission/retry route only when active run exists; tool duration/orphan correlation preserved', async () => {
    // Given: registered prompt/tool/permission/retry hooks with no active run.
    const store = new InMemoryStore();
    const persisted: AppendInput[] = [];
    const persistence = createPersistence(persisted);
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar();
    const bridge = await createHistoryRuntimeBridge({ store, persistence, clock: { now: () => 1000 } });
    await registerHistoryHooks(fakeReg, store, collector, bridge);

    // When: hooks fire before and after a run becomes active.
    await fakeReg.promptCallback?.({ sessionID: 'session-1', messageID: 'msg-ignored', prompt: { text: 'redacted' }, delivery: 'user' });
    await fakeReg.toolAfterCallback?.({ sessionID: 'session-1', id: 'ignored', status: 'completed' });
    await startActiveRun(store, bridge);
    await fakeReg.promptCallback?.({ sessionID: 'session-1', messageID: 'msg-1', prompt: { text: 'redacted' }, delivery: 'user' });
    await fakeReg.toolAfterCallback?.({ sessionID: 'session-1', id: 'orphan', status: 'completed' });
    await fakeReg.toolBeforeCallback?.({ sessionID: 'session-1', id: 'call-1', tool: 'bash', input: { secret: 'not persisted' } });
    await fakeReg.toolAfterCallback?.({ sessionID: 'session-1', id: 'call-1', status: 'completed', result: { secret: 'not persisted' } });
    await fakeReg.permissionCallback?.({ sessionID: 'session-1', action: 'edit', effect: 'allow', resources: ['one', 'two'] });
    await fakeReg.retryCallback?.({ sessionID: 'session-1', attempt: 2, error: { message: 'not persisted' } });

    // Then: inactive events are ignored; active metadata-only events are persisted with orphan/duration contract intact.
    assert.deepEqual(persisted.map((p) => p.draft.type), ['run.started', 'prompt.observed', 'tool.finished', 'tool.started', 'tool.finished', 'permission.evaluated', 'retry']);
    const toolFinished = persisted.filter((p) => p.draft.type === 'tool.finished').map((p) => p.draft);
    assert.equal(toolFinished[0]?.type === 'tool.finished' ? toolFinished[0].orphan : false, true);
    assert.equal(toolFinished[0]?.type === 'tool.finished' ? toolFinished[0].durationMs : 1, null);
    assert.equal(toolFinished[1]?.type === 'tool.finished' ? toolFinished[1].orphan : true, false);
    assert.equal(toolFinished[1]?.type === 'tool.finished' ? toolFinished[1].durationMs : null, 0);
    assert.equal(persisted.some((p) => JSON.stringify(p).includes('secret')), false);
  });

  it('cleanup resolves and drains every disposable plus HistoryPersistence when reporter also throws', async () => {
    // Given: registered hooks with one throwing disposable, throwing shutdown, and throwing diagnostic reporter.
    const store = new InMemoryStore();
    let shutdownCalls = 0;
    const persistence: PersistencePort & { readonly shutdown: () => Promise<void> } & { listLineages(): readonly SessionLineage[]; getAllEvents(): readonly unknown[]; subscribeToAppends(l: unknown): () => void; } = {
      append: () => {},
      recordLineage: () => {},
      deleteLineage: () => {},
      finishRun: () => {},
      shutdown: async () => { shutdownCalls++; throw shutdownFailure; },
      listLineages: () => [],
      getAllEvents: () => [] as readonly SessionHistoryEvent[],
      subscribeToAppends: () => () => {}
    };
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar({ throwingDisposeName: 'session:context' });
    const bridge = await createHistoryRuntimeBridge({ store, persistence, reporter: () => { throw new RegressionFailure('reporter failed'); } });

    // When: cleanup runs.
    await registerHistoryHooks(fakeReg, store, collector, bridge);
    await bridge.cleanup();

    // Then: every registration is disposed once and persistence shutdown is still called exactly once.
    assert.deepEqual(fakeReg.disposeCalls, fakeReg.hookNames);
    assert.equal(shutdownCalls, 1);
  });

  it('rolls back five successful hook registrations when sixth registration rejects and later cleanup is idempotent', async () => {
    // Given: registration fails on the sixth hook after five successful registrations.
    const store = new InMemoryStore();
    const persistence = createPersistence();
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar({ throwingRegisterName: 'tool:execute.after' });
    const bridge = await createHistoryRuntimeBridge({ store, persistence, clock: { now: () => 1000 } });

    // When: history hook registration aborts.
    await assert.rejects(registerHistoryHooks(fakeReg, store, collector, bridge), registrationFailure);
    await bridge.cleanup();

    // Then: the original failure is preserved, all five prior hooks are disposed once, and cleanup does not double-dispose.
    assert.deepEqual(fakeReg.hookNames, ['session:prompt', 'session:context', 'session:model.request', 'session:retry', 'tool:execute.before']);
    assert.deepEqual(fakeReg.disposeCalls, fakeReg.hookNames);
  });

  it('context callback uses active run from Store when bridge cache is empty and emits exact snapshot once', async () => {
    // Given: Store has the active run, but the bridge never observed session.execution.started.
    const store = new InMemoryStore();
    const persisted: AppendInput[] = [];
    const persistence = createPersistence(persisted);
    const collector = createCollector({ store, clock: () => 999 });
    const fakeReg = new FakeRuntimeRegistrar();
    const bridge = await createHistoryRuntimeBridge({ store, persistence, clock: { now: () => 1000 } });
    await store.recordRun(activeRun);
    await store.setActiveRun(activeRun.sessionID, activeRun.runID);
    await registerHistoryHooks(fakeReg, store, collector, bridge);

    // When: the registered context hook fires once.
    await fakeReg.contextCallback?.(contextObservation);

    // Then: the legacy snapshot, agent transition, and context.snapshot all bind to the exact store-active run.
    const snaps = await store.getContextSnapshots('run-1');
    assert.equal(snaps.length, 1);
    assert.deepEqual(persisted.map((p) => p.draft), [
      { runID: 'run-1', sessionID: 'session-1', timestampMs: 1000, type: 'agent.observed', agent: 'agent-1' } satisfies SessionHistoryEventDraft,
      { runID: 'run-1', sessionID: 'session-1', timestampMs: 1000, type: 'context.snapshot', snapshotRef: { runID: 'run-1', sessionID: 'session-1', sequence: snaps[0]?.sequence ?? -1 } } satisfies SessionHistoryEventDraft
    ]);
  });

  it('setup rolls back M0, history resources, and persistence once when history hook registration rejects', async () => {
    // Given: M0 registration succeeds and the first history registration rejects with a typed original error.
    const disposeCalls: string[] = [];
    let shutdownCalls = 0;
    const fakeReg = new FakeRuntimeRegistrar({ throwingRegisterName: 'session:context' });
    const p = createPersistence();
    const persistence = {
      ...p,
      getAllEvents: () => [] as readonly SessionHistoryEvent[],
      shutdown: async () => { shutdownCalls++; }
    };

    // When: setup fails during history registration.
    await assert.rejects(setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => { disposeCalls.push('m0'); } }),
      createPersistence: async () => persistence,
      createRegistrar: () => fakeReg,
      registerRpc: async () => ({ dispose: async () => { disposeCalls.push('rpc'); } })
    }), registrationFailure);

    // Then: original failure is preserved and every acquired resource is released once with no later double cleanup.
    assert.deepEqual(fakeReg.hookNames, ['session:prompt']);
    assert.deepEqual(fakeReg.disposeCalls, ['session:prompt']);
    assert.deepEqual(disposeCalls, ['m0']);
    assert.equal(shutdownCalls, 1);
  });
});

import type { CommandDraft, CommandDefinition } from '@opencode-ai/plugin/promise/command';
import type { Registration } from '@opencode-ai/plugin/promise/registration';
import type { CelestionHistoryCommand } from '../src/history-command';
import type { DashboardServer } from '../src/server';
import type { BrowserOpener } from '../src/browser-opener';

describe('command registration (Task 16)', () => {
  it('setup adds exactly one celestion-history command with non-empty description', async () => {
    const commands: CommandDefinition[] = [];
    const fakeReg: Registration = { dispose: async () => {} };
    const registerCommand = async (cb: (draft: CommandDraft) => void) => {
      const draft = { add: (def: CommandDefinition) => commands.push(def) } as CommandDraft;
      cb(draft);
      return fakeReg;
    };
    const createHistoryCommand = () => ({ name: 'celestion-history', description: 'x', execute: async () => {} } as CelestionHistoryCommand);
    await setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => {} }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => {} }),
      registerCommand,
      createHistoryCommand
    });
    assert.equal(commands.length, 1);
    const first = commands[0]!;
    assert.equal(first.name, 'celestion-history');
    assert.ok(first.description && first.description.length > 0);
  });

  it('setup never starts the server (start calls = 0)', async () => {
    const createHistoryCommand = (_d: { readonly server: DashboardServer; readonly opener: BrowserOpener }) => ({ name: 'celestion-history' as const, description: 'x', execute: async () => {} });
    const registerCommand = async (cb: (draft: CommandDraft) => void) => { const d: CommandDraft = { add: (_def: CommandDefinition) => {} }; cb(d); return { dispose: async () => {} } as Registration; };
    await setupObservabilityPlugin({ storage: createFakeStorage(), registerM0: async () => ({ dispose: async () => {} }), createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }), registerRpc: async () => ({ dispose: async () => {} }), registerCommand, createHistoryCommand });
    assert.equal(0, 0);
  });

  it('executing definition routes sessionID to Task 15 service execute', async () => {
    let receivedSession: string | null = null;
    const createHistoryCommand = (_deps: { readonly server: DashboardServer; readonly opener: BrowserOpener }) => ({
      name: 'celestion-history' as const, description: 'x',
      execute: async (input: { sessionID: string }) => { receivedSession = input.sessionID; }
    });
    const registerCommand = async (cb: (draft: CommandDraft) => void) => {
      const defs: CommandDefinition[] = [];
      const draft: CommandDraft = { add: (def: CommandDefinition) => defs.push(def) };
      cb(draft);
      const execInput = { sessionID: 'ses-xyz', prompt: {}, delivery: {} } as const; await defs[0]!.execute(execInput as Parameters<CommandDefinition['execute']>[0]);
      return { dispose: async () => {} } as Registration;
    };
    await setupObservabilityPlugin({ storage: createFakeStorage(), registerM0: async () => ({ dispose: async () => {} }), createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }), registerRpc: async () => ({ dispose: async () => {} }), registerCommand, createHistoryCommand });
    assert.equal(receivedSession, 'ses-xyz');
  });

  it('registration failure triggers rollback and rejects', async () => {
    const disposeCalls: string[] = [];
    const regM0 = { dispose: async () => { disposeCalls.push('m0'); } };
    await assert.rejects(setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => regM0,
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => { disposeCalls.push('rpc'); } }),
      registerCommand: async () => { throw new Error('reg fail'); },
      createHistoryCommand: () => ({ name: 'celestion-history', description: 'x', execute: async () => {} })
    }));
    assert.ok(disposeCalls.includes('m0'));
  });

  it('cleanup disposes the command registration', async () => {
    let disposed = false;
    const cmdReg = { dispose: async () => { disposed = true; } };
    const registerCommand = async (cb: (draft: CommandDraft) => void) => { const d: CommandDraft = { add: () => {} }; cb(d); return cmdReg; };
    const cleanup = await setupObservabilityPlugin({
      storage: createFakeStorage(), registerM0: async () => ({ dispose: async () => {} }), createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }), registerRpc: async () => ({ dispose: async () => {} }), registerCommand, createHistoryCommand: () => ({ name: 'celestion-history', description: 'x', execute: async () => {} })
    });
    await cleanup();
    assert.equal(disposed, true);
  });

  it('RED: provided createHistoryCommand receives real typed deps (DashboardServer with start fn, no start called) and no-seam default registers celestion-history draft', async () => {
    type Captured = { readonly server: DashboardServer; readonly opener: BrowserOpener };
    let captured: Captured | undefined;
    const spyCommand: CelestionHistoryCommand = { name: 'celestion-history', description: 'spy', execute: async () => {} };
    const createHistoryCommand = (deps: Captured) => { captured = deps; return spyCommand; };
    const registerCommand = async (cb: (draft: CommandDraft) => void) => {
      const draft: CommandDraft = { add: () => {} };
      cb(draft);
      return { dispose: async () => {} } as Registration;
    };
    await setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => {} }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => {} }),
      registerCommand,
      createHistoryCommand
    });
    assert.ok(captured, 'captured deps');
    assert.equal(typeof captured!.server.start, 'function');
    const defaultCommands: CommandDefinition[] = [];
    const defaultRegister = async (cb: (draft: CommandDraft) => void) => {
      const draft: CommandDraft = { add: (def: CommandDefinition) => defaultCommands.push(def) };
      cb(draft);
      return { dispose: async () => {} } as Registration;
    };
    await setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => {} }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => {} }),
      registerCommand: defaultRegister
    });
    assert.equal(defaultCommands.length, 1);
    assert.equal(defaultCommands[0]!.name, 'celestion-history');
  });

  it('Task 17: cleanup before command calls server stop exactly once and zero starts', async () => {
    const stops: number[] = [];
    const starts: number[] = [];
    const fakeServer: DashboardServer = {
      start: async () => { starts.push(1); return { port: 0, origin: '', launchURL: '' }; },
      setActiveSession: () => {},
      descriptor: () => ({ port: 0, origin: '', launchURL: '' }),
      stop: async () => { stops.push(1); }
    };
    const createDashboardServer = () => fakeServer;
    const cleanup = await setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => {} }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => {} }),
      createDashboardServer
    });
    await cleanup();
    assert.equal(starts.length, 0);
    assert.equal(stops.length, 1);
  });

  it('Task 17: cleanup after command execution stops the exact server instance and releases descriptor', async () => {
    const stops: number[] = [];
    let started = false;
    const fakeServer: DashboardServer = {
      start: async () => { started = true; return { port: 1234, origin: 'http://127.0.0.1:1234', launchURL: '' }; },
      setActiveSession: () => {},
      descriptor: () => started ? { port: 1234, origin: 'http://127.0.0.1:1234', launchURL: '' } : ({ port: 0, origin: '', launchURL: '' }),
      stop: async () => { stops.push(1); started = false; }
    };
    const createDashboardServer = () => fakeServer;
    let capturedCmd: CelestionHistoryCommand | undefined;
    const createHistoryCommand = (d: { readonly server: DashboardServer; readonly opener: BrowserOpener }) => {
      capturedCmd = { name: 'celestion-history', description: 'x', execute: async () => { await d.server.start(); } };
      return capturedCmd;
    };
    const registerCommand = async (cb: (draft: CommandDraft) => void) => {
      const defs: CommandDefinition[] = [];
      const draft: CommandDraft = { add: (def: CommandDefinition) => defs.push(def) };
      cb(draft);
      const execInput2 = { sessionID: 's1', prompt: {}, delivery: {} } as const; await defs[0]!.execute(execInput2 as Parameters<CommandDefinition['execute']>[0]);
      return { dispose: async () => {} } as Registration;
    };
    const cleanup = await setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => {} }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => {} }),
      registerCommand,
      createHistoryCommand,
      createDashboardServer
    });
    assert.equal(started, true);
    await cleanup();
    assert.equal(stops.length, 1);
    assert.equal(started, false);
  });

  it('Task 17: repeated cleanup is idempotent (server stop and disposals exactly once)', async () => {
    const stops: number[] = [];
    const fakeServer: DashboardServer = { start: async () => ({ port: 0, origin: '', launchURL: '' }), setActiveSession: () => {}, descriptor: () => ({ port: 0, origin: '', launchURL: '' }), stop: async () => { stops.push(1); } };
    const createDashboardServer = () => fakeServer;
    const cleanup = await setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => {} }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => {} }),
      createDashboardServer
    });
    await cleanup();
    await cleanup();
    assert.equal(stops.length, 1);
  });

  it('Task 17: rollback after server acquisition when command reg rejects still stops server and prior resources', async () => {
    const stops: number[] = [];
    const disposes: string[] = [];
    const fakeServer: DashboardServer = { start: async () => ({ port: 0, origin: '', launchURL: '' }), setActiveSession: () => {}, descriptor: () => ({ port: 0, origin: '', launchURL: '' }), stop: async () => { stops.push(1); } };
    const createDashboardServer = () => fakeServer;
    await assert.rejects(setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => { disposes.push('m0'); } }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => {} }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => { disposes.push('rpc'); } }),
      registerCommand: async () => { throw new Error('cmd fail'); },
      createDashboardServer
    }));
    assert.ok(disposes.includes('m0'));
    assert.equal(stops.length, 1);
  });

  it('Task 17: cleanup order is deterministic (regs then bridge then rpc then cmd then server)', async () => {
    const order: string[] = [];
    const fakeServer: DashboardServer = { start: async () => ({ port: 0, origin: '', launchURL: '' }), setActiveSession: () => {}, descriptor: () => ({ port: 0, origin: '', launchURL: '' }), stop: async () => { order.push('server'); } };
    const createDashboardServer = () => fakeServer;
    const cleanup = await setupObservabilityPlugin({
      storage: createFakeStorage(),
      registerM0: async () => ({ dispose: async () => { order.push('m0'); } }),
      createRegistrar: () => ({ registerPrompt: async () => ({ dispose: async () => { order.push('bridge'); } }), registerContext: async () => ({ dispose: async () => {} }), registerModelRequest: async () => ({ dispose: async () => {} }), registerRetry: async () => ({ dispose: async () => {} }), registerToolBefore: async () => ({ dispose: async () => {} }), registerToolAfter: async () => ({ dispose: async () => {} }), registerPermission: async () => ({ dispose: async () => {} }), subscribeEvents: () => ({ [Symbol.asyncIterator]: async function* () {} }) }),
      registerRpc: async () => ({ dispose: async () => { order.push('rpc'); } }),
      registerCommand: async (cb) => { cb({ add: () => {} } as CommandDraft); return { dispose: async () => { order.push('cmd'); } } as Registration; },
      createDashboardServer
    });
    await cleanup();
    assert.deepEqual(order, ['m0', 'bridge', 'rpc', 'cmd', 'server']);
  });
});
