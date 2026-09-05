/**
 * Framework-free DOM rendering for the Celestion History Dashboard.
 *
 * Consumes the pure browser state from state.js via its selectors and
 * renders into the static landmark elements declared by index.html.
 * Every visible string is produced through textContent, so event and
 * lineage data can never be parsed as markup. The module touches no DOM
 * at import time: all document access happens inside render functions.
 */
import { selectConnection, selectHasOlder, selectStatus, selectTimeline } from './state.js';

/** Characters kept from a session identifier in its short display form. */
const SESSION_ID_PREFIX = 8;
/** Maximum characters rendered for one metadata value before truncation. */
const META_VALUE_MAX = 120;
/** Canonical event fields that are never rendered as metadata chips. */
const CORE_EVENT_FIELDS = new Set(['eventID', 'runID', 'sessionID', 'sequence', 'timestampMs', 'type', 'agent']);

/**
 * Creates an element, optionally assigning one class and one text value.
 * @param {string} tag element tag name
 * @param {string} [className] class attribute value
 * @param {string} [text] text content, assigned via textContent only
 * @returns {HTMLElement}
 */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Removes every child of a container node.
 * @param {Element} node container to empty
 * @returns {void}
 */
function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * Shows or hides a landmark through the hidden attribute only.
 * @param {Element | null | undefined} node landmark element (may be absent)
 * @param {boolean} visible whether the landmark should be visible
 * @returns {void}
 */
function setVisible(node, visible) {
  if (!node) return;
  if (visible) node.removeAttribute('hidden');
  else node.setAttribute('hidden', '');
}

/**
 * Shortens a session identifier to its first eight characters plus an
 * ellipsis marker, for dense row display.
 * @param {string} sessionID full session identifier
 * @returns {string} short form safe for textContent
 */
export function shortSessionID(sessionID) {
  if (typeof sessionID !== 'string' || sessionID.length === 0) return '—';
  if (sessionID.length <= SESSION_ID_PREFIX) return sessionID;
  return sessionID.slice(0, SESSION_ID_PREFIX) + '…';
}

/**
 * Formats an event timestamp as a UTC clock reading (HH:MM:SS.mmm).
 * @param {number} timestampMs event timestamp in milliseconds since epoch
 * @returns {string} clock text or an em dash for non-finite input
 */
export function formatTimestamp(timestampMs) {
  if (!Number.isFinite(timestampMs)) return '—';
  return new Date(timestampMs).toISOString().slice(11, 23);
}

/**
 * Formats a coarse relative age between an event and a reference now.
 * @param {number} timestampMs event timestamp in milliseconds since epoch
 * @param {number} nowMs reference "now" in milliseconds since epoch
 * @returns {string} bucketed age such as "just now", "3m ago", "2h ago"
 */
export function formatRelative(timestampMs, nowMs) {
  const delta = nowMs - timestampMs;
  if (!Number.isFinite(delta) || delta < 1000) return 'just now';
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return seconds + 's ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes + 'm ago';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours + 'h ago';
  return Math.floor(hours / 24) + 'd ago';
}

/**
 * Collects a session-to-agent lookup from a lineage tree, walking nested
 * children recursively. Nodes without a usable agent label are skipped.
 * @param {object | null} tree lineage root node (sessionID/agent/children)
 * @returns {Map<string, string>} session identifier to agent label
 */
export function agentMapFromTree(tree) {
  const map = new Map();
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.sessionID === 'string' && typeof node.agent === 'string' && node.agent.length > 0) {
      map.set(node.sessionID, node.agent);
    }
    if (Array.isArray(node.children)) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);
  return map;
}

/**
 * Renders the connection badge: mode label plus consecutive failure note.
 * @param {Element} badge landmark with id "connection-badge"
 * @param {{ mode: 'sse' | 'polling', consecutiveFailures: number, pollIntervalMs: number }} connection
 * @returns {void}
 */
export function renderConnection(badge, connection) {
  const mode = connection && connection.mode === 'polling' ? 'polling' : 'sse';
  badge.setAttribute('data-mode', mode);
  const failures = connection && typeof connection.consecutiveFailures === 'number' ? connection.consecutiveFailures : 0;
  let text = mode === 'polling' ? 'Polling' : 'SSE';
  if (failures > 0) text += ' · ' + failures + ' failed';
  badge.textContent = text;
}

/**
 * Shows or hides the load-older landmark based on cursor availability.
 * @param {Element} button landmark with id "load-older"
 * @param {boolean} hasOlder whether an older-page cursor exists
 * @returns {void}
 */
export function renderLoadOlder(button, hasOlder) {
  setVisible(button, hasOlder === true);
}

