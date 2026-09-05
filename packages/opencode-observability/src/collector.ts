import type { Context } from '@opencode-ai/plugin/promise/plugin';
import type { Store } from './store';
import { measureContextComponents } from './measure-components';
import type { Run, ContextSnapshotRecord, ModelCall, SkillEvent } from './domain';

export interface CollectorDeps {
  readonly store: Store;
  readonly clock?: () => number;
  readonly reporter?: (code: string) => void;
}

export interface Collector {
  onExecutionStarted(ev: { id: string; created: number; data: { sessionID: string } }): Promise<void>;
  onExecutionTerminal(ev: { type: 'session.execution.succeeded' | 'session.execution.failed' | 'session.execution.interrupted'; created: number; data: { sessionID: string } }): Promise<void>;
  onSkillActivated(ev: { id: string; created: number; data: { id: string; name: string; sessionID: string } }): Promise<void>;
  onContext(ctx: ContextObservation): Promise<ContextSnapshotRecord | null>;
  onModelRequest(req: ModelRequestObservation): Promise<void>;
}

// Narrow internal shapes (metadata only, plain fields). Real types are structurally assignable.
interface ExecStart { readonly id: string; readonly created: number; readonly data: { readonly sessionID: string } }
interface ExecTerm { readonly type: 'session.execution.succeeded' | 'session.execution.failed' | 'session.execution.interrupted'; readonly created: number; readonly data: { readonly sessionID: string } }
interface SkillAct { readonly id: string; readonly created: number; readonly data: { readonly id: string; readonly name: string; readonly sessionID: string } }
export interface ContextObservation {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id: string };
  readonly system: readonly unknown[];
  readonly messages: readonly unknown[];
  readonly tools: Readonly<Record<string, unknown>>;
  readonly generation?: unknown;
  readonly providerOptions?: unknown;
}
export interface ModelRequestObservation {
  readonly sessionID: string;
  readonly agent: string;
  readonly model: { readonly providerID: string; readonly id: string };
}

class UnexpectedTerminalEventError extends Error {
  override readonly name = 'UnexpectedTerminalEventError';
}

function terminalStatus(type: ExecTerm['type']): Exclude<Run['status'], 'active'> {
  switch (type) {
    case 'session.execution.succeeded': return 'succeeded';
    case 'session.execution.failed': return 'failed';
    case 'session.execution.interrupted': return 'interrupted';
    default: throw new UnexpectedTerminalEventError(`Unexpected terminal event: ${String(type)}`);
  }
}

export function createCollector(deps: CollectorDeps): Collector {
  const { store, clock = Date.now, reporter = () => {} } = deps;
  const seqByRun = new Map<string, { ctx: number; model: number }>();

  const reportFailure = (code: string): void => {
    try {
      reporter(code);
    } catch (error) {
      if (error instanceof Error) return;
      return;
    }
  };

  const failOpen = async <T>(fn: () => Promise<T>, code: string): Promise<T | null> => {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof Error) {
        reportFailure(code);
        return null;
      }
      reportFailure(code);
      return null;
    }
  };

  const getNextSeq = (runID: string, kind: 'ctx' | 'model'): number => {
    const cur = seqByRun.get(runID) ?? { ctx: 0, model: 0 };
    if (kind === 'ctx') cur.ctx += 1;
    else cur.model += 1;
    seqByRun.set(runID, cur);
    return kind === 'ctx' ? cur.ctx : cur.model;
  };

  const updateRunMeta = async (active: Run, agent: string | null, provider: string | null, model: string | null) => {
    if (active.agent === agent && active.provider === provider && active.model === model) return;
    const updated: Run = { ...active, agent, provider, model };
    await store.recordRun(updated);
  };

  const collector: Collector = {
    async onExecutionStarted(ev: ExecStart) {
      await failOpen(async () => {
        const run: Run = {
          runID: ev.id,
          sessionID: ev.data.sessionID,
          startedAt: ev.created,
          status: 'active',
          agent: null,
          project: null,
          repo: null,
          gitRevision: null,
          provider: null,
          model: null,
          endAt: null
        };
        await store.recordRun(run);
        await store.setActiveRun(ev.data.sessionID, ev.id);
      }, 'exec-start');
    },
    async onExecutionTerminal(ev: ExecTerm) {
      await failOpen(async () => {
        const active = await store.getActiveRun(ev.data.sessionID);
        if (!active) return;
        const status = terminalStatus(ev.type);
        const updated: Run = { ...active, status, endAt: ev.created };
        await store.recordRun(updated);
        await store.clearActiveRun(ev.data.sessionID);
      }, 'exec-term');
    },
    async onSkillActivated(ev: SkillAct) {
      await failOpen(async () => {
        const active = await store.getActiveRun(ev.data.sessionID);
        if (!active) return;
        const skillEv: SkillEvent = {
          eventID: ev.id,
          runID: active.runID,
          sessionID: ev.data.sessionID,
          skillID: ev.data.id,
          skillName: ev.data.name,
          created: ev.created,
          eventType: 'LOADED'
        };
        await store.recordSkillEvent(skillEv);
      }, 'skill-act');
    },
    async onContext(hookEvent: ContextObservation): Promise<ContextSnapshotRecord | null> {
      return await failOpen(async () => {
        const active = await store.getActiveRun(hookEvent.sessionID);
        if (!active) return null;
        await updateRunMeta(active, hookEvent.agent, hookEvent.model.providerID, hookEvent.model.id);
        const sizes = measureContextComponents(hookEvent);
        const seq = getNextSeq(active.runID, 'ctx');
        const snap: ContextSnapshotRecord = {
          runID: active.runID,
          sessionID: hookEvent.sessionID,
          sequence: seq,
          systemBytes: sizes.systemBytes,
          messagesBytes: sizes.messagesBytes,
          toolsBytes: sizes.toolsBytes,
          generationBytes: sizes.generationBytes,
          providerOptionsBytes: sizes.providerOptionsBytes,
          hookEventBytes: sizes.hookEventBytes,
          systemCount: hookEvent.system.length,
          messageCount: hookEvent.messages.length,
          toolCount: Object.keys(hookEvent.tools).length,
          timestamp: clock()
        };
        await store.recordContextSnapshot(snap);
        return snap;
      }, 'context');
    },
    async onModelRequest(req: ModelRequestObservation) {
      await failOpen(async () => {
        const active = await store.getActiveRun(req.sessionID);
        if (!active) return;
        await updateRunMeta(active, req.agent, req.model.providerID, req.model.id);
        const seq = getNextSeq(active.runID, 'model');
        const call: ModelCall = {
          runID: active.runID,
          sessionID: req.sessionID,
          sequence: seq,
          agent: req.agent,
          provider: req.model.providerID,
          model: req.model.id,
          timestamp: clock()
        };
        await store.recordModelCall(call);
      }, 'model-req');
    }
  };
  return collector;
}

export async function startEventLoop(ctx: Context, collector: Collector, signal: AbortSignal): Promise<void> {
  for await (const ev of ctx.event.subscribe({ signal })) {
    switch (ev.type) {
      case 'session.execution.started':
        await collector.onExecutionStarted(ev);
        break;
      case 'session.execution.succeeded':
      case 'session.execution.failed':
      case 'session.execution.interrupted':
        await collector.onExecutionTerminal(ev);
        break;
      case 'session.skill.activated':
        await collector.onSkillActivated(ev);
        break;
      default:
        break;
    }
  }
}
