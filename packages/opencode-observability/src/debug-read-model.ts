import type { Store } from './store';
import { z } from 'zod';
import { OverviewReadModelSchema, readOverview } from './overview-read-model';
import type { OverviewReadModel } from './overview-read-model';

const DebugInputSchema = z.object({ sessionID: z.string() });

const DebugContextComponentsSchema = z.object({
  systemBytes: z.number(),
  messagesBytes: z.number(),
  toolsBytes: z.number(),
  generationBytes: z.number().nullable(),
  providerOptionsBytes: z.number().nullable(),
  hookEventBytes: z.number(),
  systemCount: z.number(),
  messageCount: z.number(),
  toolCount: z.number()
});

const DebugTimelineSnapshotSchema = z.object({
  type: z.literal('snapshot'),
  timestamp: z.number(),
  sequence: z.number().nullable(),
  systemBytes: z.number(),
  messagesBytes: z.number(),
  toolsBytes: z.number(),
  generationBytes: z.number().nullable(),
  providerOptionsBytes: z.number().nullable(),
  hookEventBytes: z.number(),
  systemCount: z.number(),
  messageCount: z.number(),
  toolCount: z.number()
});
const DebugTimelineModelSchema = z.object({
  type: z.literal('model'),
  timestamp: z.number(),
  sequence: z.number().nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  agent: z.string().nullable()
});
const DebugTimelineSkillSchema = z.object({
  type: z.literal('skill'),
  timestamp: z.number(),
  sequence: z.number().nullable(),
  skillName: z.string()
});
const DebugTimelineItemSchema = z.discriminatedUnion('type', [
  DebugTimelineSnapshotSchema,
  DebugTimelineModelSchema,
  DebugTimelineSkillSchema
]);

const DebugReadModelSchema = z.object({
  overview: OverviewReadModelSchema,
  contextComponents: DebugContextComponentsSchema.nullable(),
  loadedSkills: z.array(z.object({ skillID: z.string(), skillName: z.string(), loadCount: z.number(), firstLoadedAt: z.number().nullable() })).readonly(),
  timeline: z.array(DebugTimelineItemSchema).readonly()
});

export interface DebugInput {
  readonly sessionID: string;
}

export interface DebugContextComponents {
  readonly systemBytes: number;
  readonly messagesBytes: number;
  readonly toolsBytes: number;
  readonly generationBytes: number | null;
  readonly providerOptionsBytes: number | null;
  readonly hookEventBytes: number;
  readonly systemCount: number;
  readonly messageCount: number;
  readonly toolCount: number;
}

export type DebugTimelineItem =
  | { readonly type: 'snapshot'; readonly timestamp: number; readonly sequence: number | null; readonly systemBytes: number; readonly messagesBytes: number; readonly toolsBytes: number; readonly generationBytes: number | null; readonly providerOptionsBytes: number | null; readonly hookEventBytes: number; readonly systemCount: number; readonly messageCount: number; readonly toolCount: number }
  | { readonly type: 'model'; readonly timestamp: number; readonly sequence: number | null; readonly provider: string | null; readonly model: string | null; readonly agent: string | null }
  | { readonly type: 'skill'; readonly timestamp: number; readonly sequence: number | null; readonly skillName: string };

export interface DebugReadModel {
  readonly overview: OverviewReadModel;
  readonly contextComponents: DebugContextComponents | null;
  readonly loadedSkills: ReadonlyArray<{ readonly skillID: string; readonly skillName: string; readonly loadCount: number; readonly firstLoadedAt: number | null }>;
  readonly timeline: ReadonlyArray<DebugTimelineItem>;
}

export async function readDebug(store: Store, input: DebugInput, clock: () => number = Date.now): Promise<DebugReadModel> {
  const overview = await readOverview(store, input, clock);
  if (!overview.runID) {
    return { overview, contextComponents: null, loadedSkills: [], timeline: [] };
  }
  const snaps = await store.getContextSnapshots(overview.runID);
  const skills = await store.getLoadedSkills(overview.runID);
  const timelineRaw = await store.getTimeline(overview.runID);
  const latest = snaps.length > 0 ? snaps.at(-1) ?? null : null;
  const contextComponents: DebugContextComponents | null = latest ? {
    systemBytes: latest.systemBytes,
    messagesBytes: latest.messagesBytes,
    toolsBytes: latest.toolsBytes,
    generationBytes: latest.generationBytes,
    providerOptionsBytes: latest.providerOptionsBytes,
    hookEventBytes: latest.hookEventBytes,
    systemCount: latest.systemCount,
    messageCount: latest.messageCount,
    toolCount: latest.toolCount
  } : null;
  const loadedSkills = skills.map(s => ({ skillID: s.skillID, skillName: s.skillName, loadCount: s.loadCount, firstLoadedAt: s.firstLoadedAt ?? null }));
  const timeline: DebugTimelineItem[] = [];
  for (const ev of timelineRaw) {
    if ('hookEventBytes' in ev) timeline.push({ type: 'snapshot', timestamp: ev.timestamp, sequence: ev.sequence, systemBytes: ev.systemBytes, messagesBytes: ev.messagesBytes, toolsBytes: ev.toolsBytes, generationBytes: ev.generationBytes, providerOptionsBytes: ev.providerOptionsBytes, hookEventBytes: ev.hookEventBytes, systemCount: ev.systemCount, messageCount: ev.messageCount, toolCount: ev.toolCount });
    else if ('provider' in ev) timeline.push({ type: 'model', timestamp: ev.timestamp, sequence: ev.sequence, provider: ev.provider ?? null, model: ev.model ?? null, agent: ev.agent ?? null });
    else timeline.push({ type: 'skill', timestamp: ev.created, sequence: null, skillName: ev.skillName });
  }
  timeline.sort((a, b) => a.timestamp - b.timestamp);
  const recentTimeline = timeline.slice(-20);
  return { overview, contextComponents, loadedSkills, timeline: recentTimeline };
}

export { DebugInputSchema, DebugContextComponentsSchema, DebugTimelineItemSchema, DebugReadModelSchema };