/**
 * Syncs the system-sessions checkbox with the state flag without
 * clobbering an in-flight user interaction when values already match.
 * @param {HTMLInputElement} toggle checkbox landmark with id "toggle-system"
 * @param {boolean} includeSystem whether system sessions are included
 * @returns {void}
 */
export function renderSystemToggle(toggle, includeSystem) {
  const next = includeSystem === true;
  if (toggle.checked !== next) toggle.checked = next;
}

/**
 * Toggles the loading, empty and error landmarks for a dashboard status
 * through the hidden attribute and renders the sanitized error message.
 * @param {{ loading?: Element | null, empty?: Element | null, error?: Element | null, errorMessage?: Element | null }} blocks
 * @param {'loading' | 'ready' | 'empty' | 'error'} status
 * @param {string | null} [errorMessage] sanitized error message
 * @returns {void}
 */
export function renderStatus(blocks, status, errorMessage = null) {
  setVisible(blocks.loading, status === 'loading');
  setVisible(blocks.empty, status === 'empty');
  setVisible(blocks.error, status === 'error');
  if (blocks.errorMessage) {
    blocks.errorMessage.textContent = status === 'error' && typeof errorMessage === 'string' ? errorMessage : '';
  }
}

/**
 * Builds one lineage tree item recursively as nested list markup.
 * The row exposes a session button and a subtree button (both type
 * button) plus agent badge, short id and sanitized title; the selected
 * item carries aria-selected="true".
 * @param {object} node lineage node (sessionID, agent, sanitizedTitle, children)
 * @param {{ mode: 'all' | 'session' | 'subtree', sessionID: string | null }} selection
 * @returns {HTMLLIElement}
 */
function treeItem(node, selection) {
  const item = el('li', 'tree-item');
  item.setAttribute('role', 'treeitem');
  const selected =
    (selection.mode === 'session' || selection.mode === 'subtree') && selection.sessionID === node.sessionID;
  item.setAttribute('aria-selected', selected ? 'true' : 'false');
  const children = Array.isArray(node.children)
    ? node.children.filter((child) => child && typeof child.sessionID === 'string')
    : [];
  if (children.length > 0) item.setAttribute('aria-expanded', 'true');

  const short = shortSessionID(node.sessionID);
  const row = el('div', 'tree-row');

  const selectButton = el('button', 'tree-select');
  selectButton.type = 'button';
  selectButton.setAttribute('data-select', 'session');
  selectButton.setAttribute('data-session-id', node.sessionID);
  selectButton.setAttribute('aria-label', 'Select session ' + short);
  const agent = typeof node.agent === 'string' && node.agent.length > 0 ? node.agent : 'unknown';
  selectButton.appendChild(el('span', 'badge-agent', agent));
  selectButton.appendChild(el('span', 'tree-id', short));
  const title = typeof node.sanitizedTitle === 'string' && node.sanitizedTitle.length > 0 ? node.sanitizedTitle : 'Untitled';
  selectButton.appendChild(el('span', 'tree-title', title));
  row.appendChild(selectButton);

  const subtreeButton = el('button', 'tree-subtree', 'Subtree');
  subtreeButton.type = 'button';
  subtreeButton.setAttribute('data-select', 'subtree');
  subtreeButton.setAttribute('data-session-id', node.sessionID);
  subtreeButton.setAttribute('aria-label', 'Select subtree of ' + short);
  row.appendChild(subtreeButton);

  item.appendChild(row);
  if (children.length > 0) {
    const group = el('ul', 'tree-group');
    group.setAttribute('role', 'group');
    for (const child of children) group.appendChild(treeItem(child, selection));
    item.appendChild(group);
  }
  return item;
}

/**
 * Renderiza todas as árvores de sessões no mesmo painel, sem raiz artificial.
 * @param {Element} container landmark with id "tree" (ul, role tree)
 * @param {readonly object[]} trees raízes visíveis carregadas pelo cliente
 * @param {{ mode: 'all' | 'session' | 'subtree', sessionID: string | null }} selection
 * @returns {void}
 */
export function renderTree(container, trees, selection) {
  clear(container);
  const roots = Array.isArray(trees) ? trees.filter((tree) => tree && typeof tree.sessionID === 'string') : [];
  if (roots.length === 0) {
    container.appendChild(el('li', 'tree-empty', 'No sessions in scope.'));
    return;
  }
  for (const tree of roots) container.appendChild(treeItem(tree, selection));
}

/**
 * Builds one timeline row: event type, agent badge when known, short
 * session id, sanitized metadata chips, absolute and relative time.
 * Row order follows the caller's array, which is canonically ascending.
 * @param {object} event canonical history event
 * @param {number} nowMs reference now for the relative timestamp
 * @param {Map<string, string> | null} agents session-to-agent lookup
 * @returns {HTMLLIElement}
 */
