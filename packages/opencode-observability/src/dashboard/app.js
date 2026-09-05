import { POLL_INTERVAL_MS, SSE_FAILURE_THRESHOLD, createDashboardState, dashboardReducer } from './state.js';
import { renderApp } from './render.js';

const GENERIC_ERROR = 'Dashboard unavailable.';

/**
 * @typedef {{ hash: string, pathname: string, search: string }} ClientLocation
 * @typedef {{ setTimeout: Function, setInterval: Function, clearInterval: Function }} ClientTimers
 * @typedef {import('./state.js').DashboardState} DashboardState
 * @typedef {{ fetch: Function, location: ClientLocation, history: { replaceState: Function }, timers: ClientTimers, root?: Element | null, requestAnimationFrame?: Function, renderApp?: Function }} DashboardClientDeps
 */

/**
 * Creates an authenticated dashboard client with all browser effects injected.
 * @param {DashboardClientDeps} deps injected browser, fetch, timer and render seams
 * @returns {{ start(): Promise<void>, stop(): void, getState(): DashboardState, loadOlder(): Promise<void>, setIncludeSystem(includeSystem: boolean): Promise<void>, selectAll(): Promise<void>, selectSession(sessionID: string): Promise<void>, selectSubtree(sessionID: string): Promise<void>, reload(): Promise<void> }}
 */
