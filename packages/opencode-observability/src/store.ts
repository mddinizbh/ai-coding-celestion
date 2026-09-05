import type { Run, ModelCall, ContextSnapshotRecord, SkillEvent, LoadedSkill } from './domain';
import { compareTimelineRecords } from './persisted-records';

export interface Store {
  recordRun(run: Run): Promise<void>;
  setActiveRun(sessionID: string, runID: string): Promise<void>;
  clearActiveRun(sessionID: string): Promise<void>;
  recordModelCall(call: ModelCall): Promise<void>;
  recordContextSnapshot(snap: ContextSnapshotRecord): Promise<void>;
  recordSkillEvent(ev: SkillEvent): Promise<void>;
  getTimeline(runID: string): Promise<ReadonlyArray<ContextSnapshotRecord | ModelCall | SkillEvent>>;
  getModelCalls(runID: string): Promise<ReadonlyArray<ModelCall>>;
  getContextSnapshots(runID: string): Promise<ReadonlyArray<ContextSnapshotRecord>>;
  getLoadedSkills(runID: string): Promise<ReadonlyArray<LoadedSkill>>;
  getActiveRun(sessionID: string): Promise<Run | null>;
  getLatestRun(sessionID: string): Promise<Run | null>;
}

export class InMemoryStore implements Store {
  private runs = new Map<string, Run>();
  private modelCalls = new Map<string, ModelCall[]>();
  private contextSnaps = new Map<string, ContextSnapshotRecord[]>();
  private skillEvents = new Map<string, SkillEvent[]>();
  private activeRunBySession = new Map<string, string>();
  private latestRunBySession = new Map<string, string>();

  async recordRun(run: Run): Promise<void> {
    this.runs.set(run.runID, run);
    this.latestRunBySession.set(run.sessionID, run.runID);
  }

  async setActiveRun(sessionID: string, runID: string): Promise<void> {
    this.activeRunBySession.set(sessionID, runID);
  }

  async clearActiveRun(sessionID: string): Promise<void> {
    this.activeRunBySession.delete(sessionID);
  }

  async recordModelCall(call: ModelCall): Promise<void> {
    const arr = this.modelCalls.get(call.runID) ?? [];
    arr.push(call);
    arr.sort((a, b) => a.sequence - b.sequence);
    this.modelCalls.set(call.runID, arr);
  }

  async recordContextSnapshot(snap: ContextSnapshotRecord): Promise<void> {
    const arr = this.contextSnaps.get(snap.runID) ?? [];
    arr.push(snap);
    arr.sort((a, b) => a.sequence - b.sequence);
    this.contextSnaps.set(snap.runID, arr);
  }

  async recordSkillEvent(ev: SkillEvent): Promise<void> {
    const arr = this.skillEvents.get(ev.runID) ?? [];
    arr.push(ev);
    this.skillEvents.set(ev.runID, arr);
  }

  async getTimeline(runID: string): Promise<ReadonlyArray<ContextSnapshotRecord | ModelCall | SkillEvent>> {
    const snaps = this.contextSnaps.get(runID) ?? [];
    const calls = this.modelCalls.get(runID) ?? [];
    const skills = this.skillEvents.get(runID) ?? [];
    const all: (ContextSnapshotRecord | ModelCall | SkillEvent)[] = [...snaps, ...calls, ...skills];
    all.sort(compareTimelineRecords);
    return all;
  }

  async getModelCalls(runID: string): Promise<ReadonlyArray<ModelCall>> {
    return this.modelCalls.get(runID) ?? [];
  }

  async getContextSnapshots(runID: string): Promise<ReadonlyArray<ContextSnapshotRecord>> {
    return this.contextSnaps.get(runID) ?? [];
  }

  async getLoadedSkills(runID: string): Promise<ReadonlyArray<LoadedSkill>> {
    const events = this.skillEvents.get(runID) ?? [];
    const bySkill = new Map<string, { name: string; count: number; first: number }>();
    for (const ev of events) {
      const key = ev.skillID;
      const curr = bySkill.get(key);
      if (!curr) {
        bySkill.set(key, { name: ev.skillName, count: 1, first: ev.created });
      } else {
        curr.count++;
      }
    }
    return Array.from(bySkill.entries()).map(([id, v]) => ({
      skillID: id,
      skillName: v.name,
      loadCount: v.count,
      firstLoadedAt: v.first
    }));
  }

  async getActiveRun(sessionID: string): Promise<Run | null> {
    const rid = this.activeRunBySession.get(sessionID);
    return rid ? this.runs.get(rid) ?? null : null;
  }

  async getLatestRun(sessionID: string): Promise<Run | null> {
    const rid = this.latestRunBySession.get(sessionID);
    return rid ? this.runs.get(rid) ?? null : null;
  }
}
