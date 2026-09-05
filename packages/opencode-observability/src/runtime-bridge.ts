import type { Store } from './store';
import type { ContextSnapshotRecord } from './domain';
import { HistoryObserver, type HistoryObserverDiagnosticCode } from './history-observer';
import type {
  SessionPrompt,
  SessionModelRequest,
  SessionRetry,
  ToolBefore,
  ToolAfter,
  PermissionEval,
  InjectedClock,
  PersistencePort
} from './history-observer-shapes';
import type { Reg } from './runtime-hooks';

export { registerHistoryHooks, type HookRegistrar, type RuntimeEvent, type RuntimeRegistrar } from './runtime-hooks';

type DiagnosticCode = HistoryObserverDiagnosticCode | 'BRIDGE_ERROR';

const reportCodeOnly = (_code: DiagnosticCode) => {};

type Reporter = (code: DiagnosticCode) => void;

type RuntimeModelRequest = SessionModelRequest & { readonly agent?: string | null };

export interface HistoryRuntimeBridgeDeps {
  readonly store: Store;
  readonly persistence: PersistencePort & { readonly shutdown?: () => Promise<void> };
  readonly clock?: InjectedClock;
  readonly reporter?: Reporter;
}

export interface HistoryRuntimeBridge {
  onExecutionStarted(ev: { id: string; created: number; data: { sessionID: string } }): Promise<void>;
  onExecutionTerminal(ev: { type: string; created: number; data: { sessionID: string } }, upstreamID: string): Promise<void>;
  onSkillActivated(ev: { id: string; created: number; data: { id: string; name: string; sessionID: string } }): Promise<void>;
  onSessionCreated(s: { readonly id: string; readonly parentID?: string | null; readonly title?: string; readonly agent?: string | null }): void;
  onSessionRenamed(s: { readonly id: string; readonly parentID?: string | null; readonly title?: string; readonly agent?: string | null }): void;
  onSessionDeleted(s: { id: string }): void;
  onPrompt(p: SessionPrompt): Promise<void>;
  onContext(observation: { readonly context: { readonly agent: string }; readonly snapshot: ContextSnapshotRecord }): Promise<void>;
  onModelRequest(req: RuntimeModelRequest): Promise<void>;
  onRetry(r: SessionRetry): Promise<void>;
  onToolBefore(t: ToolBefore): Promise<void>;
  onToolAfter(t: ToolAfter): Promise<void>;
  onPermission(p: PermissionEval): Promise<void>;
  addCleanup(resources: { readonly registrations: readonly Reg[]; readonly abort: () => void; readonly loop: Promise<void> }): void;
  readonly cleanup: () => Promise<void>;
}

interface SessionState { readonly runID: string; readonly parent: string | null; readonly agent: string | null }