export function createDashboardClient(deps) {
  let token = '';
  let state = createDashboardState();
  let rootSessionID = null;
  let activeSessionID = null;
  let latestCursor = null;
  let streamController = null;
  let pollTimer = null;
  let retryTimer = null;
  const render = deps.renderApp || renderApp;

  const commit = (action) => {
    state = dashboardReducer(state, action);
    if (deps.root || deps.renderApp) render(deps.root || null, state);
  };
  const headers = () => ({ Authorization: 'Bearer ' + token });
  const clean = () => {
    if (streamController) streamController.abort();
    streamController = null;
    if (pollTimer !== null) deps.timers.clearInterval(pollTimer);
    if (retryTimer !== null) deps.timers.clearInterval(retryTimer);
    pollTimer = null;
    retryTimer = null;
  };
  const fail = () => { commit({ type: 'errorEntered', message: GENERIC_ERROR }); };

  const requestJson = async (url, signal) => {
    const response = await deps.fetch(url, { headers: headers(), signal });
    if (!response || response.ok !== true || typeof response.json !== 'function') return null;
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      return null;
    }
  };

  const eventsUrl = (direction, cursor) => {
    const query = new URLSearchParams({ rootSessionID: rootSessionID || '', selectedSessionID: activeSessionID || '', scope: scope(), includeSystem: String(state.includeSystem) });
    if (direction) query.set('direction', direction);
    if (cursor) query.set('cursor', cursor);
    query.set('limit', '200');
    return '/events?' + query.toString();
  };
  const streamUrl = () => {
    const query = new URLSearchParams({ rootSessionID: rootSessionID || '', selectedSessionID: activeSessionID || '', scope: scope(), includeSystem: String(state.includeSystem) });
    if (latestCursor) query.set('cursor', latestCursor);
    return '/events/stream?' + query.toString();
  };
  const scope = () => (state.selection.mode === 'session' ? 'session' : 'subtree');
  const preorder = (node) => {
    if (!node || typeof node.sessionID !== 'string') return [];
    const children = Array.isArray(node.children) ? node.children.flatMap(preorder) : [];
    return [node.sessionID, ...children];
  };

  const bootstrap = async (action) => {
    clean();
    commit(action);
    const boot = await requestJson('/bootstrap');
    if (!boot) return fail();
    const roots = Array.isArray(boot.roots) ? boot.roots : [];
    const newestRoot = roots.at(-1);
    const hasActiveRoot = typeof boot.activeRootSessionID === 'string';
    rootSessionID = hasActiveRoot
      ? boot.activeRootSessionID
      : typeof newestRoot?.sessionID === 'string' ? newestRoot.sessionID : null;
    if (rootSessionID === null) return fail();
    activeSessionID = state.selection.sessionID || rootSessionID;
    latestCursor = hasActiveRoot && typeof boot.cursor === 'string' ? boot.cursor : null;
    const encoded = encodeURIComponent(rootSessionID);
    const treeBody = await requestJson('/sessions/' + encoded + '/tree?includeSystem=' + String(state.includeSystem));
    const page = await requestJson(eventsUrl(null, null));
    if (!treeBody || !page || !Array.isArray(page.events)) return fail();
    commit({ type: 'bootstrapReady', roots, tree: treeBody.tree || null, subtreeSessionIDs: preorder(treeBody.tree), page });
    await openStream();
  };

  const openStream = async () => {
    if (!rootSessionID || !activeSessionID) return;
    if (streamController) streamController.abort();
    streamController = new AbortController();
    let response;
    try {
      response = await deps.fetch(streamUrl(), { headers: headers(), signal: streamController.signal });
    } catch (error) {
      if (error instanceof Error) return streamFailed();
      return streamFailed();
    }
    if (!response || response.ok !== true || !response.body || typeof response.body.getReader !== 'function') return streamFailed();
    void readSse(response.body.getReader());
  };

  const readSse = async (reader) => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return streamFailed();
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) acceptFrame(frame);
      }
    } catch (error) {
      if (error instanceof Error) streamFailed();
      else streamFailed();
    }
  };

  const acceptFrame = (frame) => {
    const line = frame.split('\n').find((item) => item.startsWith('data:'));
    if (!line) return;
    try {
      const payload = JSON.parse(line.slice(5).trim());
      if (!payload || typeof payload.cursor !== 'string' || !payload.event) return;
      latestCursor = payload.cursor;
      commit({ type: 'streamSuccess' });
      commit({ type: 'streamEvent', event: payload.event });
    } catch (error) {
      if (error instanceof SyntaxError) return;
      return;
    }
  };

  const streamFailed = () => {
    commit({ type: 'streamFailure' });
    if (state.connection.consecutiveFailures >= SSE_FAILURE_THRESHOLD) startPolling();
    else retryTimer = deps.timers.setTimeout(() => { void openStream(); }, 0);
  };
  const startPolling = () => {
    if (pollTimer !== null) return;
    pollTimer = deps.timers.setInterval(() => { void poll(); }, POLL_INTERVAL_MS);
  };
  const poll = async () => {
    const page = await requestJson(eventsUrl('newer', latestCursor));
    if (!page || !Array.isArray(page.events)) return fail();
    if (typeof page.nextCursor === 'string') latestCursor = page.nextCursor;
    for (const event of page.events) commit({ type: 'streamEvent', event });
    commit({ type: 'streamSuccess' });
  };
  const reset = async (action) => bootstrap(action);

  const bind = () => {
    const root = deps.root;
    if (!root || typeof root.addEventListener !== 'function') return;
    root.addEventListener('click', (event) => {
      const target = event.target;
      const button = target && typeof target.closest === 'function' ? target.closest('button') : null;
      if (!button) return;
      void handleButton(button);
    });
    root.addEventListener('change', (event) => {
      const target = event.target;
      if (target && target.id === 'toggle-system') void api.setIncludeSystem(target.checked === true);
    });
  };
  const handleButton = async (button) => {
    if (button.id === 'load-older') return api.loadOlder();
    if (button.id === 'retry') return api.reload();
    const mode = button.dataset ? button.dataset.select : null;
    if (button.id === 'select-all' || mode === 'all') return api.selectAll();
    if (mode === 'session' && button.dataset.sessionId) return api.selectSession(button.dataset.sessionId);
    if (mode === 'subtree' && button.dataset.sessionId) return api.selectSubtree(button.dataset.sessionId);
  };

  const api = {
    start: async () => {
      token = deps.location.hash.slice(1);
      deps.history.replaceState(null, '', deps.location.pathname + deps.location.search);
      bind();
      if (token.length === 0) return fail();
      await bootstrap({ type: 'bootstrapStarted' });
    },
    stop: () => { clean(); },
    getState: () => state,
    loadOlder: async () => {
      if (!state.olderCursor) return;
      const page = await requestJson(eventsUrl('older', state.olderCursor));
      if (!page || !Array.isArray(page.events)) return fail();
      commit({ type: 'pageAppended', page });
    },
    setIncludeSystem: async (includeSystem) => reset({ type: 'includeSystemChanged', includeSystem }),
    selectAll: async () => { activeSessionID = rootSessionID; await reset({ type: 'selectionChanged', mode: 'all' }); },
    selectSession: async (sessionID) => { activeSessionID = sessionID; await reset({ type: 'selectionChanged', mode: 'session', sessionID }); },
    selectSubtree: async (sessionID) => { activeSessionID = sessionID; await reset({ type: 'selectionChanged', mode: 'subtree', sessionID }); },
    reload: async () => reset({ type: 'reloadRequested' })
  };
  return api;
}

/** Starts the dashboard against real browser globals. @returns {Promise<void>} */
export function startDashboard() {
  const client = createDashboardClient({
    fetch: fetch.bind(globalThis),
    location,
    history,
    timers: { setTimeout: setTimeout.bind(globalThis), setInterval: setInterval.bind(globalThis), clearInterval: clearInterval.bind(globalThis) },
    root: document.getElementById('dashboard-root')
  });
  return client.start();
}

if (typeof document !== 'undefined') void startDashboard();