function timelineRow(event, nowMs, agents) {
  const row = el('li', 'timeline-row');
  row.setAttribute('data-type', typeof event.type === 'string' && event.type.length > 0 ? event.type : 'unknown');
  row.appendChild(el('span', 'badge-type', row.getAttribute('data-type') || 'unknown'));

  let agent = typeof event.agent === 'string' && event.agent.length > 0 ? event.agent : null;
  if (agent === null && agents && typeof event.sessionID === 'string') {
    const mapped = agents.get(event.sessionID);
    if (typeof mapped === 'string' && mapped.length > 0) agent = mapped;
  }
  if (agent !== null) row.appendChild(el('span', 'badge-agent', agent));

  if (typeof event.sessionID === 'string') row.appendChild(el('span', 'session-id', shortSessionID(event.sessionID)));

  for (const [key, value] of Object.entries(event)) {
    if (CORE_EVENT_FIELDS.has(key)) continue;
    if (typeof value === 'string') {
      row.appendChild(el('span', 'meta', key + '=' + truncateValue(value)));
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      row.appendChild(el('span', 'meta', key + '=' + String(value)));
    } else if (typeof value === 'boolean') {
      row.appendChild(el('span', 'meta', key + '=' + (value ? 'true' : 'false')));
    }
  }

  if (Number.isFinite(event.timestampMs)) {
    const iso = new Date(event.timestampMs).toISOString();
    const time = el('time', 'event-time', formatTimestamp(event.timestampMs));
    time.setAttribute('datetime', iso);
    time.setAttribute('title', iso);
    row.appendChild(time);
    row.appendChild(el('span', 'event-relative', formatRelative(event.timestampMs, nowMs)));
  }
  return row;
}

/**
 * Truncates a metadata value to the display budget with an ellipsis.
 * @param {string} value sanitized metadata value
 * @returns {string}
 */
function truncateValue(value) {
  return value.length > META_VALUE_MAX ? value.slice(0, META_VALUE_MAX) + '…' : value;
}

/**
 * Renders the timeline rows in the given (canonically ascending) order,
 * newest last. Options may carry a deterministic nowMs for tests and a
 * session-to-agent lookup for badge rendering.
 * @param {Element} container landmark with id "timeline" (ol)
 * @param {readonly object[]} events canonical ascending history events
 * @param {{ nowMs?: number, agentBySession?: Map<string, string> | null }} [options]
 * @returns {void}
 */
export function renderTimeline(container, events, options = {}) {
  clear(container);
  const list = Array.isArray(events) ? events : [];
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const agents = options.agentBySession instanceof Map ? options.agentBySession : null;
  for (const event of list) {
    if (!event || typeof event !== 'object') continue;
    container.appendChild(timelineRow(event, nowMs, agents));
  }
}

/**
 * Renders the whole dashboard from one state snapshot into the static
 * landmarks found under root. Missing landmarks are skipped, so partial
 * mounts stay safe. Reads exclusively through the state.js selectors.
 * @param {Element | Document} root element (or document) containing landmarks
 * @param {object} state dashboard state from createDashboardState/reducer
 * @param {{ nowMs?: number }} [options] deterministic clock for tests
 * @returns {void}
 */
export function renderApp(root, state, options = {}) {
  const find = (id) => {
    const node = root.querySelector('#' + id);
    return node;
  };

  const status = selectStatus(state);
  const events = selectTimeline(state);

  const badge = find('connection-badge');
  if (badge) renderConnection(badge, selectConnection(state));

  const toggle = find('toggle-system');
  if (toggle) renderSystemToggle(toggle, state.includeSystem);

  const allButton = find('select-all');
  if (allButton) allButton.setAttribute('aria-pressed', state.selection.mode === 'all' ? 'true' : 'false');

  const treeBox = find('tree');
  if (treeBox) renderTree(treeBox, state.trees, state.selection);

  const count = find('timeline-count');
  if (count) count.textContent = String(events.length) + (events.length === 1 ? ' event' : ' events');

  const timelineBox = find('timeline');
  if (timelineBox) {
    const agents = new Map(state.trees.flatMap((tree) => [...agentMapFromTree(tree)]));
    renderTimeline(timelineBox, events, { nowMs: options.nowMs, agentBySession: agents });
  }

  renderStatus(
    {
      loading: find('state-loading'),
      empty: find('state-empty'),
      error: find('state-error'),
      errorMessage: find('error-message')
    },
    status,
    state.errorMessage
  );

  const treeLoading = find('tree-loading');
  if (treeLoading) setVisible(treeLoading, status === 'loading');

  const older = find('load-older');
  if (older) renderLoadOlder(older, selectHasOlder(state));
}
