import { z } from 'zod';
import { hasValidHistoryScope, historyScopeShape } from './history-scope';

export const HISTORY_CURSOR_VERSION = 1 as const;

const nonEmptyString = z.string().min(1);
const nonNegInt = z.number().int().nonnegative();
const nonNegFinite = z.number().nonnegative().finite();

export const historyCursorBoundarySchema = z.object({
  timestampMs: nonNegFinite,
  sessionID: nonEmptyString,
  runID: nonEmptyString,
  sequence: nonNegInt
}).strict();

export const historyCursorContextSchema = z.object({
  ...historyScopeShape,
  direction: z.enum(['older', 'newer'])
}).strict().refine(hasValidHistoryScope);

export const historyCursorPayloadSchema = historyCursorContextSchema.safeExtend({
  version: z.literal(HISTORY_CURSOR_VERSION),
  boundary: historyCursorBoundarySchema
}).strict();

export type HistoryCursorBoundary = z.infer<typeof historyCursorBoundarySchema>;
export type HistoryCursorContext = z.infer<typeof historyCursorContextSchema>;
export type HistoryCursorPayload = z.infer<typeof historyCursorPayloadSchema>;

export type CursorDecodeFailure = { readonly ok: false; readonly code: 'CURSOR_INVALID' };
export type DecodeHistoryCursorResult =
  | { readonly ok: true; readonly value: HistoryCursorPayload }
  | CursorDecodeFailure;

export type CheckHistoryCursorCompatibilityResult =
  | { readonly ok: true; readonly value: HistoryCursorPayload }
  | { readonly ok: false; readonly code: 'CURSOR_SCOPE_MISMATCH' };

const invalidCursorResult: CursorDecodeFailure = { ok: false, code: 'CURSOR_INVALID' } as const;
const scopeMismatchResult = { ok: false, code: 'CURSOR_SCOPE_MISMATCH' } as const;

export function encodeHistoryCursor(payload: HistoryCursorPayload): string {
  return Buffer.from(JSON.stringify(canonicalPayload(payload)), 'utf8').toString('base64url');
}

export function decodeHistoryCursor(token: string): DecodeHistoryCursorResult {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    return invalidCursorResult;
  }

  const json = Buffer.from(token, 'base64url').toString('utf8');
  const parsedJson = parseJson(json);
  if (!parsedJson.ok) {
    return invalidCursorResult;
  }

  const parsedPayload = historyCursorPayloadSchema.safeParse(parsedJson.value);
  if (!parsedPayload.success) {
    return invalidCursorResult;
  }

  return { ok: true, value: parsedPayload.data };
}

export function checkCompatibility(
  cursor: HistoryCursorPayload,
  context: HistoryCursorContext
): CheckHistoryCursorCompatibilityResult {
  const compatible = cursor.rootSessionID === context.rootSessionID
    && cursor.selectedSessionID === context.selectedSessionID
    && cursor.scope === context.scope
    && cursor.includeSystem === context.includeSystem
    && cursor.direction === context.direction;

  return compatible ? { ok: true, value: cursor } : scopeMismatchResult;
}

export function compareBoundaries(a: HistoryCursorBoundary, b: HistoryCursorBoundary): number {
  return compareNumber(a.timestampMs, b.timestampMs)
    || compareString(a.sessionID, b.sessionID)
    || compareString(a.runID, b.runID)
    || compareNumber(a.sequence, b.sequence);
}

function parseJson(json: string): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(json) };
  } catch {
    return { ok: false };
  }
}

function canonicalPayload(payload: HistoryCursorPayload): HistoryCursorPayload {
  return {
    version: payload.version,
    rootSessionID: payload.rootSessionID,
    selectedSessionID: payload.selectedSessionID,
    scope: payload.scope,
    includeSystem: payload.includeSystem,
    direction: payload.direction,
    boundary: {
      timestampMs: payload.boundary.timestampMs,
      sessionID: payload.boundary.sessionID,
      runID: payload.boundary.runID,
      sequence: payload.boundary.sequence
    }
  };
}

function compareNumber(a: number, b: number): number {
  return a === b ? 0 : a - b;
}

function compareString(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  return a > b ? 1 : 0;
}
