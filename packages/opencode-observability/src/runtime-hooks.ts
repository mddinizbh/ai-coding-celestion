import type { Collector, ContextObservation, ModelRequestObservation } from './collector';
import type {
  PermissionEval,
  SessionContext,
  SessionModelRequest,
  SessionPrompt,
  SessionRetry,
  ToolAfter,
  ToolBefore
} from './history-observer-shapes';
import type { Store } from './store';
import type { HistoryRuntimeBridge } from './runtime-bridge';

export type Reg = { readonly dispose: () => Promise<void> };

type ExecutionStarted = { readonly type: 'session.execution.started'; readonly id: string; readonly created: number; readonly data: { readonly sessionID: string } };
type ExecutionTerminal = { readonly type: 'session.execution.succeeded' | 'session.execution.failed' | 'session.execution.interrupted'; readonly id: string; readonly created: number; readonly data: { readonly sessionID: string } };
type SkillActivated = { readonly type: 'session.skill.activated'; readonly id: string; readonly created: number; readonly data: { readonly id: string; readonly name: string; readonly sessionID: string } };
type SessionCreated = { readonly type: 'session.created'; readonly data: { readonly id: string; readonly parentID?: string | null; readonly title?: string; readonly agent?: string | null } };
type SessionRenamed = { readonly type: 'session.renamed'; readonly data: { readonly id: string; readonly parentID?: string | null; readonly title?: string; readonly agent?: string | null } };
type SessionDeleted = { readonly type: 'session.deleted'; readonly data: { readonly id: string } };
export type RuntimeEvent = ExecutionStarted | ExecutionTerminal | SkillActivated | SessionCreated | SessionRenamed | SessionDeleted;
type RuntimeModelRequest = SessionModelRequest & { readonly agent?: string | null };

export interface RuntimeRegistrar {
  readonly registerPrompt: (cb: (p: SessionPrompt) => Promise<void>) => Promise<Reg>;
  readonly registerContext: (cb: (ev: SessionContext) => Promise<void>) => Promise<Reg>;
  readonly registerModelRequest: (cb: (req: RuntimeModelRequest) => Promise<void>) => Promise<Reg>;
  readonly registerRetry: (cb: (r: SessionRetry) => Promise<void>) => Promise<Reg>;
  readonly registerToolBefore: (cb: (t: ToolBefore) => Promise<void>) => Promise<Reg>;
  readonly registerToolAfter: (cb: (t: ToolAfter) => Promise<void>) => Promise<Reg>;
  readonly registerPermission: (cb: (p: PermissionEval) => Promise<void>) => Promise<Reg>;
  readonly subscribeEvents: (opts: { readonly signal?: AbortSignal }) => AsyncIterable<RuntimeEvent>;
}

export type HookRegistrar = RuntimeRegistrar;

const reportCodeOnly = (_code: 'BRIDGE_ERROR') => {};

export async function registerHistoryHooks(
  reg: RuntimeRegistrar,
  _store: Store,
  collector: Collector,
  bridge: HistoryRuntimeBridge
): Promise<Reg[]> {
  const regs: Reg[] = [];
  const ac = new AbortController();
  const iter = reg.subscribeEvents({ signal: ac.signal });
  const loop = startHistoryEventLoop(iter, collector, bridge);
  const push = async (p: Promise<Reg>): Promise<void> => { const r = await p; regs.push(r); };
  try {
    await push(reg.registerPrompt(async (p) => { await bridge.onPrompt(p); }));
    await push(reg.registerContext(async (obs) => {
      const callArg: ContextObservation = { ...obs, model: { providerID: obs.model.providerID ?? '', id: obs.model.id ?? '' } };
      const snap = await collector.onContext(callArg);
      if (snap) await bridge.onContext({ context: obs, snapshot: snap });
    }));
    await push(reg.registerModelRequest(async (req) => {
      await bridge.onModelRequest(req);
      const modelReq: ModelRequestObservation = { sessionID: req.sessionID, agent: req.agent ?? '', model: { providerID: req.model?.providerID ?? '', id: req.model?.id ?? '' } };
      await collector.onModelRequest(modelReq);
    }));
    await push(reg.registerRetry(async (r) => { await bridge.onRetry(r); }));
    await push(reg.registerToolBefore(async (t) => { await bridge.onToolBefore(t); }));
    await push(reg.registerToolAfter(async (t) => { await bridge.onToolAfter(t); }));
    await push(reg.registerPermission(async (p) => { await bridge.onPermission(p); }));
    bridge.addCleanup({ registrations: regs, abort: () => ac.abort(), loop });
    return regs;
  } catch (error) {
    ac.abort();
    try { await loop; } catch (loopError) { if (loopError instanceof Error) reportCodeOnly('BRIDGE_ERROR'); else reportCodeOnly('BRIDGE_ERROR'); }
    for (const registered of regs) try { await registered.dispose(); } catch (disposeError) { if (disposeError instanceof Error) reportCodeOnly('BRIDGE_ERROR'); else reportCodeOnly('BRIDGE_ERROR'); }
    throw error;
  }
}

async function startHistoryEventLoop(
  iter: AsyncIterable<RuntimeEvent>,
  collector: Collector,
  bridge: HistoryRuntimeBridge
): Promise<void> {
  try {
    for await (const ev of iter) {
      switch (ev.type) {
        case 'session.created': bridge.onSessionCreated(ev.data); break;
        case 'session.renamed': bridge.onSessionRenamed(ev.data); break;
        case 'session.deleted': bridge.onSessionDeleted(ev.data); break;
        case 'session.execution.started':
          await collector.onExecutionStarted(ev);
          await bridge.onExecutionStarted(ev);
          break;
        case 'session.execution.succeeded':
        case 'session.execution.failed':
        case 'session.execution.interrupted':
          await bridge.onExecutionTerminal(ev, ev.id);
          await collector.onExecutionTerminal(ev);
          break;
        case 'session.skill.activated':
          await collector.onSkillActivated(ev);
          await bridge.onSkillActivated(ev);
          break;
        default: break;
      }
    }
  } catch (error) {
    reportCodeOnly(error instanceof Error ? 'BRIDGE_ERROR' : 'BRIDGE_ERROR');
  }
}
