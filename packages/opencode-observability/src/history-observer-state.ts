

export class HistoryObserverState {
  private readonly lastAgentBySession = new Map<string, string | null>();
  private readonly toolStartByKey = new Map<string, { readonly startMs: number; readonly name: string | null }>();

  constructor() {}

  getLastAgent(sessionID: string): string | null {
    return this.lastAgentBySession.get(sessionID) ?? null;
  }

  hasAgent(sessionID: string): boolean {
    return this.lastAgentBySession.has(sessionID);
  }

  setLastAgent(sessionID: string, agent: string | null): void {
    this.lastAgentBySession.set(sessionID, agent);
  }

  recordToolStart(runID: string, callID: string, name: string | null, observationTs: number): void {
    const key = `${runID}:${callID}`;
    this.toolStartByKey.set(key, { startMs: observationTs, name });
  }

  getToolDuration(runID: string, callID: string, observationTs: number): { durationMs: number | null; orphan: boolean; name?: string | null } {
    const key = `${runID}:${callID}`;
    const started = this.toolStartByKey.get(key);
    const durationMs = started ? Math.max(0, observationTs - started.startMs) : null;
    const orphan = started == null;
    if (started) this.toolStartByKey.delete(key);
    return { durationMs, orphan, name: started?.name ?? null };
  }
}
