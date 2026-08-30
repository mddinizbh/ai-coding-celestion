export const eventToScreenPoint = (event, svg) => {
  const bounds = svg.getBoundingClientRect();
  return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
};

export const eventToWorldPoint = (event, svg, view) => {
  const point = eventToScreenPoint(event, svg);
  return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
};
