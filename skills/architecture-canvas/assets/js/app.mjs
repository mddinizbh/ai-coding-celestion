import {
  addNode,
  alignNodes,
  connectNodes,
  createDiagramStore,
  createGroupFromNodes,
  distributeNodes,
  moveElement,
  normalizeDiagram,
  removeSelection,
  resizeElement,
  setEdgeAnchor,
} from "./model.mjs";
import { anchorForPoint, diagramBounds, validateDiagram } from "./geometry.mjs";
import { createRenderer } from "./render.mjs";
import { eventToScreenPoint, eventToWorldPoint } from "./coordinates.mjs";
import { observeViewport } from "./viewport.mjs";

const initial = await fetch("./diagram.json").then((response) => response.json());
const storageKey = `architecture-canvas:${location.pathname}`;
const saved = localStorage.getItem(storageKey);
const store = createDiagramStore(saved ? JSON.parse(saved) : initial, {
  setItem: (_, value) => localStorage.setItem(storageKey, value),
});

const svg = document.querySelector("#canvas-svg");
const viewport = document.querySelector("#viewport");
const tooltip = document.querySelector("#tooltip");
const inspector = document.querySelector("#inspector-fields");
const status = document.querySelector("#status");
const renderer = createRenderer({ svgRoot: svg, viewport, tooltip, inspector });
let view = { x: 0, y: 0, zoom: 1 };
let selection = { kind: "", id: "", ids: [] };
let mode = "select";
let drag = null;

const findItem = (kind, id) => {
  const diagram = store.getState();
  const source = { node: diagram.nodes, group: diagram.groups, edge: diagram.edges }[kind] || [];
  return source.find((item) => item.id === id);
};

const selectedNodeIds = () => selection.kind === "node" ? selection.ids : [];

const select = (kind, id, additive = false) => {
  if (kind !== "node" || !additive) {
    selection = { kind, id, ids: kind === "node" ? [id] : [] };
    return;
  }
  const ids = selection.kind === "node" ? new Set(selection.ids) : new Set();
  if (ids.has(id)) ids.delete(id);
  else ids.add(id);
  selection = { kind: "node", id, ids: [...ids] };
};

const render = () => {
  renderer.render(store.getState(), view, selection);
  document.querySelectorAll("[data-mode]").forEach((button) => button.classList.toggle("active", button.dataset.mode === mode));
};

const fit = () => {
  const bounds = diagramBounds(store.getState());
  const rect = svg.getBoundingClientRect();
  const padding = 72;
  const zoom = Math.min(rect.width / (bounds.w + padding * 2), rect.height / (bounds.h + padding * 2), 1.5);
  view = {
    zoom,
    x: rect.width / 2 - (bounds.x + bounds.w / 2) * zoom,
    y: rect.height / 2 - (bounds.y + bounds.h / 2) * zoom,
  };
  render();
};

const download = (name, content, type) => {
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([content], { type }));
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
};

const updateSelected = (field, value) => {
  if (!selection.kind) return;
  store.update((diagram) => {
    const source = selection.kind === "node" ? "nodes" : selection.kind === "group" ? "groups" : "edges";
    return {
      ...diagram,
      [source]: diagram[source].map((item) => {
        if (item.id !== selection.id) return item;
        if (field.startsWith("details.")) {
          const key = field.slice("details.".length);
          return { ...item, details: { ...item.details, [key]: value } };
        }
        return { ...item, [field]: value };
      }),
    };
  });
};

const validate = () => {
  const report = validateDiagram(store.getState());
  status.textContent = report.isValid
    ? "Grafo válido"
    : `${report.overlaps.length} overlaps · ${report.danglingEdges.length} dangling · ${report.edgeThroughNodes.length} crossings`;
  status.dataset.valid = String(report.isValid);
  return report;
};

svg.addEventListener("pointerdown", (event) => {
  const target = event.target.closest("[data-kind]");
  const point = eventToWorldPoint(event, svg, view);
  if (!target) {
    drag = { kind: "pan", screen: eventToScreenPoint(event, svg), origin: { ...view } };
    svg.setPointerCapture(event.pointerId);
    return;
  }
  const kind = target.dataset.kind;
  const id = target.dataset.id;
  if (kind === "resize") {
    const resizeKind = target.dataset.resizeKind || "node";
    select(resizeKind, id);
    drag = { kind: "resize", target: { kind: resizeKind, id }, point, snapshot: findItem(resizeKind, id) };
    store.checkpoint();
  } else if (kind === "badge") {
    select("edge", id);
    drag = { kind: "badge", id, point, snapshot: findItem("edge", id) };
    store.checkpoint();
  } else if (kind === "edge-anchor") {
    const edge = findItem("edge", id);
    const endpoint = target.dataset.endpoint;
    select("edge", id);
    drag = { kind: "edge-anchor", edgeId: id, endpoint, nodeId: endpoint === "from" ? edge.from : edge.to };
    store.checkpoint();
  } else if (mode === "connect" && kind === "node") {
    if (drag?.kind === "connect" && drag.from !== id) {
      store.update((diagram) => connectNodes(diagram, drag.from, id));
      drag = null;
      mode = "select";
    } else {
      drag = { kind: "connect", from: id };
      select("node", id);
    }
  } else {
    select(kind, id, event.shiftKey);
    drag = { kind: "move", elementKind: kind, id, point };
    store.checkpoint();
  }
  svg.setPointerCapture(event.pointerId);
  render();
});

