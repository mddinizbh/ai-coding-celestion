import type { StorageDomain } from '@opencode-ai/plugin/promise/storage';
import type { Run, ModelCall, ContextSnapshotRecord, SkillEvent, LoadedSkill } from './domain';
import type { Store } from './store';
import {
  compareTimelineRecords,
  parseContextSnapshot,
  parseModelCall,
  parseRun,
  parseRunPointer,
  parseSkillEvent
} from './persisted-records';

type ScanResult = Awaited<ReturnType<StorageDomain['scan']>>;

export class StorageAdapter implements Store {
  constructor(private readonly storage: StorageDomain) {}

  private kRun(id: string) { return `run/${id}`; }
  private kActive(sid: string) { return `active/${sid}`; }
  private kLatest(sid: string) { return `latest/${sid}`; }
  private kCtx(rid: string, seq: number) { return `context/${rid}/${seq.toString().padStart(6,'0')}`; }
  private kModel(rid: string, seq: number) { return `model/${rid}/${seq.toString().padStart(6,'0')}`; }
  private kSkill(rid: string, created: number, eid: string) { return `skill/${rid}/${created}/${eid}`; }

  async recordRun(run: Run): Promise<void> {
    const runJson = {
      runID: run.runID,
      sessionID: run.sessionID,
      startedAt: run.startedAt,
      status: run.status,
      agent: run.agent,
      project: run.project,
      repo: run.repo,
      gitRevision: run.gitRevision,
      provider: run.provider,
      model: run.model,
      endAt: run.endAt
    };
    await this.storage.set(this.kRun(run.runID), runJson);
    const latestJson = { runID: run.runID };
    await this.storage.set(this.kLatest(run.sessionID), latestJson);
  }

  async setActiveRun(sessionID: string, runID: string): Promise<void> {
    const activeJson = { runID };
    await this.storage.set(this.kActive(sessionID), activeJson);
  }

  async clearActiveRun(sessionID: string): Promise<void> {
    await this.storage.remove(this.kActive(sessionID));
  }

  async recordModelCall(call: ModelCall): Promise<void> {
    const callJson = {
      runID: call.runID,
      sessionID: call.sessionID,
      sequence: call.sequence,
      agent: call.agent,
      provider: call.provider,
      model: call.model,
      timestamp: call.timestamp
    };
    await this.storage.set(this.kModel(call.runID, call.sequence), callJson);
  }

  async recordContextSnapshot(snap: ContextSnapshotRecord): Promise<void> {
    const snapJson = {
      runID: snap.runID,
      sessionID: snap.sessionID,
      sequence: snap.sequence,
      systemBytes: snap.systemBytes,
      messagesBytes: snap.messagesBytes,
      toolsBytes: snap.toolsBytes,
      generationBytes: snap.generationBytes,
      providerOptionsBytes: snap.providerOptionsBytes,
      hookEventBytes: snap.hookEventBytes,
      systemCount: snap.systemCount,
      messageCount: snap.messageCount,
      toolCount: snap.toolCount,
      timestamp: snap.timestamp
    };
    await this.storage.set(this.kCtx(snap.runID, snap.sequence), snapJson);
  }

  async recordSkillEvent(ev: SkillEvent): Promise<void> {
    const evJson = {
      eventID: ev.eventID,
      runID: ev.runID,
      sessionID: ev.sessionID,
      skillID: ev.skillID,
      skillName: ev.skillName,
      created: ev.created,
      eventType: ev.eventType
    };
    await this.storage.set(this.kSkill(ev.runID, ev.created, ev.eventID), evJson);
  }

  async getTimeline(runID: string): Promise<ReadonlyArray<ContextSnapshotRecord | ModelCall | SkillEvent>> {
    const ctxRes: ScanResult = await this.storage.scan({ prefix: `context/${runID}/` });
    const snaps = ctxRes.entries.map((entry) => parseContextSnapshot(entry.value)).filter((value): value is ContextSnapshotRecord => value !== null);

    const mRes: ScanResult = await this.storage.scan({ prefix: `model/${runID}/` });
    const models = mRes.entries.map((entry) => parseModelCall(entry.value)).filter((value): value is ModelCall => value !== null);

    const sRes: ScanResult = await this.storage.scan({ prefix: `skill/${runID}/` });
    const skills = sRes.entries.map((entry) => parseSkillEvent(entry.value)).filter((value): value is SkillEvent => value !== null);

    const all = [...snaps, ...models, ...skills];
    all.sort(compareTimelineRecords);
    return all;
  }

  async getModelCalls(runID: string): Promise<ReadonlyArray<ModelCall>> {
    const res: ScanResult = await this.storage.scan({ prefix: `model/${runID}/` });
    return res.entries
      .map((entry) => parseModelCall(entry.value))
      .filter((value): value is ModelCall => value !== null)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getContextSnapshots(runID: string): Promise<ReadonlyArray<ContextSnapshotRecord>> {
    const res: ScanResult = await this.storage.scan({ prefix: `context/${runID}/` });
    return res.entries
      .map((entry) => parseContextSnapshot(entry.value))
      .filter((value): value is ContextSnapshotRecord => value !== null)
      .sort((a, b) => a.sequence - b.sequence);
  }

  async getLoadedSkills(runID: string): Promise<ReadonlyArray<LoadedSkill>> {
    const res: ScanResult = await this.storage.scan({ prefix: `skill/${runID}/` });
    const events = res.entries
      .map((entry) => parseSkillEvent(entry.value))
      .filter((value): value is SkillEvent => value !== null);
    const by = new Map<string, { name: string; count: number; first: number }>();
    for (const ev of events) {
      const c = by.get(ev.skillID) ?? { name: ev.skillName, count: 0, first: ev.created };
      c.count++;
      if (ev.created < c.first) c.first = ev.created;
      by.set(ev.skillID, c);
    }
    return Array.from(by.entries()).map(([id, v]) => ({ skillID: id, skillName: v.name, loadCount: v.count, firstLoadedAt: v.first }));
  }

  async getActiveRun(sessionID: string): Promise<Run | null> {
    const ptr = await this.storage.get(this.kActive(sessionID));
    const rid = parseRunPointer(ptr);
    if (rid === null) return null;
    const runV = await this.storage.get(this.kRun(rid));
    return parseRun(runV);
  }

  async getLatestRun(sessionID: string): Promise<Run | null> {
    const ptr = await this.storage.get(this.kLatest(sessionID));
    const rid = parseRunPointer(ptr);
    if (rid === null) return null;
    const runV = await this.storage.get(this.kRun(rid));
    return parseRun(runV);
  }
}
