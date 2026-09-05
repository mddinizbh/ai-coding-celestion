import type { SessionHistoryEventDraft, SessionLineage } from './history-domain';

export type PromptInput = { readonly text: string; readonly files?: readonly unknown[]; readonly agents?: readonly unknown[]; readonly skills?: readonly unknown[] };
export type SessionPrompt = { readonly sessionID: string; readonly messageID: string; readonly prompt: PromptInput; readonly delivery: string; readonly metadata?: Record<string, unknown> };
export type SessionContext = { readonly sessionID: string; readonly agent: string; readonly model: { readonly id?: string; readonly providerID?: string }; readonly system: readonly unknown[]; readonly messages: readonly unknown[]; readonly tools: Record<string, unknown>; readonly generation: unknown; readonly providerOptions: Record<string, unknown> };
export type SessionModelRequest = { readonly sessionID: string; readonly model?: { readonly id?: string; readonly providerID?: string }; readonly headers?: Record<string, string> };
export type SessionRetry = { readonly sessionID: string; readonly attempt: number; readonly error?: { readonly message?: string } };
export type ToolBefore = { readonly sessionID: string; readonly id: string; readonly tool?: string; readonly input?: unknown };
export type ToolAfter = { readonly sessionID: string; readonly id: string; readonly status?: string; readonly result?: unknown; readonly error?: { readonly message?: string } };
export type PermissionEval = { readonly sessionID: string; readonly action: string; readonly effect: string; readonly resources?: readonly string[] };
export type SkillLoaded = { readonly runID: string; readonly sessionID: string; readonly skillID: string; readonly skillName: string };
export type SafeErrorCode = 'NORMALIZATION_FAILED' | 'SERIALIZATION_FAILED';
export type ErrorSanitized = { readonly sessionID: string; readonly code: SafeErrorCode };

export type HistoryObserverDiagnosticCode = 'NORMALIZATION_FAILED';

export interface InjectedClock {
  readonly now: () => number;
}

export type PersistencePort = {
  append(i: { readonly draft: SessionHistoryEventDraft; readonly upstreamEventID?: string | undefined }): unknown;
  recordLineage(l: SessionLineage): void;
  deleteLineage(sessionID: string): void;
  finishRun(runID: string): void;
};
