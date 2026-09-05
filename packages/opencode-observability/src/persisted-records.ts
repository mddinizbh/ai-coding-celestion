import type { ContextSnapshotRecord, ModelCall, Run, SkillEvent } from './domain';

export type TimelineRecord = ContextSnapshotRecord | ModelCall | SkillEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function parseRunPointer(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const runID = value['runID'];
  return typeof runID === 'string' ? runID : null;
}

export function parseRun(value: unknown): Run | null {
  if (!isRecord(value)) return null;
  const runID = value['runID'];
  const sessionID = value['sessionID'];
  const startedAt = value['startedAt'];
  const status = value['status'];
  const agent = value['agent'];
  const project = value['project'];
  const repo = value['repo'];
  const gitRevision = value['gitRevision'];
  const provider = value['provider'];
  const model = value['model'];
  const endAt = value['endAt'];
  if (typeof runID !== 'string' || typeof sessionID !== 'string' || typeof startedAt !== 'number') return null;
  if (status !== 'active' && status !== 'succeeded' && status !== 'failed' && status !== 'interrupted') return null;
  if (agent !== null && typeof agent !== 'string') return null;
  if (project !== null && typeof project !== 'string') return null;
  if (repo !== null && typeof repo !== 'string') return null;
  if (gitRevision !== null && typeof gitRevision !== 'string') return null;
  if (provider !== null && typeof provider !== 'string') return null;
  if (model !== null && typeof model !== 'string') return null;
  if (endAt !== null && typeof endAt !== 'number') return null;
  return { runID, sessionID, startedAt, status, agent, project, repo, gitRevision, provider, model, endAt };
}

export function parseModelCall(value: unknown): ModelCall | null {
  if (!isRecord(value)) return null;
  const runID = value['runID'];
  const sessionID = value['sessionID'];
  const sequence = value['sequence'];
  const agent = value['agent'];
  const provider = value['provider'];
  const model = value['model'];
  const timestamp = value['timestamp'];
  if (
    typeof runID !== 'string' || typeof sessionID !== 'string' || typeof sequence !== 'number' ||
    typeof agent !== 'string' || typeof provider !== 'string' || typeof model !== 'string' ||
    typeof timestamp !== 'number'
  ) return null;
  return { runID, sessionID, sequence, agent, provider, model, timestamp };
}

export function parseContextSnapshot(value: unknown): ContextSnapshotRecord | null {
  if (!isRecord(value)) return null;
  const runID = value['runID'];
  const sessionID = value['sessionID'];
  const sequence = value['sequence'];
  const systemBytes = value['systemBytes'];
  const messagesBytes = value['messagesBytes'];
  const toolsBytes = value['toolsBytes'];
  const generationBytes = value['generationBytes'];
  const providerOptionsBytes = value['providerOptionsBytes'];
  const hookEventBytes = value['hookEventBytes'];
  const systemCount = value['systemCount'];
  const messageCount = value['messageCount'];
  const toolCount = value['toolCount'];
  const timestamp = value['timestamp'];
  if (
    typeof runID !== 'string' || typeof sessionID !== 'string' || typeof sequence !== 'number' ||
    typeof systemBytes !== 'number' || typeof messagesBytes !== 'number' || typeof toolsBytes !== 'number' ||
    typeof hookEventBytes !== 'number' || typeof systemCount !== 'number' || typeof messageCount !== 'number' ||
    typeof toolCount !== 'number' || typeof timestamp !== 'number'
  ) return null;
  if (generationBytes !== null && typeof generationBytes !== 'number') return null;
  if (providerOptionsBytes !== null && typeof providerOptionsBytes !== 'number') return null;
  return {
    runID, sessionID, sequence, systemBytes, messagesBytes, toolsBytes, generationBytes,
    providerOptionsBytes, hookEventBytes, systemCount, messageCount, toolCount, timestamp
  };
}

export function parseSkillEvent(value: unknown): SkillEvent | null {
  if (!isRecord(value)) return null;
  const eventID = value['eventID'];
  const runID = value['runID'];
  const sessionID = value['sessionID'];
  const skillID = value['skillID'];
  const skillName = value['skillName'];
  const created = value['created'];
  const eventType = value['eventType'];
  if (
    typeof eventID !== 'string' || typeof runID !== 'string' || typeof sessionID !== 'string' ||
    typeof skillID !== 'string' || typeof skillName !== 'string' || typeof created !== 'number' ||
    eventType !== 'LOADED'
  ) return null;
  return { eventID, runID, sessionID, skillID, skillName, created, eventType };
}

function recordTime(record: TimelineRecord): number {
  return 'timestamp' in record ? record.timestamp : record.created;
}

function recordKind(record: TimelineRecord): string {
  if ('systemBytes' in record) return 'context';
  return 'eventID' in record ? 'skill' : 'model';
}

function recordOrder(record: TimelineRecord): number | string {
  return 'sequence' in record ? record.sequence : record.eventID;
}

export function compareTimelineRecords(left: TimelineRecord, right: TimelineRecord): number {
  const timeDifference = recordTime(left) - recordTime(right);
  if (timeDifference !== 0) return timeDifference;
  const kindDifference = recordKind(left).localeCompare(recordKind(right));
  if (kindDifference !== 0) return kindDifference;
  return String(recordOrder(left)).localeCompare(String(recordOrder(right)));
}
