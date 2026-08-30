export const rectanglesOverlap = (a, b, padding = 0) => !(
  a.x + a.w + padding <= b.x ||
  b.x + b.w + padding <= a.x ||
  a.y + a.h + padding <= b.y ||
  b.y + b.h + padding <= a.y
);

const borderPoint = (from, to) => {
  const fromCenter = { x: from.x + from.w / 2, y: from.y + from.h / 2 };
  const toCenter = { x: to.x + to.w / 2, y: to.y + to.h / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;

  if (Math.abs(dx / from.w) >= Math.abs(dy / from.h)) {
    return {
      x: dx >= 0 ? from.x + from.w : from.x,
      y: fromCenter.y + (dy / Math.max(1, Math.abs(dx))) * from.w / 2,
    };
  }
  return {
    x: fromCenter.x + (dx / Math.max(1, Math.abs(dy))) * from.h / 2,
    y: dy >= 0 ? from.y + from.h : from.y,
  };
};

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const stubLength = 28;
const detourOffset = stubLength + 1;

const sideVector = (side) => ({
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
}[side]);

const compactPoints = (points) => points.filter((point, index) => (
  index === 0 || point.x !== points[index - 1].x || point.y !== points[index - 1].y
));

const routeLength = (points) => points.slice(1).reduce(
  (total, point, index) => total + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y),
  0,
);

const segmentHitsRectangle = (start, end, rectangle, padding = stubLength) => {
  const left = rectangle.x - padding;
  const right = rectangle.x + rectangle.w + padding;
  const top = rectangle.y - padding;
  const bottom = rectangle.y + rectangle.h + padding;
  if (start.y === end.y) {
    return start.y >= top && start.y <= bottom && Math.max(start.x, end.x) >= left && Math.min(start.x, end.x) <= right;
  }
  return start.x >= left && start.x <= right && Math.max(start.y, end.y) >= top && Math.min(start.y, end.y) <= bottom;
};

const routeHitsObstacle = (points, obstacles) => obstacles.some((obstacle) => points.slice(1).some(
  (point, index) => segmentHitsRectangle(points[index], point, obstacle),
));

const routedPoints = (start, startStub, endStub, end, middle) => compactPoints([start, startStub, ...middle, endStub, end]);

const pointIsFree = (point, obstacle) => (
  point.x < obstacle.x - stubLength ||
  point.x > obstacle.x + obstacle.w + stubLength ||
  point.y < obstacle.y - stubLength ||
  point.y > obstacle.y + obstacle.h + stubLength
);

const gridRoute = (start, end, obstacles) => {
  const xValues = [...new Set([start.x, end.x, ...obstacles.flatMap((obstacle) => [obstacle.x - detourOffset, obstacle.x + obstacle.w + detourOffset])])].sort((left, right) => left - right);
  const yValues = [...new Set([start.y, end.y, ...obstacles.flatMap((obstacle) => [obstacle.y - detourOffset, obstacle.y + obstacle.h + detourOffset])])].sort((top, bottom) => top - bottom);
  const points = xValues.flatMap((x) => yValues.map((y) => ({ x, y }))).filter((point) => obstacles.every((obstacle) => pointIsFree(point, obstacle)));
  const key = (point) => `${point.x}:${point.y}`;
  const byKey = new Map(points.map((point) => [key(point), point]));
  const startKey = key(start);
  const endKey = key(end);
  if (!byKey.has(startKey) || !byKey.has(endKey)) return null;
  const distance = new Map(points.map((point) => [key(point), Infinity]));
  const previous = new Map();
  const pending = new Set(distance.keys());
  distance.set(startKey, 0);

  while (pending.size) {
    const currentKey = [...pending].reduce((closest, candidate) => distance.get(candidate) < distance.get(closest) ? candidate : closest);
    if (currentKey === endKey) break;
    pending.delete(currentKey);
    const current = byKey.get(currentKey);
    const neighbours = points.filter((point) => (point.x === current.x || point.y === current.y) && !routeHitsObstacle([current, point], obstacles));
    neighbours.forEach((neighbour) => {
      const neighbourKey = key(neighbour);
      if (!pending.has(neighbourKey)) return;
      const nextDistance = distance.get(currentKey) + Math.abs(neighbour.x - current.x) + Math.abs(neighbour.y - current.y);
      if (nextDistance < distance.get(neighbourKey)) {
        distance.set(neighbourKey, nextDistance);
        previous.set(neighbourKey, currentKey);
      }
    });
  }

  if (!previous.has(endKey) && startKey !== endKey) return null;
  const route = [];
  for (let currentKey = endKey; currentKey; currentKey = previous.get(currentKey)) route.unshift(byKey.get(currentKey));
  return route;
};

export const anchorPoint = (node, anchor) => {
  const offset = clamp(anchor.offset, 0, 1);
  if (anchor.side === "top") return { x: node.x + node.w * offset, y: node.y };
  if (anchor.side === "bottom") return { x: node.x + node.w * offset, y: node.y + node.h };
  if (anchor.side === "left") return { x: node.x, y: node.y + node.h * offset };
  return { x: node.x + node.w, y: node.y + node.h * offset };
};

