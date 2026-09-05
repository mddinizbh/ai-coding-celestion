import { z } from 'zod';

/** all não tem âncora; session/subtree exigem raiz e seleção explícitas. */
export const historyScopeShape = {
  rootSessionID: z.string().min(1).optional(),
  selectedSessionID: z.string().min(1).optional(),
  scope: z.enum(['all', 'session', 'subtree']),
  includeSystem: z.boolean()
};

export function hasValidHistoryScope(input: {
  readonly scope: string;
  readonly rootSessionID?: string | undefined;
  readonly selectedSessionID?: string | undefined;
}): boolean {
  return input.scope === 'all'
    ? input.rootSessionID === undefined && input.selectedSessionID === undefined
    : (input.scope === 'session' || input.scope === 'subtree')
      && typeof input.rootSessionID === 'string' && input.rootSessionID.length > 0
      && typeof input.selectedSessionID === 'string' && input.selectedSessionID.length > 0;
}
