/** Browser poll cadence used after SSE is considered unhealthy. */
export const POLL_INTERVAL_MS = 2000;

/** Maximum canonical events retained by the browser store. */
export const MAX_CANONICAL_EVENTS = 1000;

/** Number of consecutive SSE failures that switches the client to polling. */
export const SSE_FAILURE_THRESHOLD = 3;

/**
 * @typedef {'loading' | 'ready' | 'empty' | 'error'} DashboardStatus
 * @typedef {'sse' | 'polling'} ConnectionMode
 * @typedef {'all' | 'session' | 'subtree'} SelectionMode
 * @typedef {{ eventID: string, runID: string, sessionID: string, sequence: number, timestampMs: number, type: string }} HistoryEvent
 * @typedef {{ events: readonly HistoryEvent[], hasMore: boolean, nextCursor: string | null, resolvedRunID?: string }} HistoryEventPage
 * @typedef {{ sessionID: string, sanitizedTitle?: string, agent?: string | null, kind?: string, observedAtMs?: number }} LineageRootSummary
 * @typedef {{ sessionID: string, children?: readonly LineageNode[] }} LineageNode
 * @typedef {{ mode: SelectionMode, sessionID: string | null }} SelectionState
 * @typedef {{ mode: ConnectionMode, consecutiveFailures: number, pollIntervalMs: number }} ConnectionState
 * @typedef {{ events: readonly HistoryEvent[], roots: readonly LineageRootSummary[], tree: LineageNode | null, subtreeSessionIDs: readonly string[], selection: SelectionState, includeSystem: boolean, olderCursor: string | null, newerCursor: string | null, status: DashboardStatus, connection: ConnectionState, errorMessage: string | null }} DashboardState
 * @typedef {{ type: 'bootstrapStarted' }} BootstrapStartedAction
 * @typedef {{ type: 'bootstrapReady', roots: readonly LineageRootSummary[], tree: LineageNode | null, subtreeSessionIDs: readonly string[], page: HistoryEventPage }} BootstrapReadyAction
 * @typedef {{ type: 'pageAppended', page: HistoryEventPage, cursor?: string | null }} PageAppendedAction
 * @typedef {{ type: 'streamEvent', event: HistoryEvent }} StreamEventAction
 * @typedef {{ type: 'streamFailure' }} StreamFailureAction
 * @typedef {{ type: 'streamSuccess' }} StreamSuccessAction
 * @typedef {{ type: 'reloadRequested' }} ReloadRequestedAction
 * @typedef {{ type: 'selectionChanged', mode: SelectionMode, sessionID?: string | null }} SelectionChangedAction
 * @typedef {{ type: 'includeSystemChanged', includeSystem: boolean }} IncludeSystemChangedAction
 * @typedef {{ type: 'errorEntered', message: string }} ErrorEnteredAction
 * @typedef {BootstrapStartedAction | BootstrapReadyAction | PageAppendedAction | StreamEventAction | StreamFailureAction | StreamSuccessAction | ReloadRequestedAction | SelectionChangedAction | IncludeSystemChangedAction | ErrorEnteredAction} DashboardAction
 */

const emptyConnection = Object.freeze({ mode: 'sse', consecutiveFailures: 0, pollIntervalMs: POLL_INTERVAL_MS });

/**
 * Creates the immutable initial dashboard state with no events, all selection, and an SSE attempt.
 * @returns {DashboardState}
 */
export function createDashboardState() {
  return {
    events: [],
    roots: [],
    tree: null,
    subtreeSessionIDs: [],
    selection: { mode: 'all', sessionID: null },
    includeSystem: false,
    olderCursor: null,
    newerCursor: null,
    status: 'loading',
    connection: emptyConnection,
    errorMessage: null
  };
}

/**
 * Applies one pure dashboard action without mutating the prior state or action payloads.
 * @param {DashboardState} state
 * @param {DashboardAction} action
 * @returns {DashboardState}
 */