export async function createHistoryRuntimeBridge(deps: HistoryRuntimeBridgeDeps): Promise<HistoryRuntimeBridge> {
  const { store, persistence, clock = { now: () => Date.now() }, reporter = reportCodeOnly } = deps;
  const safeDiagnostic = (code: DiagnosticCode): void => {
    try { reporter(code); } catch (error) { if (error instanceof Error) return; return; }
  };
  const observer = new HistoryObserver(persistence, clock, safeDiagnostic);
  const sessions = new Map<string, SessionState>();
  let hookCleanup: { readonly registrations: readonly Reg[]; readonly abort: () => void; readonly loop: Promise<void> } | null = null;
  let persistenceShutdownCalled = false;

  const getActive = async (sessionID: string): Promise<SessionState | null> => {
    const cached = sessions.get(sessionID);
    if (cached && cached.runID !== '') return cached;
    const active = await store.getActiveRun(sessionID);
    if (!active) return null;
    const resolved = { runID: active.runID, parent: null, agent: active.agent };
    sessions.set(sessionID, resolved);
    return resolved;
  };

  const setActive = (sessionID: string, runID: string, parent: string | null, agent: string | null): void => {
    sessions.set(sessionID, { runID, parent, agent });
  };

  const disposeOne = async (reg: Reg): Promise<void> => {
    try { await reg.dispose(); } catch (error) { if (error instanceof Error) safeDiagnostic('BRIDGE_ERROR'); else safeDiagnostic('BRIDGE_ERROR'); }
  };

  const bridge: HistoryRuntimeBridge = {
    async onExecutionStarted(ev) {
      const runID = ev.id;
      const sessionID = ev.data.sessionID;
      const existing = sessions.get(sessionID);
      const parent = existing?.parent ?? null;
      const agent = existing?.agent ?? null;
      setActive(sessionID, runID, parent, agent);
      observer.observeRunStarted({ sessionID, parentID: parent, runID }, ev.id);
    },
    async onExecutionTerminal(ev, upstreamID) {
      const st = await getActive(ev.data.sessionID);
      if (!st) return;
      const status = ev.type.includes('succeeded') ? 'succeeded' as const : ev.type.includes('failed') ? 'failed' as const : 'interrupted' as const;
      observer.observeRunEnded({ sessionID: ev.data.sessionID, runID: st.runID, status, parentSessionID: st.parent }, upstreamID);
      sessions.delete(ev.data.sessionID);
    },
    async onSkillActivated(ev) {
      const st = await getActive(ev.data.sessionID);
      if (!st) return;
      observer.observeSkillLoaded({ runID: st.runID, sessionID: ev.data.sessionID, skillID: ev.data.id, skillName: ev.data.name }, ev.id);
    },
    onSessionCreated(s) {
      const agent = s.agent ?? null;
      const parent = s.parentID ?? null;
      const st = sessions.get(s.id);
      sessions.set(s.id, { runID: st?.runID ?? '', parent, agent });
      observer.recordSessionLineage({ sessionID: s.id, parentID: parent, agent, title: s.title ?? '' });
    },
    onSessionRenamed(s) {
      const st = sessions.get(s.id);
      const parent = st?.parent ?? s.parentID ?? null;
      const agent = st?.agent ?? s.agent ?? null;
      sessions.set(s.id, { runID: st?.runID ?? '', parent, agent });
      observer.recordSessionLineage({ sessionID: s.id, parentID: parent, agent, title: s.title ?? '' });
    },
    onSessionDeleted(s) {
      observer.deleteLineage(s.id);
      sessions.delete(s.id);
    },
    async onPrompt(p) {
      const st = await getActive(p.sessionID);
      if (!st) return;
      observer.observeSessionPrompt(p, st.runID);
    },
    async onContext({ context, snapshot }) {
      const st = await getActive(snapshot.sessionID);
      if (!st) return;
      if (snapshot.runID !== st.runID) return;
      const agent = context.agent;
      sessions.set(snapshot.sessionID, { ...st, agent });
      observer.observeAgentTransition(snapshot.sessionID, agent, st.runID);
      observer.observeContextSnapshot({ snapshotRef: { runID: snapshot.runID, sessionID: snapshot.sessionID, sequence: snapshot.sequence } });
    },
    async onModelRequest(req) {
      const st = await getActive(req.sessionID);
      if (!st) return;
      const agent = req.agent ?? st.agent;
      sessions.set(req.sessionID, { ...st, agent });
      observer.observeAgentTransition(req.sessionID, agent, st.runID);
      observer.observeModelRequest(req, st.runID);
    },
    async onRetry(r) {
      const st = await getActive(r.sessionID);
      if (!st) return;
      observer.observeRetry(r, st.runID);
    },
    async onToolBefore(t) {
      const st = await getActive(t.sessionID);
      if (!st) return;
      observer.observeToolBefore(t, st.runID);
    },
    async onToolAfter(t) {
      const st = await getActive(t.sessionID);
      if (!st) return;
      observer.observeToolAfter(t, st.runID);
    },
    async onPermission(p) {
      const st = await getActive(p.sessionID);
      if (!st) return;
      observer.observePermission(p, st.runID);
    },
    addCleanup(resources) { hookCleanup = resources; },
    async cleanup() {
      if (hookCleanup) {
        const cleanup = hookCleanup;
        hookCleanup = null;
        cleanup.abort();
        try { await cleanup.loop; } catch (error) { if (error instanceof Error) safeDiagnostic('BRIDGE_ERROR'); else safeDiagnostic('BRIDGE_ERROR'); }
        for (const reg of cleanup.registrations) await disposeOne(reg);
      }
      if (!persistenceShutdownCalled && typeof persistence.shutdown === 'function') {
        persistenceShutdownCalled = true;
        try {
          await persistence.shutdown();
        } catch (error) { if (error instanceof Error) safeDiagnostic('BRIDGE_ERROR'); else safeDiagnostic('BRIDGE_ERROR'); }
      }
    }
  };

  return bridge;
}