export const anchorForPoint = (node, point) => {
  const distances = [
    ["top", Math.abs(point.y - node.y)],
    ["bottom", Math.abs(point.y - (node.y + node.h))],
    ["left", Math.abs(point.x - node.x)],
    ["right", Math.abs(point.x - (node.x + node.w))],
  ];
  const [side] = distances.reduce((nearest, candidate) => candidate[1] < nearest[1] ? candidate : nearest);
  const offset = side === "top" || side === "bottom"
    ? (point.x - node.x) / node.w
    : (point.y - node.y) / node.h;
  return { side, offset: clamp(offset, 0, 1) };
};

export const routeEdge = ({ from, to, anchors = {}, obstacles = [] }) => {
  const start = anchors.from ? anchorPoint(from, anchors.from) : borderPoint(from, to);
  const end = anchors.to ? anchorPoint(to, anchors.to) : borderPoint(to, from);
  const fromVector = anchors.from && sideVector(anchors.from.side);
  const toVector = anchors.to && sideVector(anchors.to.side);
  const startStub = fromVector ? { x: start.x + fromVector.x * stubLength, y: start.y + fromVector.y * stubLength } : start;
  const endStub = toVector ? { x: end.x + toVector.x * stubLength, y: end.y + toVector.y * stubLength } : end;
  const middleX = (startStub.x + endStub.x) / 2;
  const middleY = (startStub.y + endStub.y) / 2;
  const candidates = [
    routedPoints(start, startStub, endStub, end, [{ x: middleX, y: startStub.y }, { x: middleX, y: endStub.y }]),
    routedPoints(start, startStub, endStub, end, [{ x: startStub.x, y: middleY }, { x: endStub.x, y: middleY }]),
    ...obstacles.flatMap((obstacle) => [
      routedPoints(start, startStub, endStub, end, [{ x: obstacle.x - detourOffset, y: startStub.y }, { x: obstacle.x - detourOffset, y: endStub.y }]),
      routedPoints(start, startStub, endStub, end, [{ x: obstacle.x + obstacle.w + detourOffset, y: startStub.y }, { x: obstacle.x + obstacle.w + detourOffset, y: endStub.y }]),
      routedPoints(start, startStub, endStub, end, [{ x: startStub.x, y: obstacle.y - detourOffset }, { x: endStub.x, y: obstacle.y - detourOffset }]),
      routedPoints(start, startStub, endStub, end, [{ x: startStub.x, y: obstacle.y + obstacle.h + detourOffset }, { x: endStub.x, y: obstacle.y + obstacle.h + detourOffset }]),
    ]),
  ].sort((left, right) => routeLength(left) - routeLength(right));
  const direct = candidates.find((candidate) => !routeHitsObstacle(candidate, obstacles));
  const corridor = direct ? null : gridRoute(startStub, endStub, obstacles);
  const points = direct || (corridor && routedPoints(start, startStub, endStub, end, corridor.slice(1, -1))) || candidates[0];
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x} ${point.y}`).join(" ");
  return { start, end, points, path };
};

export const diagramBounds = (diagram) => {
  const elements = [...diagram.groups, ...diagram.nodes];
  if (elements.length === 0) return { x: 0, y: 0, w: 1, h: 1 };
  const left = Math.min(...elements.map(({ x }) => x));
  const top = Math.min(...elements.map(({ y }) => y));
  const right = Math.max(...elements.map(({ x, w }) => x + w));
  const bottom = Math.max(...elements.map(({ y, h }) => y + h));
  return { x: left, y: top, w: right - left, h: bottom - top };
};

const pointInside = (point, rect, inset = 4) => (
  point.x > rect.x + inset &&
  point.x < rect.x + rect.w - inset &&
  point.y > rect.y + inset &&
  point.y < rect.y + rect.h - inset
);

export const validateDiagram = (diagram) => {
  const overlaps = [];
  for (let left = 0; left < diagram.nodes.length; left += 1) {
    for (let right = left + 1; right < diagram.nodes.length; right += 1) {
      if (rectanglesOverlap(diagram.nodes[left], diagram.nodes[right])) {
        overlaps.push([diagram.nodes[left].id, diagram.nodes[right].id]);
      }
    }
  }

  const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
  const danglingEdges = diagram.edges
    .filter(({ from, to }) => !nodes.has(from) || !nodes.has(to))
    .map(({ id }) => id);
  const edgeThroughNodes = [];

  diagram.edges.forEach((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return;
    const unrelated = diagram.nodes.filter(({ id }) => id !== edge.from && id !== edge.to);
    const route = routeEdge({ from, to, anchors: edge.anchors, obstacles: unrelated });
    for (let segment = 1; segment < route.points.length; segment += 1) {
      const previous = route.points[segment - 1];
      const current = route.points[segment];
      for (let sample = 1; sample < 10; sample += 1) {
        const ratio = sample / 10;
        const point = {
          x: previous.x + (current.x - previous.x) * ratio,
          y: previous.y + (current.y - previous.y) * ratio,
        };
        const hit = unrelated.find((node) => pointInside(point, node));
        if (hit) {
          edgeThroughNodes.push([edge.id, hit.id]);
          segment = route.points.length;
          break;
        }
      }
    }
  });

  return {
    isValid: overlaps.length === 0 && danglingEdges.length === 0 && edgeThroughNodes.length === 0,
    overlaps,
    danglingEdges,
    edgeThroughNodes,
  };
};