svg.addEventListener("pointermove", (event) => {
  const hovered = event.target.closest("[data-kind]");
  if (!drag && hovered) {
    const kind = hovered.dataset.kind === "badge" ? "edge" : hovered.dataset.kind;
    const item = findItem(kind, hovered.dataset.id);
    if (item) renderer.showTooltip(kind, item, event.clientX, event.clientY);
  } else if (!drag) {
    renderer.hideTooltip();
  }
  if (!drag) return;
  const point = eventToWorldPoint(event, svg, view);
  if (drag.kind === "pan") {
    const current = eventToScreenPoint(event, svg);
    view = { ...drag.origin, x: drag.origin.x + current.x - drag.screen.x, y: drag.origin.y + current.y - drag.screen.y };
  }
  if (drag.kind === "move") {
    const dx = point.x - drag.point.x;
    const dy = point.y - drag.point.y;
    store.update((diagram) => moveElement(diagram, drag.elementKind, drag.id, dx, dy), false);
    drag.point = point;
  }
  if (drag.kind === "resize") {
    const dx = Math.max(96, drag.snapshot.w + point.x - drag.point.x);
    const dy = Math.max(48, drag.snapshot.h + point.y - drag.point.y);
    store.update((diagram) => resizeElement(diagram, drag.target, { w: dx, h: dy }), false);
  }
  if (drag.kind === "badge") {
    const offsetX = point.x - drag.point.x;
    const offsetY = point.y - drag.point.y;
    store.update((diagram) => ({ ...diagram, edges: diagram.edges.map((edge) => edge.id === drag.id ? { ...edge, badge: { ...edge.badge, offsetX, offsetY } } : edge) }), false);
  }
  if (drag.kind === "edge-anchor") {
    const node = findItem("node", drag.nodeId);
    if (node) store.update((diagram) => setEdgeAnchor(diagram, {
      edgeId: drag.edgeId,
      endpoint: drag.endpoint,
      anchor: anchorForPoint(node, point),
    }), false);
  }
  render();
});

svg.addEventListener("pointerup", () => {
  drag = drag?.kind === "connect" ? drag : null;
  validate();
});

svg.addEventListener("wheel", (event) => {
  event.preventDefault();
  const cursor = eventToScreenPoint(event, svg);
  const nextZoom = Math.max(0.25, Math.min(2.5, view.zoom * (event.deltaY < 0 ? 1.12 : 0.89)));
  const ratio = nextZoom / view.zoom;
  view = { zoom: nextZoom, x: cursor.x - (cursor.x - view.x) * ratio, y: cursor.y - (cursor.y - view.y) * ratio };
  render();
}, { passive: false });

document.querySelector("#toolbar").addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  const action = button.dataset.action;
  if (action === "add") store.update((diagram) => {
    const bounds = diagramBounds(diagram);
    return addNode(diagram, { x: bounds.x + bounds.w + 120, y: bounds.y + 80 });
  });
  if (action === "connect") mode = mode === "connect" ? "select" : "connect";
  if (action === "group") store.update((diagram) => createGroupFromNodes(diagram, selectedNodeIds(), "New group"));
  if (action === "align-h") store.update((diagram) => alignNodes(diagram, selectedNodeIds(), "horizontal"));
  if (action === "align-v") store.update((diagram) => alignNodes(diagram, selectedNodeIds(), "vertical"));
  if (action === "distribute-h") store.update((diagram) => distributeNodes(diagram, selectedNodeIds(), "horizontal"));
  if (action === "distribute-v") store.update((diagram) => distributeNodes(diagram, selectedNodeIds(), "vertical"));
  if (action === "undo") store.undo();
  if (action === "redo") store.redo();
  if (action === "fit") fit();
  if (action === "validate") validate();
  if (action === "download-json") download("diagram.json", JSON.stringify(store.getState(), null, 2), "application/json");
  if (action === "download-svg") download("diagram.svg", renderer.exportSvg(), "image/svg+xml");
  render();
});

inspector.addEventListener("input", (event) => {
  const field = event.target.dataset.field;
  if (!field) return;
  updateSelected(field, event.target.value);
  render();
});

document.querySelector("#import-file").addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) return;
  const parsed = JSON.parse(await file.text());
  store.replace(normalizeDiagram(parsed));
  selection = { kind: "", id: "", ids: [] };
  fit();
  validate();
});

document.addEventListener("keydown", (event) => {
  const modifier = event.metaKey || event.ctrlKey;
  if (modifier && event.key.toLowerCase() === "z") {
    event.preventDefault();
    event.shiftKey ? store.redo() : store.undo();
  }
  if (event.key === "Escape") { mode = "select"; drag = null; renderer.hideTooltip(); }
  if (event.key === "Delete" && selection.kind) {
    const selected = selection.kind === "node"
      ? selection.ids.map((id) => ({ kind: "node", id }))
      : [selection];
    store.update((diagram) => removeSelection(diagram, selected));
    selection = { kind: "", id: "", ids: [] };
  }
  render();
  validate();
});

store.subscribe(() => validate());
window.ArchitectureCanvas = { getDiagram: () => store.getState(), validate, fit };
observeViewport(document.querySelector(".ac-app"), fit);
validate();
