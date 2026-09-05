// Barrel re-export for Task 19 acceptance (keeps import path stable, all helpers <250 LOC)
export {
  AcceptanceStorageFake,
  makeAcceptancePersistence,
  makeAcceptanceQueryService,
  makeAcceptanceServer,
  stopServer,
  FIXTURE,
} from './history-dashboard-fixtures-core';
export {
  lineageRootSummarySchema,
  bootstrapSchema,
  rootsResponseSchema,
  lineageNodeSchema,
  treeResponseSchema,
  eventSchema,
  pageSchema,
  eventPageSchema,
  toBoundary,
  compareBoundaries,
  type LineageNodeShape,
  type EventPage,
} from './history-dashboard-fixtures-schema';
export {
  fetchJSON,
  collectSSE,
  extractToken,
  expectConnectionRefused,
  canRebind,
  type SSEEvent,
  sseEventSchema,
} from './history-dashboard-fixtures-sse';
