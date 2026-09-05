import { z } from 'zod';
import { sanitizeSessionTitle } from './title-sanitizer';
import type { ContextSnapshotRecord } from './domain';

const nonEmptyString = z.string().min(1);
const nonNegInt = z.number().int().nonnegative();
const nonNegFinite = z.number().nonnegative().finite();

export interface SessionLineage {
  readonly sessionID: string;
  readonly parentSessionID: string | null;
  readonly agent: string | null;
  readonly sanitizedTitle: string;
  readonly kind: 'work' | 'system' | 'unknown';
  readonly observedAtMs: number;
}

export const sessionLineageSchema = z.object({
  sessionID: nonEmptyString,
  parentSessionID: z.string().nullable(),
  agent: z.string().nullable(),
  sanitizedTitle: z.string().transform((v) => sanitizeSessionTitle(v)),
  kind: z.enum(['work', 'system', 'unknown']),
  observedAtMs: nonNegFinite
}).strict();

const RunEndedStatus = z.enum(['succeeded', 'failed', 'interrupted']);

export type SessionHistoryEvent =
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'run.started'; readonly parentSessionID: string | null }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'run.ended'; readonly status: 'succeeded' | 'failed' | 'interrupted'; readonly parentSessionID: string | null }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'prompt.observed'; readonly messageID: string; readonly delivery: string; readonly partCount: number; readonly serializedBytes: number }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'model.request'; readonly provider: string; readonly model: string }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'agent.observed'; readonly agent: string | null }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'agent.changed'; readonly agent: string | null }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'tool.started'; readonly callID: string; readonly name: string | null }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'tool.finished'; readonly callID: string; readonly status: string; readonly durationMs: number | null; readonly orphan: boolean }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'permission.evaluated'; readonly action: string; readonly effect: string; readonly resourceCount: number }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'skill.loaded'; readonly skillID: string; readonly skillName: string }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'context.snapshot'; readonly snapshotRef: Pick<ContextSnapshotRecord, 'runID' | 'sessionID' | 'sequence'> }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'retry'; readonly attempt: number }
  | { readonly eventID: string; readonly runID: string; readonly sessionID: string; readonly sequence: number; readonly timestampMs: number; readonly type: 'error.sanitized'; readonly message: string };

const baseEvent = z.object({
  eventID: nonEmptyString,
  runID: nonEmptyString,
  sessionID: nonEmptyString,
  sequence: nonNegInt,
  timestampMs: nonNegFinite
}).strict();

export const sessionHistoryEventSchema = z.discriminatedUnion('type', [
  baseEvent.extend({ type: z.literal('run.started'), parentSessionID: z.string().nullable() }).strict(),
  baseEvent.extend({ type: z.literal('run.ended'), status: RunEndedStatus, parentSessionID: z.string().nullable() }).strict(),
  baseEvent.extend({ type: z.literal('prompt.observed'), messageID: nonEmptyString, delivery: nonEmptyString, partCount: nonNegInt, serializedBytes: nonNegFinite }).strict(),
  baseEvent.extend({ type: z.literal('model.request'), provider: nonEmptyString, model: nonEmptyString }).strict(),
  baseEvent.extend({ type: z.literal('agent.observed'), agent: z.string().nullable() }).strict(),
  baseEvent.extend({ type: z.literal('agent.changed'), agent: z.string().nullable() }).strict(),
  baseEvent.extend({ type: z.literal('tool.started'), callID: nonEmptyString, name: z.string().nullable() }).strict(),
  baseEvent.extend({ type: z.literal('tool.finished'), callID: nonEmptyString, status: nonEmptyString, durationMs: z.number().nonnegative().finite().nullable(), orphan: z.boolean() }).strict(),
  baseEvent.extend({ type: z.literal('permission.evaluated'), action: nonEmptyString, effect: nonEmptyString, resourceCount: nonNegInt }).strict(),
  baseEvent.extend({ type: z.literal('skill.loaded'), skillID: nonEmptyString, skillName: nonEmptyString }).strict(),
  baseEvent.extend({ type: z.literal('context.snapshot'), snapshotRef: z.object({ runID: nonEmptyString, sessionID: nonEmptyString, sequence: nonNegInt }).strict() }).strict(),
  baseEvent.extend({ type: z.literal('retry'), attempt: nonNegInt }).strict(),
  baseEvent.extend({ type: z.literal('error.sanitized'), message: nonEmptyString }).strict()
]);

export type SessionHistoryEventType = SessionHistoryEvent['type'];

type DistributiveOmit<Event extends SessionHistoryEvent, K extends PropertyKey> =
  Event extends SessionHistoryEvent ? Omit<Event, K> : never;

export type SessionHistoryEventDraft =
  DistributiveOmit<SessionHistoryEvent, 'eventID' | 'sequence'>;