export function dashboardReducer(state, action) {
  switch (action.type) {
    case 'bootstrapStarted':
      return loadingState(state);
    case 'bootstrapReady': {
      const events = mergeEvents([], action.page.events);
      return {
        ...resetTransport(state),
        events,
        roots: [...action.roots],
        tree: action.tree,
        subtreeSessionIDs: [...action.subtreeSessionIDs],
        olderCursor: action.page.nextCursor,
        newerCursor: null,
        status: statusFor(events),
        errorMessage: null
      };
    }
    case 'pageAppended': {
      const events = mergeEvents(state.events, action.page.events);
      return {
        ...state,
        events,
        olderCursor: action.page.nextCursor,
        newerCursor: Object.hasOwn(action, 'cursor') ? action.cursor ?? null : state.newerCursor,
        status: statusFor(events),
        errorMessage: null
      };
    }
    case 'streamEvent': {
      const events = mergeEvents(state.events, [action.event]);
      return { ...state, events, status: 'ready', errorMessage: null };
    }
    case 'streamFailure': {
      const consecutiveFailures = state.connection.consecutiveFailures + 1;
      return { ...state, connection: connectionFor(consecutiveFailures) };
    }
    case 'streamSuccess':
      return { ...state, connection: emptyConnection };
    case 'reloadRequested':
      return loadingState(state);
    case 'selectionChanged':
      return { ...loadingState(state), selection: { mode: action.mode, sessionID: action.sessionID ?? null } };
    case 'includeSystemChanged':
      return { ...loadingState(state), includeSystem: action.includeSystem };
    case 'errorEntered':
      return { ...state, status: 'error', errorMessage: action.message };
    default:
      return state;
  }
}

/**
 * Returns canonical ascending events filtered by the current selection state.
 * @param {DashboardState} state
 * @returns {readonly HistoryEvent[]}
 */
export function selectTimeline(state) {
  switch (state.selection.mode) {
    case 'all':
      return state.events;
    case 'session':
      return state.events.filter((event) => event.sessionID === state.selection.sessionID);
    case 'subtree': {
      const members = new Set(state.subtreeSessionIDs);
      return state.events.filter((event) => members.has(event.sessionID));
    }
    default:
      return state.events;
  }
}

/**
 * Returns the dashboard loading/ready/empty/error status.
 * @param {DashboardState} state
 * @returns {DashboardStatus}
 */
export function selectStatus(state) {
  return state.status;
}

/**
 * Returns the connection mode, consecutive SSE failures, and polling cadence.
 * @param {DashboardState} state
 * @returns {ConnectionState}
 */
export function selectConnection(state) {
  return state.connection;
}

/**
 * Returns whether an older-page cursor is available.
 * @param {DashboardState} state
 * @returns {boolean}
 */
export function selectHasOlder(state) {
  return state.olderCursor !== null;
}

/** @param {DashboardState} state @returns {DashboardState} */
function loadingState(state) {
  return { ...resetTransport(state), olderCursor: null, newerCursor: null, status: 'loading', errorMessage: null };
}

/** @param {DashboardState} state @returns {DashboardState} */
function resetTransport(state) {
  return { ...state, connection: emptyConnection };
}

/** @param {readonly HistoryEvent[]} events @returns {DashboardStatus} */
function statusFor(events) {
  return events.length === 0 ? 'empty' : 'ready';
}

/** @param {number} consecutiveFailures @returns {ConnectionState} */
function connectionFor(consecutiveFailures) {
  return { mode: consecutiveFailures >= SSE_FAILURE_THRESHOLD ? 'polling' : 'sse', consecutiveFailures, pollIntervalMs: POLL_INTERVAL_MS };
}

/** @param {readonly HistoryEvent[]} current @param {readonly HistoryEvent[]} incoming @returns {readonly HistoryEvent[]} */
function mergeEvents(current, incoming) {
  const byID = new Map(current.map((event) => [event.eventID, event]));
  for (const event of incoming) {
    byID.set(event.eventID, event);
  }
  return [...byID.values()].sort(compareEvents).slice(-MAX_CANONICAL_EVENTS);
}

/** @param {HistoryEvent} a @param {HistoryEvent} b @returns {number} */
function compareEvents(a, b) {
  return compareNumber(a.timestampMs, b.timestampMs) || compareString(a.sessionID, b.sessionID) || compareString(a.runID, b.runID) || compareNumber(a.sequence, b.sequence);
}

/** @param {number} a @param {number} b @returns {number} */
function compareNumber(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** @param {string} a @param {string} b @returns {number} */
function compareString(a, b) {
  return a === b ? 0 : a < b ? -1 : 1;
}
