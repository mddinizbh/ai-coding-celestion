const clone = (value) => structuredClone(value);

const nextId = (prefix, items) => {
  const ids = new Set(items.map(({ id }) => id));
  let sequence = items.length + 1;
  while (ids.has(`${prefix}-${sequence}`)) sequence += 1;
  return `${prefix}-${sequence}`;
};

export const normalizeDiagram = (diagram) => ({
  version: 1,
  title: String(diagram.title || "Architecture Canvas"),
  groups: Array.isArray(diagram.groups) ? clone(diagram.groups) : [],
  nodes: Array.isArray(diagram.nodes) ? clone(diagram.nodes) : [],
  edges: Array.isArray(diagram.edges) ? clone(diagram.edges) : [],
});

export const createGroupFromNodes = (diagram, nodeIds, title = "Group") => {
  const selected = diagram.nodes.filter(({ id }) => nodeIds.includes(id));
  if (selected.length === 0) return clone(diagram);

  const padding = 40;
  const left = Math.min(...selected.map(({ x }) => x));
  const top = Math.min(...selected.map(({ y }) => y));
  const right = Math.max(...selected.map(({ x, w }) => x + w));
  const bottom = Math.max(...selected.map(({ y, h }) => y + h));
  const groupId = nextId("group", diagram.groups);
  const group = {
    id: groupId,
    title,
    x: left - padding,
    y: top - padding - 20,
    w: right - left + padding * 2,
    h: bottom - top + padding * 2 + 20,
    details: {},
  };

  return {
    ...clone(diagram),
    groups: [...clone(diagram.groups), group],
    nodes: diagram.nodes.map((node) => nodeIds.includes(node.id) ? { ...clone(node), groupId } : clone(node)),
  };
};

export const moveElement = (diagram, kind, id, dx, dy) => {
  const next = clone(diagram);
  if (kind === "node") {
    next.nodes = next.nodes.map((node) => node.id === id ? { ...node, x: node.x + dx, y: node.y + dy } : node);
    return next;
  }
  if (kind === "group") {
    next.groups = next.groups.map((group) => group.id === id ? { ...group, x: group.x + dx, y: group.y + dy } : group);
    next.nodes = next.nodes.map((node) => node.groupId === id ? { ...node, x: node.x + dx, y: node.y + dy } : node);
  }
  return next;
};

export const resizeElement = (diagram, target, size) => {
  const source = target.kind === "node" ? "nodes" : "groups";
  const minSize = target.kind === "node" ? { w: 96, h: 48 } : { w: 160, h: 120 };
  const nextSize = { w: Math.max(minSize.w, size.w), h: Math.max(minSize.h, size.h) };
  return {
    ...clone(diagram),
    [source]: diagram[source].map((item) => item.id === target.id ? { ...clone(item), ...nextSize } : clone(item)),
  };
};

export const connectNodes = (diagram, from, to) => {
  const nodeIds = new Set(diagram.nodes.map(({ id }) => id));
  if (from === to || !nodeIds.has(from) || !nodeIds.has(to)) return clone(diagram);
  const edge = {
    id: nextId("edge", diagram.edges),
    from,
    to,
    label: "calls",
    status: "bound",
    badge: { label: String(diagram.edges.length + 1), offsetX: 0, offsetY: 0 },
    details: {},
  };
  return { ...clone(diagram), edges: [...clone(diagram.edges), edge] };
};

export const setEdgeAnchor = (diagram, change) => ({
  ...clone(diagram),
  edges: diagram.edges.map((edge) => edge.id === change.edgeId
    ? { ...clone(edge), anchors: { ...edge.anchors, [change.endpoint]: change.anchor } }
    : clone(edge)),
});

export const alignNodes = (diagram, nodeIds, axis) => {
  const next = clone(diagram);
  const selected = next.nodes.filter(({ id }) => nodeIds.includes(id));
  if (selected.length < 2) return next;
  if (axis === "horizontal") {
    const targetY = Math.min(...selected.map(({ y }) => y));
    next.nodes = next.nodes.map((node) => nodeIds.includes(node.id) ? { ...node, y: targetY } : node);
  } else {
    const targetX = Math.min(...selected.map(({ x }) => x));
    next.nodes = next.nodes.map((node) => nodeIds.includes(node.id) ? { ...node, x: targetX } : node);
  }
  return next;
};

export const distributeNodes = (diagram, nodeIds, axis) => {
  const next = clone(diagram);
  const coordinate = axis === "horizontal" ? "x" : "y";
  const size = axis === "horizontal" ? "w" : "h";
  const selected = next.nodes
    .filter(({ id }) => nodeIds.includes(id))
    .sort((left, right) => left[coordinate] - right[coordinate]);
  if (selected.length < 3) return next;
  const firstCenter = selected[0][coordinate] + selected[0][size] / 2;
  const last = selected[selected.length - 1];
  const lastCenter = last[coordinate] + last[size] / 2;
  const step = (lastCenter - firstCenter) / (selected.length - 1);
  const positions = new Map(selected.map((node, index) => [node.id, firstCenter + step * index - node[size] / 2]));
  next.nodes = next.nodes.map((node) => positions.has(node.id) ? { ...node, [coordinate]: positions.get(node.id) } : node);
  return next;
};

export const addNode = (diagram, point) => {
  const node = {
    id: nextId("node", diagram.nodes),
    type: "service",
    title: "New component",
    subtitle: "double-click or use inspector",
    x: point.x - 80,
    y: point.y - 32,
    w: 160,
    h: 64,
    groupId: null,
    details: {},
  };
  return { ...clone(diagram), nodes: [...clone(diagram.nodes), node] };
};

export const removeSelection = (diagram, selection) => {
  const selected = new Set(selection.map(({ kind, id }) => `${kind}:${id}`));
  const removedNodes = new Set(diagram.nodes.filter(({ id }) => selected.has(`node:${id}`)).map(({ id }) => id));
  const removedGroups = new Set(diagram.groups.filter(({ id }) => selected.has(`group:${id}`)).map(({ id }) => id));
  return {
    ...clone(diagram),
    groups: diagram.groups.filter(({ id }) => !removedGroups.has(id)).map(clone),
    nodes: diagram.nodes
      .filter(({ id }) => !removedNodes.has(id))
      .map((node) => removedGroups.has(node.groupId) ? { ...clone(node), groupId: null } : clone(node)),
    edges: diagram.edges
      .filter(({ id, from, to }) => !selected.has(`edge:${id}`) && !removedNodes.has(from) && !removedNodes.has(to))
      .map(clone),
  };
};

export const createDiagramStore = (initial, storage = null) => {
  let state = normalizeDiagram(initial);
  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();

  const emit = () => {
    if (storage) storage.setItem("architecture-canvas", JSON.stringify(state));
    listeners.forEach((listener) => listener(clone(state)));
  };

  return {
    getState: () => clone(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update(mutator, recordHistory = true) {
      if (recordHistory) {
        undoStack.push(clone(state));
        redoStack.length = 0;
      }
      state = normalizeDiagram(mutator(clone(state)));
      emit();
    },
    checkpoint() {
      undoStack.push(clone(state));
      redoStack.length = 0;
    },
    replace(next, recordHistory = true) {
      if (recordHistory) undoStack.push(clone(state));
      state = normalizeDiagram(next);
      redoStack.length = 0;
      emit();
    },
    undo() {
      const previous = undoStack.pop();
      if (!previous) return;
      redoStack.push(clone(state));
      state = previous;
      emit();
    },
    redo() {
      const next = redoStack.pop();
      if (!next) return;
      undoStack.push(clone(state));
      state = next;
      emit();
    },
  };
};
