import { z } from 'zod';
import { sessionHistoryEventSchema } from '../../src/history-domain';

export const lineageRootSummarySchema = z.object({
  sessionID: z.string().min(1),
  sanitizedTitle: z.string(),
  agent: z.string().nullable(),
  kind: z.enum(['work', 'system', 'unknown']),
  observedAtMs: z.number().nonnegative().finite(),
}).strict();

export const bootstrapSchema = z.object({
  roots: z.array(lineageRootSummarySchema),
  activeRootSessionID: z.string().nullable(),
  cursor: z.string().nullable(),
}).strict();

export const rootsResponseSchema = z.object({
  roots: z.array(lineageRootSummarySchema),
}).strict();

export type LineageNodeShape = {
  readonly sessionID: string;
  readonly parentSessionID: string | null;
  readonly agent: string | null;
  readonly sanitizedTitle: string;
  readonly kind: 'work' | 'system' | 'unknown';
  readonly observedAtMs: number;
  readonly children: readonly LineageNodeShape[];
};

const lineageNodeSchemaBase = z.object({
  sessionID: z.string().min(1),
  parentSessionID: z.string().nullable(),
  agent: z.string().nullable(),
  sanitizedTitle: z.string(),
  kind: z.enum(['work', 'system', 'unknown']),
  observedAtMs: z.number().nonnegative().finite(),
  children: z.array(z.lazy((): z.ZodType<LineageNodeShape> => lineageNodeSchema)),
}).strict();

export const lineageNodeSchema: z.ZodType<LineageNodeShape> = lineageNodeSchemaBase;

export const treeResponseSchema = z.object({
  tree: lineageNodeSchema,
}).strict();

export const eventSchema = sessionHistoryEventSchema;

export const pageSchema = z.object({
  events: z.array(eventSchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  newerCursor: z.string().min(1).optional(),
  resolvedRunID: z.string().optional(),
}).strict();

export const eventPageSchema = z.object({
  page: pageSchema,
}).strict();

export type EventPage = z.infer<typeof eventPageSchema>;

export function toBoundary(e: z.infer<typeof eventSchema>): { timestampMs: number; sessionID: string; runID: string; sequence: number } {
  return { timestampMs: e.timestampMs, sessionID: e.sessionID, runID: e.runID, sequence: e.sequence };
}

export function compareBoundaries(
  a: ReturnType<typeof toBoundary>,
  b: ReturnType<typeof toBoundary>
): number {
  if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
  if (a.sessionID !== b.sessionID) return a.sessionID.localeCompare(b.sessionID);
  if (a.runID !== b.runID) return a.runID.localeCompare(b.runID);
  return a.sequence - b.sequence;
}
