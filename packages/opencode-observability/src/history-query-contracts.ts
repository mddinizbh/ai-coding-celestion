import { z } from 'zod';
import type { SessionHistoryEvent } from './history-domain';
import type { LineageRootSummary, ScopeFailureCode } from './history-query';

export const EVENT_PAGE_LIMIT_MIN = 1;
export const EVENT_PAGE_LIMIT_MAX = 200;
export const EVENT_PAGE_LIMIT_DEFAULT = 200;

/**
 * Shape-level DTO schema for `listEvents` requests (strict: unknown keys rejected).
 * `limit` is deliberately only `number | undefined` here — the 1..200 integer
 * range is a typed `LIMIT_INVALID` failure produced by `listEvents` itself so
 * direct callers get the sanitized code instead of a schema error.
 */
export const listEventsInputSchema = z.object({
  rootSessionID: z.string().min(1),
  selectedSessionID: z.string().min(1),
  scope: z.enum(['session', 'subtree']),
  includeSystem: z.boolean(),
  direction: z.enum(['older', 'newer']).optional(),
  cursor: z.string().min(1).optional(),
  limit: z.number().optional()
}).strict();

export type ListEventsInput = z.infer<typeof listEventsInputSchema>;

export const projectBootstrapInputSchema = z.object({
  activeSessionID: z.string().min(1).nullable()
}).strict();

export type ProjectBootstrapInput = z.infer<typeof projectBootstrapInputSchema>;

export type ListEventsFailureCode =
  | ScopeFailureCode
  | 'LIMIT_INVALID'
  | 'DIRECTION_REQUIRED'
  | 'CURSOR_INVALID'
  | 'CURSOR_SCOPE_MISMATCH';

/** One ascending page of sanitized history events plus walk metadata. */
export interface HistoryEventPage {
  readonly events: readonly SessionHistoryEvent[];
  /** Initial/`older` pages: older events exist beyond this page. `newer` pages: newer events exist. */
  readonly hasMore: boolean;
  /** Present only while `hasMore` is true; `null` on the final or an empty page. */
  readonly nextCursor: string | null;
  /** `session` scope only, and only when ALL matching events share exactly one runID; otherwise omitted. */
  readonly resolvedRunID?: string;
}

export type ListEventsResult =
  | { readonly ok: true; readonly page: HistoryEventPage }
  | { readonly ok: false; readonly code: ListEventsFailureCode };

/** Initial dashboard state: visible roots, the active session's root, and a stream-resume cursor. */
export interface BootstrapProjection {
  readonly roots: readonly LineageRootSummary[];
  readonly activeRootSessionID: string | null;
  readonly cursor: string | null;
}
