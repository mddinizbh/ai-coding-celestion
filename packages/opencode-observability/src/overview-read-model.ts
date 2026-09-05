import type { Store } from './store';
import { z } from 'zod';

export class InvalidOverviewInputError extends Error {
  readonly code = 'INVALID_OVERVIEW_INPUT';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidOverviewInputError';
  }
}

export interface OverviewInput {
  readonly sessionID: string;
}

export interface OverviewReadModel {
  readonly runID: string | null;
  readonly sessionID: string;
  readonly agent: string | null;
  readonly project: string | null;
  readonly repository: string | null;
  readonly gitRevision: string | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly startedAt: number | null;
  readonly finishedAt: number | null;
  readonly durationMs: number | null;
  readonly status: string | null;
  readonly modelCalls: number | null;
  readonly latestContextSizeBytes: number | null;
  readonly loadedSkills: number | null;
}

const OverviewInputSchema = z.object({
  sessionID: z.string()
});

const OverviewReadModelSchema = z.object({
  runID: z.string().nullable(),
  sessionID: z.string(),
  agent: z.string().nullable(),
  project: z.string().nullable(),
  repository: z.string().nullable(),
  gitRevision: z.string().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.number().nullable(),
  finishedAt: z.number().nullable(),
  durationMs: z.number().nullable(),
  status: z.string().nullable(),
  modelCalls: z.number().nullable(),
  latestContextSizeBytes: z.number().nullable(),
  loadedSkills: z.number().nullable()
});

export function parseOverviewInput(input: unknown): OverviewInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new InvalidOverviewInputError('input must be object');
  }
  if (!('sessionID' in input) || typeof input.sessionID !== 'string') {
    throw new InvalidOverviewInputError('sessionID must be string');
  }
  return { sessionID: input.sessionID };
}

export async function readOverview(
  store: Store,
  input: OverviewInput,
  clock: () => number = Date.now
): Promise<OverviewReadModel> {
  const run = (await store.getActiveRun(input.sessionID)) ?? (await store.getLatestRun(input.sessionID));
  if (!run) {
    return {
      runID: null,
      sessionID: input.sessionID,
      agent: null,
      project: null,
      repository: null,
      gitRevision: null,
      provider: null,
      model: null,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      status: null,
      modelCalls: null,
      latestContextSizeBytes: null,
      loadedSkills: null
    };
  }
  const calls = await store.getModelCalls(run.runID);
  const snaps = await store.getContextSnapshots(run.runID);
  const skills = await store.getLoadedSkills(run.runID);
  const latest = snaps.length > 0 ? snaps.at(-1) ?? null : null;
  const latestContextSizeBytes = latest ? latest.hookEventBytes : null;
  const finishedAt = run.endAt ?? null;
  const durationMs = finishedAt !== null
    ? finishedAt - run.startedAt
    : clock() - run.startedAt;
  return {
    runID: run.runID,
    sessionID: run.sessionID,
    agent: run.agent ?? null,
    project: run.project ?? null,
    repository: run.repo ?? null,
    gitRevision: run.gitRevision ?? null,
    provider: run.provider ?? null,
    model: run.model ?? null,
    startedAt: run.startedAt,
    finishedAt,
    durationMs,
    status: run.status,
    modelCalls: calls.length,
    latestContextSizeBytes,
    loadedSkills: skills.length
  };
}

export { OverviewInputSchema, OverviewReadModelSchema };
