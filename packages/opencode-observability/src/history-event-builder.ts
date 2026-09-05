import type { SessionHistoryEventDraft } from './history-domain';

export {
  buildPromptObservedDraft,
  buildToolStartedDraft,
  buildToolFinishedDraft,
  buildAgentObservedDraft,
  buildAgentChangedDraft,
  buildModelRequestDraft,
  buildRetryDraft,
  buildPermissionEvaluatedDraft
} from './history-event-drafts';

export function buildSkillLoadedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly skillID: string;
  readonly skillName: string;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'skill.loaded',
    skillID: params.skillID,
    skillName: params.skillName
  } satisfies SessionHistoryEventDraft;
}

export function buildRunStartedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly parentSessionID: string | null;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'run.started',
    parentSessionID: params.parentSessionID
  } satisfies SessionHistoryEventDraft;
}

export function buildRunEndedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly status: 'succeeded' | 'failed' | 'interrupted';
  readonly parentSessionID: string | null;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'run.ended',
    status: params.status,
    parentSessionID: params.parentSessionID
  } satisfies SessionHistoryEventDraft;
}

export function buildContextSnapshotDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly sequence: number;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'context.snapshot',
    snapshotRef: { runID: params.runID, sessionID: params.sessionID, sequence: params.sequence }
  } satisfies SessionHistoryEventDraft;
}

const errorMessages: Record<import('./history-observer-shapes').SafeErrorCode, string> = {
  NORMALIZATION_FAILED: 'normalization failed',
  SERIALIZATION_FAILED: 'serialization failed'
};

export function buildErrorSanitizedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly code: import('./history-observer-shapes').SafeErrorCode;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'error.sanitized',
    message: errorMessages[params.code]
  } satisfies SessionHistoryEventDraft;
}
