import type { SessionHistoryEventDraft } from './history-domain';
import type { PromptInput } from './history-observer-shapes';
import { computePromptMetrics } from './history-prompt-mapper';

export function buildPromptObservedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly messageID: string;
  readonly delivery: string;
  readonly prompt: PromptInput;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  const metrics = computePromptMetrics(params.prompt);
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'prompt.observed',
    messageID: params.messageID,
    delivery: params.delivery,
    partCount: metrics.partCount,
    serializedBytes: metrics.serializedBytes
  } satisfies SessionHistoryEventDraft;
}

export function buildToolStartedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly name: string | null;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'tool.started',
    callID: params.callID,
    name: params.name
  } satisfies SessionHistoryEventDraft;
}

export function buildToolFinishedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly callID: string;
  readonly status: string;
  readonly durationMs: number | null;
  readonly orphan: boolean;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'tool.finished',
    callID: params.callID,
    status: params.status,
    durationMs: params.durationMs,
    orphan: params.orphan
  } satisfies SessionHistoryEventDraft;
}

export function buildAgentObservedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly agent: string | null;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'agent.observed',
    agent: params.agent
  } satisfies SessionHistoryEventDraft;
}

export function buildAgentChangedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly agent: string | null;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'agent.changed',
    agent: params.agent
  } satisfies SessionHistoryEventDraft;
}

export function buildModelRequestDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly provider: string;
  readonly model: string;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'model.request',
    provider: params.provider,
    model: params.model
  } satisfies SessionHistoryEventDraft;
}

export function buildRetryDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly attempt: number;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'retry',
    attempt: params.attempt
  } satisfies SessionHistoryEventDraft;
}

export function buildPermissionEvaluatedDraft(params: {
  readonly runID: string;
  readonly sessionID: string;
  readonly action: string;
  readonly effect: string;
  readonly resourceCount: number;
  readonly timestampMs: number;
}): SessionHistoryEventDraft {
  return {
    runID: params.runID,
    sessionID: params.sessionID,
    timestampMs: params.timestampMs,
    type: 'permission.evaluated',
    action: params.action,
    effect: params.effect,
    resourceCount: params.resourceCount
  } satisfies SessionHistoryEventDraft;
}
