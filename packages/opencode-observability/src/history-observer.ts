import type {
  SessionHistoryEventDraft
} from './history-domain';
import type {
  SessionPrompt,
  SessionModelRequest,
  SessionRetry,
  ToolBefore,
  ToolAfter,
  PermissionEval,
  HistoryObserverDiagnosticCode,
  InjectedClock,
  PersistencePort
} from './history-observer-shapes';
import { HistoryObserverState } from './history-observer-state';
import { buildSessionLineage } from './history-lineage-mapper';
import * as builders from './history-event-builder';

export type { HistoryObserverDiagnosticCode, InjectedClock, PersistencePort } from './history-observer-shapes';

export class HistoryObserver {
  private readonly state: HistoryObserverState;

  constructor(
    private readonly persistence: PersistencePort,
    private readonly clock: InjectedClock,
    private readonly onDiagnostic?: (code: HistoryObserverDiagnosticCode) => void
  ) {
    this.state = new HistoryObserverState();
  }

  private report(code: HistoryObserverDiagnosticCode): void {
    if (!this.onDiagnostic) return;
    try { this.onDiagnostic(code); } catch (err) { return; }
  }

  private safe<T>(fn: () => T): T | undefined {
    try { return fn(); } catch (err) { this.report('NORMALIZATION_FAILED'); return undefined; }
  }

  private safeAppend(input: { readonly draft: SessionHistoryEventDraft; readonly upstreamEventID?: string | undefined }): void {
    this.safe(() => this.persistence.append(input));
  }

  observeSessionPrompt(input: SessionPrompt, runID: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildPromptObservedDraft({
        runID,
        sessionID: input.sessionID,
        messageID: input.messageID,
        delivery: input.delivery,
        prompt: input.prompt,
        timestampMs: ts
      });
      this.safeAppend({ draft, upstreamEventID: input.messageID });
    });
  }

  observeToolBefore(input: ToolBefore, runID: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      this.state.recordToolStart(runID, input.id, input.tool ?? null, ts);
      const draft = builders.buildToolStartedDraft({
        runID,
        sessionID: input.sessionID,
        callID: input.id,
        name: input.tool ?? null,
        timestampMs: ts
      });
      this.safeAppend({ draft });
    });
  }

  observeToolAfter(input: ToolAfter, runID: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const { durationMs, orphan } = this.state.getToolDuration(runID, input.id, ts);
      const status = 'status' in input ? input.status : 'error';
      const draft = builders.buildToolFinishedDraft({
        runID,
        sessionID: input.sessionID,
        callID: input.id,
        status,
        durationMs,
        orphan,
        timestampMs: ts
      });
      this.safeAppend({ draft });
    });
  }

  observeAgentTransition(sessionID: string, agent: string | null, runID: string): void {
    this.safe(() => {
      const hasPrev = this.state.hasAgent(sessionID);
      const prev = this.state.getLastAgent(sessionID);
      const type = !hasPrev ? 'agent.observed' : (prev === agent ? null : 'agent.changed');
      if (type) {
        const ts = this.clock.now();
        const draft = type === 'agent.observed'
          ? builders.buildAgentObservedDraft({ runID, sessionID, agent, timestampMs: ts })
          : builders.buildAgentChangedDraft({ runID, sessionID, agent, timestampMs: ts });
        this.safeAppend({ draft });
      }
      this.state.setLastAgent(sessionID, agent);
    });
  }

  observeModelRequest(input: SessionModelRequest, runID: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildModelRequestDraft({
        runID,
        sessionID: input.sessionID,
        provider: input.model?.providerID ?? 'unknown',
        model: input.model?.id ?? 'unknown',
        timestampMs: ts
      });
      this.safeAppend({ draft });
    });
  }

  observeRetry(input: SessionRetry, runID: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildRetryDraft({
        runID,
        sessionID: input.sessionID,
        attempt: input.attempt,
        timestampMs: ts
      });
      this.safeAppend({ draft });
    });
  }

  observeErrorSanitized(input: { readonly sessionID: string; readonly code: import('./history-observer-shapes').SafeErrorCode }, runID: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildErrorSanitizedDraft({
        runID,
        sessionID: input.sessionID,
        code: input.code,
        timestampMs: ts
      });
      this.safeAppend({ draft });
    });
  }

  observePermission(input: PermissionEval, runID: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildPermissionEvaluatedDraft({
        runID,
        sessionID: input.sessionID,
        action: input.action,
        effect: input.effect,
        resourceCount: input.resources?.length ?? 0,
        timestampMs: ts
      });
      this.safeAppend({ draft });
    });
  }

  recordSessionLineage(input: { readonly sessionID: string; readonly parentID?: string | null; readonly agent?: string | null; readonly title?: string }): void {
    try {
      const ts = this.clock.now();
      const lineage = buildSessionLineage(input, ts);
      try {
        this.persistence.recordLineage(lineage);
      } catch (err) {
        this.report('NORMALIZATION_FAILED');
      }
    } catch (err) {
      this.report('NORMALIZATION_FAILED');
    }
  }

  observeRunStarted(input: { readonly sessionID: string; readonly parentID?: string | null; readonly runID: string }, upstreamEventID?: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildRunStartedDraft({
        runID: input.runID,
        sessionID: input.sessionID,
        parentSessionID: input.parentID ?? null,
        timestampMs: ts
      });
      this.safeAppend({ draft, upstreamEventID: upstreamEventID ?? undefined });
    });
  }

  observeRunEnded(input: { readonly sessionID: string; readonly runID: string; readonly status: 'succeeded' | 'failed' | 'interrupted'; readonly parentSessionID?: string | null }, upstreamEventID?: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildRunEndedDraft({
        runID: input.runID,
        sessionID: input.sessionID,
        status: input.status,
        parentSessionID: input.parentSessionID ?? null,
        timestampMs: ts
      });
      this.safeAppend({ draft, upstreamEventID: upstreamEventID ?? undefined });
      this.persistence.finishRun(input.runID);
    });
  }

  observeSkillLoaded(input: { readonly runID: string; readonly sessionID: string; readonly skillID: string; readonly skillName: string }, upstreamEventID?: string): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildSkillLoadedDraft({
        runID: input.runID,
        sessionID: input.sessionID,
        skillID: input.skillID,
        skillName: input.skillName,
        timestampMs: ts
      });
      this.safeAppend({ draft, upstreamEventID: upstreamEventID ?? undefined });
    });
  }

  deleteLineage(sessionID: string): void {
    try {
      this.persistence.deleteLineage(sessionID);
    } catch (err) {
      this.report('NORMALIZATION_FAILED');
    }
  }

  observeContextSnapshot(input: { readonly snapshotRef: { readonly runID: string; readonly sessionID: string; readonly sequence: number } }): void {
    this.safe(() => {
      const ts = this.clock.now();
      const draft = builders.buildContextSnapshotDraft({
        runID: input.snapshotRef.runID,
        sessionID: input.snapshotRef.sessionID,
        sequence: input.snapshotRef.sequence,
        timestampMs: ts
      });
      this.safeAppend({ draft });
    });
  }
}
