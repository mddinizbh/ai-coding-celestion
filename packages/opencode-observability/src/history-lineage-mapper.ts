import type { SessionLineage } from './history-domain';
import { sanitizeSessionTitle } from './title-sanitizer';

export function buildSessionLineage(input: { readonly sessionID: string; readonly parentID?: string | null; readonly agent?: string | null; readonly title?: string }, observedAtMs: number): SessionLineage {
  const kind: SessionLineage['kind'] = (input.agent === 'title' || input.agent === 'summary' || input.agent === 'compaction') ? 'system' : (input.agent ? 'work' : 'unknown');
  return {
    sessionID: input.sessionID,
    parentSessionID: input.parentID ?? null,
    agent: input.agent ?? null,
    sanitizedTitle: sanitizeSessionTitle(input.title ?? ''),
    kind,
    observedAtMs
  } satisfies SessionLineage;
}
