import { POLL_INTERVAL_MS, SSE_FAILURE_THRESHOLD, createDashboardState, dashboardReducer } from './state.js';
import { renderApp } from './render.js';

const GENERIC_ERROR = 'Dashboard unavailable.';
const ACCESS_ERROR = 'Acesso ao dashboard indisponível. Reabra com /celestion-history no OpenCode.';
const SERVER_ERROR = 'Não foi possível conectar ao servidor local. Tente novamente ou reabra com /celestion-history.';
const TOKEN_STORAGE_KEY = 'celestion-history-token';

/**
 * @typedef {{ hash: string, pathname: string, search: string }} ClientLocation
 * @typedef {{ setTimeout: Function, setInterval: Function, clearInterval: Function }} ClientTimers
 * @typedef {import('./state.js').DashboardState} DashboardState
 * @typedef {{ fetch: Function, location: ClientLocation, history: { replaceState: Function }, timers: ClientTimers, sessionStorage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, root?: Element | null, requestAnimationFrame?: Function, renderApp?: Function }} DashboardClientDeps
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
  let requestController = null;
  let forestRefresh = null;
  let pollingSignal = null;
  let pollTimer = null;
  let retryTimer = null;
  const render = deps.renderApp || renderApp;

  const commit = (action) => {
    state = dashboardReducer(state, action);
    if (deps.root || deps.renderApp) render(deps.root || null, state);
  };
  const headers = () => ({ Authorization: 'Bearer ' + token });
  const clean = () => {
    if (requestController) requestController.abort();
    requestController = null;
    if (streamController) streamController.abort();
    streamController = null;
    if (pollTimer !== null) deps.timers.clearInterval(pollTimer);
    if (retryTimer !== null) deps.timers.clearInterval(retryTimer);
    pollTimer = null;
    retryTimer = null;
  };
  const fail = (message = state.errorMessage || GENERIC_ERROR) => { commit({ type: 'errorEntered', message }); };
  const accessDenied = () => {
    token = '';
    clean();
    try { deps.sessionStorage?.removeItem(TOKEN_STORAGE_KEY); } catch { /* Storage pode estar bloqueado. */ }
    fail(ACCESS_ERROR);
  };

  const requestJson = async (url, signal) => {
    let response;
    try {
      response = await deps.fetch(url, { headers: headers(), signal });
    } catch {
      if (!signal?.aborted) fail(SERVER_ERROR);
      return null;
    }
    if (signal?.aborted) return null;
    if (response?.status === 401) {
      accessDenied();
      return null;
    }
    if (!response || response.ok !== true || typeof response.json !== 'function') return null;
    try {
      const value = await response.json();
      return signal?.aborted ? null : value;
    } catch {
      return null;
    }
  };

  const scopeQuery = () => new URLSearchParams(state.selection.mode === 'all'
    ? { scope: 'all', includeSystem: String(state.includeSystem) }
    : { rootSessionID: rootSessionID || '', selectedSessionID: activeSessionID || '', scope: state.selection.mode, includeSystem: String(state.includeSystem) });
  const eventsUrl = (direction, cursor) => {
    const query = scopeQuery();
    if (direction) query.set('direction', direction);
    if (cursor) query.set('cursor', cursor);
    query.set('limit', '200');
    return '/events?' + query.toString();
  };
  const streamUrl = () => {
    const query = scopeQuery();
    if (latestCursor) query.set('cursor', latestCursor);
    return '/events/stream?' + query.toString();
  };
  const preorder = (node) => {
    if (!node || typeof node.sessionID !== 'string') return [];
    const children = Array.isArray(node.children) ? node.children.flatMap(preorder) : [];
    return [node.sessionID, ...children];
  };
  const findNode = (node, sessionID) => {
    if (node.sessionID === sessionID) return node;
    for (const child of node.children || []) {
      const found = findNode(child, sessionID);
      if (found) return found;
    }
    return null;
  };
  const selectedMembers = (trees) => state.selection.mode === 'all'
    ? trees.flatMap(preorder)
    : trees.flatMap((tree) => preorder(findNode(tree, state.selection.sessionID)));
  const loadForest = async (signal) => {
    const filter = '?includeSystem=' + String(state.includeSystem);
    const body = await requestJson('/sessions/roots' + filter, signal);
    if (!body || !Array.isArray(body.roots)) return null;
    const roots = body.roots;
    if (roots.some((root) => typeof root.sessionID !== 'string')) return null;
    const bodies = await Promise.all(roots.map((root) => requestJson('/sessions/' + encodeURIComponent(root.sessionID) + '/tree' + filter, signal)));
    if (signal.aborted || bodies.some((body, index) => body?.tree?.sessionID !== roots[index].sessionID)) return null;
    return { roots, trees: bodies.map((body) => body.tree) };
  };
  const refreshForest = async () => {
    const signal = requestController?.signal;
    if (!signal || signal.aborted) return;
    if (forestRefresh?.signal === signal) {
      forestRefresh.pending = true;
      return;
    }
    const refresh = { signal, pending: false };
    forestRefresh = refresh;
    try {
      do {
        refresh.pending = false;
        const forest = await loadForest(signal);
        if (signal.aborted) return;
        if (!forest) return fail();
        commit({ type: 'forestUpdated', ...forest, subtreeSessionIDs: selectedMembers(forest.trees) });
      } while (refresh.pending);
    } finally {
      if (forestRefresh === refresh) forestRefresh = null;
    }
  };
  const reconcileForest = (events) => events.some((event) => !state.trees.some((tree) => findNode(tree, event.sessionID)))
    ? refreshForest()
    : Promise.resolve();

  const bootstrap = async (action) => {
    clean();
    commit(action);
    if (!token) return accessDenied();
    const controller = new AbortController();
    requestController = controller;
    const signal = controller.signal;
    latestCursor = null;
    const forest = await loadForest(signal);
    if (signal.aborted) return;
    if (!forest) return fail();
    activeSessionID = state.selection.sessionID;
    const root = forest.trees.find((tree) => findNode(tree, activeSessionID));
    rootSessionID = root?.sessionID || null;
    if (state.selection.mode !== 'all' && !root) {
      activeSessionID = null;
      commit({ type: 'selectionChanged', mode: 'all' });
    }
    const page = await requestJson(eventsUrl(null, null), signal);
    if (signal.aborted) return;
    if (!page || !Array.isArray(page.events)) return fail();
    latestCursor = typeof page.newerCursor === 'string' ? page.newerCursor : null;
    commit({ type: 'bootstrapReady', ...forest, subtreeSessionIDs: selectedMembers(forest.trees), page });
    await Promise.all([openStream(), reconcileForest(page.events)]);
  };

  const openStream = async () => {
    if (!requestController || requestController.signal.aborted || !token) return;
    if (streamController) streamController.abort();
    const controller = new AbortController();
    streamController = controller;
    let response;
    try {
      response = await deps.fetch(streamUrl(), { headers: headers(), signal: controller.signal });
    } catch {
      if (!controller.signal.aborted) streamFailed();
      return;
    }
    if (controller.signal.aborted) return;
    if (response?.status === 401) return accessDenied();
    if (!response || response.ok !== true || !response.body || typeof response.body.getReader !== 'function') return streamFailed();
    void readSse(response.body.getReader(), controller.signal);
  };

  const readSse = async (reader, signal) => {
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (signal.aborted) return;
        if (chunk.done) return streamFailed();
        buffer += decoder.decode(chunk.value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() || '';
        for (const frame of frames) acceptFrame(frame);
      }
    } catch {
      if (!signal.aborted) streamFailed();
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
      acceptEvent(payload.event);
    } catch (error) {
      if (error instanceof SyntaxError) return;
      return;
    }
  };
  const acceptEvent = (event) => {
    commit({ type: 'streamEvent', event });
    void reconcileForest([event]);
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
    const signal = requestController?.signal;
    if (!signal || signal.aborted || pollingSignal === signal) return;
    pollingSignal = signal;
    try {
      const page = await requestJson(eventsUrl('newer', latestCursor), signal);
      if (signal.aborted) return;
      if (!page || !Array.isArray(page.events)) return fail();
      if (typeof page.newerCursor === 'string') latestCursor = page.newerCursor;
      for (const event of page.events) acceptEvent(event);
      commit({ type: 'pollSuccess' });
    } finally {
      if (pollingSignal === signal) pollingSignal = null;
    }
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
      try {
        if (token) deps.sessionStorage?.setItem(TOKEN_STORAGE_KEY, token);
        else token = deps.sessionStorage?.getItem(TOKEN_STORAGE_KEY) || '';
      } catch { /* A URL de lançamento funciona mesmo sem armazenamento na aba. */ }
      bind();
      if (token.length === 0) return accessDenied();
      await bootstrap({ type: 'bootstrapStarted' });
    },
    stop: () => { clean(); },
    getState: () => state,
    loadOlder: async () => {
      const signal = requestController?.signal;
      if (!state.olderCursor || !signal || signal.aborted) return;
      const page = await requestJson(eventsUrl('older', state.olderCursor), signal);
      if (signal.aborted) return;
      if (!page || !Array.isArray(page.events)) return fail();
      commit({ type: 'pageAppended', page });
      await reconcileForest(page.events);
    },
    setIncludeSystem: async (includeSystem) => reset({ type: 'includeSystemChanged', includeSystem }),
    selectAll: async () => reset({ type: 'selectionChanged', mode: 'all' }),
    selectSession: async (sessionID) => reset({ type: 'selectionChanged', mode: 'session', sessionID }),
    selectSubtree: async (sessionID) => reset({ type: 'selectionChanged', mode: 'subtree', sessionID }),
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
    get sessionStorage() { return globalThis.sessionStorage; },
    timers: { setTimeout: setTimeout.bind(globalThis), setInterval: setInterval.bind(globalThis), clearInterval: clearInterval.bind(globalThis) },
    root: document.getElementById('dashboard-root')
  });
  return client.start();
}

if (typeof document !== 'undefined') void startDashboard();
