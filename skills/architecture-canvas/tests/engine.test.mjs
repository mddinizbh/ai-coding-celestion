import test from "node:test";
import assert from "node:assert/strict";
import * as model from "../assets/js/model.mjs";

import {
  createDiagramStore,
  createGroupFromNodes,
  moveElement,
  connectNodes,
  alignNodes,
  distributeNodes,
} from "../assets/js/model.mjs";
import {
  routeEdge,
  validateDiagram,
} from "../assets/js/geometry.mjs";

const fixture = () => ({
  version: 1,
  title: "Fixture",
  groups: [],
  nodes: [
    { id: "a", type: "service", title: "A", subtitle: "", x: 20, y: 20, w: 120, h: 64, groupId: null, details: {} },
    { id: "b", type: "database", title: "B", subtitle: "", x: 300, y: 160, w: 120, h: 64, groupId: null, details: {} },
  ],
  edges: [],
});

test("groups selected nodes when a group is created", () => {
  // Given
  const diagram = fixture();

  // When
  const next = createGroupFromNodes(diagram, ["a", "b"], "Core");

  // Then
  assert.equal(next.groups.length, 1);
  assert.deepEqual(next.nodes.map((node) => node.groupId), [next.groups[0].id, next.groups[0].id]);
  assert.ok(next.groups[0].w > 400);
});

test("moves group members with their group", () => {
  // Given
  const grouped = createGroupFromNodes(fixture(), ["a", "b"], "Core");
  const groupId = grouped.groups[0].id;

  // When
  const next = moveElement(grouped, "group", groupId, 40, -10);

  // Then
  assert.deepEqual(next.nodes.map(({ x, y }) => [x, y]), [[60, 10], [340, 150]]);
});

test("connects existing nodes with a numbered edge", () => {
  // Given
  const diagram = fixture();

  // When
  const next = connectNodes(diagram, "a", "b");

  // Then
  assert.equal(next.edges.length, 1);
  assert.equal(next.edges[0].from, "a");
  assert.equal(next.edges[0].to, "b");
  assert.equal(next.edges[0].badge.label, "1");
});

test("routes an edge from node borders instead of centers", () => {
  // Given
  const [from, to] = fixture().nodes;

  // When
  const route = routeEdge({ from, to });

  // Then
  assert.equal(route.start.x, from.x + from.w);
  assert.ok(route.end.x === to.x || route.end.y === to.y);
  assert.match(route.path, /^M/);
});

test("routes an edge through user-selected border anchors", () => {
  // Given
  const [from, to] = fixture().nodes;

  // When
  const route = routeEdge({
    from,
    to,
    anchors: {
      from: { side: "bottom", offset: 0.25 },
      to: { side: "top", offset: 0.75 },
    },
  });

  // Then
  assert.deepEqual(route.start, { x: 50, y: 84 });
  assert.deepEqual(route.end, { x: 390, y: 160 });
});

test("keeps arrow direction semantic when a destination anchor changes side", () => {
  // Given
  const [from, to] = fixture().nodes;

  // When
  const route = routeEdge({
    from,
    to,
    anchors: {
      from: { side: "bottom", offset: 0.25 },
      to: { side: "top", offset: 0.75 },
    },
  });
  const beforeEnd = route.points.at(-2);

  // Then
  assert.deepEqual(route.points[1], { x: route.start.x, y: route.start.y + 28 });
  assert.deepEqual(beforeEnd, { x: route.end.x, y: route.end.y - 28 });
});

test("routes around an intermediate component", () => {
  // Given
  const from = { ...fixture().nodes[0], y: 100 };
  const to = { ...fixture().nodes[1], y: 100 };
  const obstacle = { id: "obstacle", x: 180, y: 80, w: 80, h: 104 };

  // When
  const route = routeEdge({ from, to, obstacles: [obstacle] });

  // Then
  assert.ok(route.points.some((point) => point.y < obstacle.y || point.y > obstacle.y + obstacle.h));
});

test("finds a free corridor when multiple components block direct detours", () => {
  // Given
  const from = { ...fixture().nodes[0], y: 100 };
  const to = { ...fixture().nodes[1], x: 400, y: 100 };
  const obstacles = [
    { id: "middle", x: 180, y: 80, w: 80, h: 104 },
    { id: "top", x: 180, y: -80, w: 80, h: 122 },
    { id: "bottom", x: 180, y: 190, w: 80, h: 104 },
    { id: "left-top-guard", x: 130, y: -100, w: 20, h: 200 },
    { id: "left-bottom-guard", x: 130, y: 164, w: 20, h: 200 },
    { id: "right-top-guard", x: 390, y: -100, w: 20, h: 200 },
    { id: "right-bottom-guard", x: 390, y: 164, w: 20, h: 200 },
  ];

  // When
  const route = routeEdge({ from, to, obstacles });

  // Then
  assert.ok(route.points.length > 4);
  assert.ok(route.points.some((point) => point.y <= -129 || point.y >= 393));
});

test("resizes a group without moving its member nodes", () => {
  // Given
  const grouped = createGroupFromNodes(fixture(), ["a", "b"], "Core");
  const group = grouped.groups[0];

  // When
  const next = model.resizeElement(grouped, { kind: "group", id: group.id }, { w: group.w + 80, h: group.h + 40 });

  // Then
  assert.equal(next.groups[0].w, group.w + 80);
  assert.equal(next.groups[0].h, group.h + 40);
  assert.deepEqual(next.nodes.map(({ x, y }) => [x, y]), grouped.nodes.map(({ x, y }) => [x, y]));
});

test("stores a dragged edge endpoint anchor", () => {
  // Given
  const connected = connectNodes(fixture(), "a", "b");

  // When
  const next = model.setEdgeAnchor(connected, {
    edgeId: "edge-1",
    endpoint: "from",
    anchor: { side: "bottom", offset: 0.25 },
  });

  // Then
  assert.deepEqual(next.edges[0].anchors.from, { side: "bottom", offset: 0.25 });
});

test("reports overlaps and dangling edges", () => {
  // Given
  const diagram = fixture();
  diagram.nodes[1].x = 40;
  diagram.nodes[1].y = 30;
  diagram.edges.push({ id: "bad", from: "a", to: "missing", label: "", status: "bound", badge: { label: "1", offsetX: 0, offsetY: 0 }, details: {} });

  // When
  const report = validateDiagram(diagram);

  // Then
  assert.equal(report.overlaps.length, 1);
  assert.deepEqual(report.danglingEdges, ["bad"]);
  assert.equal(report.isValid, false);
});

test("undo restores the state before a mutation", () => {
  // Given
  const store = createDiagramStore(fixture());

  // When
  store.update((diagram) => moveElement(diagram, "node", "a", 50, 0));
  store.undo();

  // Then
  assert.equal(store.getState().nodes[0].x, 20);
});

test("aligns selected nodes on their horizontal centers", () => {
  // Given
  const diagram = fixture();

  // When
  const next = alignNodes(diagram, ["a", "b"], "horizontal");

  // Then
  assert.equal(next.nodes[0].y, next.nodes[1].y);
});

test("distributes three nodes with equal horizontal gaps", () => {
  // Given
  const diagram = fixture();
  diagram.nodes.push({ ...diagram.nodes[0], id: "c", x: 620 });

  // When
  const next = distributeNodes(diagram, ["a", "b", "c"], "horizontal");

  // Then
  const centers = next.nodes.map(({ x, w }) => x + w / 2);
  assert.equal(centers[1] - centers[0], centers[2] - centers[1]);
});
