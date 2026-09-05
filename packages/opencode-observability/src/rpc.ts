import { Rpc } from '@opencode-ai/plugin';
import { OverviewInputSchema, OverviewReadModelSchema } from './overview-read-model';
import { DebugInputSchema, DebugReadModelSchema } from './debug-read-model';

export type { InvalidOverviewInputError, OverviewInput, OverviewReadModel } from './overview-read-model';
export { parseOverviewInput, readOverview, OverviewInputSchema, OverviewReadModelSchema } from './overview-read-model';
export type { DebugInput, DebugContextComponents, DebugTimelineItem, DebugReadModel } from './debug-read-model';
export { readDebug, DebugInputSchema, DebugContextComponentsSchema, DebugTimelineItemSchema, DebugReadModelSchema } from './debug-read-model';

export const overviewDefinition = Rpc.define({
  id: 'celestion-observability',
  methods: {
    getOverview: { input: OverviewInputSchema, output: OverviewReadModelSchema },
    getDebug: { input: DebugInputSchema, output: DebugReadModelSchema }
  },
  events: {}
});
