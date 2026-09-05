export type RunStatus = 'active' | 'succeeded' | 'failed' | 'interrupted';

export interface Run {
  readonly runID: string;
  readonly sessionID: string;
  readonly startedAt: number;
  readonly status: RunStatus;
  readonly agent: string | null;
  readonly project: string | null;
  readonly repo: string | null;
  readonly gitRevision: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly endAt: number | null;
}

export interface ModelCall {
  readonly runID: string;
  readonly sessionID: string;
  readonly sequence: number;
  readonly agent: string;
  readonly provider: string;
  readonly model: string;
  readonly timestamp: number;
}

export interface ContextComponentSizes {
  readonly systemBytes: number;
  readonly messagesBytes: number;
  readonly toolsBytes: number;
  readonly generationBytes: number | null;
  readonly providerOptionsBytes: number | null;
  readonly hookEventBytes: number;
}

export interface ContextSnapshotRecord extends ContextComponentSizes {
  readonly runID: string;
  readonly sessionID: string;
  readonly sequence: number;
  readonly systemCount: number;
  readonly messageCount: number;
  readonly toolCount: number;
  readonly timestamp: number;
}

export type SkillEventType = 'LOADED';

export interface SkillEvent {
  readonly eventID: string;
  readonly runID: string;
  readonly sessionID: string;
  readonly skillID: string;
  readonly skillName: string;
  readonly created: number;
  readonly eventType: SkillEventType;
  readonly loadCount?: number;
  readonly firstLoadedAt?: number;
}

export interface LoadedSkill {
  readonly skillID: string;
  readonly skillName: string;
  readonly loadCount: number;
  readonly firstLoadedAt: number;
}
