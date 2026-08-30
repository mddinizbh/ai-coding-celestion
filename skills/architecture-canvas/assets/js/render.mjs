import { routeEdge } from "./geometry.mjs";

const svg = (name, attributes = {}) => {
  const element = document.createElementNS("http://www.w3.org/2000/svg", name);
  Object.entries(attributes).forEach(([key, value]) => element.setAttribute(key, String(value)));
  return element;
};

const text = (value, attributes) => {
  const element = svg("text", attributes);
  element.textContent = value;
  return element;
};

const details = (payload) => Object.entries(payload || {})
  .filter(([, value]) => value)
  .map(([key, value]) => `<section><b>${key}</b><pre>${typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre></section>`)
  .join("");

const edgeMidpoint = (points) => {
  const length = points.slice(1).reduce(
    (total, point, index) => total + Math.abs(point.x - points[index].x) + Math.abs(point.y - points[index].y),
    0,
  );
  let traversed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1];
    const end = points[index];
    const segment = Math.abs(end.x - start.x) + Math.abs(end.y - start.y);
    if (traversed + segment >= length / 2) {
      const ratio = (length / 2 - traversed) / segment;
      return { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio };
    }
    traversed += segment;
  }
  return points[0];
};

export const createRenderer = (elements) => {
  const {
    svgRoot,
    viewport,
    tooltip,
    inspector,
  } = elements;

  const drawNode = (node, selection) => {
    const group = svg("g", {
      class: `ac-node ${node.type} ${selection.ids.includes(node.id) ? "selected" : ""}`,
      "data-kind": "node",
      "data-id": node.id,
      transform: `translate(${node.x} ${node.y})`,
    });
    group.append(svg("rect", { width: node.w, height: node.h, rx: 10 }));
    group.append(text(node.title, { class: "ac-node-title", x: 12, y: 25 }));
    group.append(text(node.subtitle || "", { class: "ac-node-subtitle", x: 12, y: 44 }));
    const handle = svg("rect", {
      class: "ac-resize-handle",
      "data-kind": "resize",
      "data-id": node.id,
      x: node.w - 10,
      y: node.h - 10,
      width: 8,
      height: 8,
      rx: 2,
    });
    group.append(handle);
    return group;
  };

  const drawGroup = (groupData, selection) => {
    const group = svg("g", {
      class: `ac-group ${selection.kind === "group" && selection.id === groupData.id ? "selected" : ""}`,
      "data-kind": "group",
      "data-id": groupData.id,
    });
    group.append(svg("rect", { x: groupData.x, y: groupData.y, width: groupData.w, height: groupData.h, rx: 16 }));
    group.append(text(groupData.title, { class: "ac-group-title", x: groupData.x + 16, y: groupData.y + 25 }));
    group.append(svg("rect", {
      class: "ac-resize-handle",
      "data-kind": "resize",
      "data-id": groupData.id,
      "data-resize-kind": "group",
      x: groupData.x + groupData.w - 10,
      y: groupData.y + groupData.h - 10,
      width: 8,
      height: 8,
      rx: 2,
    }));
    return group;
  };

  const drawEdge = (edge, nodes, selection) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return null;
    const obstacles = [...nodes.values()].filter(({ id }) => id !== edge.from && id !== edge.to);
    const route = routeEdge({ from, to, anchors: edge.anchors, obstacles });
    const mid = edgeMidpoint(route.points);
    const badgeX = mid.x + (edge.badge?.offsetX || 0);
    const badgeY = mid.y + (edge.badge?.offsetY || 0);
    const wrapper = svg("g", { class: "ac-edge-wrap" });
    const selected = selection.kind === "edge" && selection.id === edge.id;
    wrapper.append(svg("path", {
      class: `ac-edge ${edge.status || "bound"} ${selected ? "selected" : ""}`,
      "data-kind": "edge",
      "data-id": edge.id,
      d: route.path,
    }));
    const badge = svg("g", {
      class: `ac-badge ${edge.status || "bound"} ${selected ? "selected" : ""}`,
      "data-kind": "badge",
      "data-id": edge.id,
      transform: `translate(${badgeX} ${badgeY})`,
    });
    badge.append(svg("circle", { r: 10 }));
    badge.append(text(edge.badge?.label || "", { x: 0, y: 0, class: "ac-badge-label" }));
    wrapper.append(badge);
    return wrapper;
  };

  const drawEdgeAnchor = (edge, route, endpoint) => {
    const point = route[endpoint === "from" ? "start" : "end"];
    return svg("circle", {
      class: "ac-edge-anchor",
      "data-kind": "edge-anchor",
      "data-id": edge.id,
      "data-endpoint": endpoint,
      cx: point.x,
      cy: point.y,
      r: 6,
    });
  };

  const renderInspector = (diagram, selection) => {
    const items = {
      node: diagram.nodes,
      group: diagram.groups,
      edge: diagram.edges,
    };
    const selected = items[selection.kind]?.find(({ id }) => id === selection.id);
    if (!selected) {
      inspector.innerHTML = "<div class=\"ac-empty\">Selecione um componente, grupo ou aresta para editar.</div>";
      return;
    }
    const fields = selection.kind === "edge"
      ? [
          ["label", "Rótulo", selected.label || ""],
          ["status", "Status", selected.status || "bound", "select"],
          ["details.description", "Descrição", selected.details?.description || "", "textarea"],
          ["details.evidence", "Evidência", selected.details?.evidence || "", "textarea"],
          ["details.input", "Input JSON", selected.details?.input || "", "textarea"],
          ["details.entity", "Entity JSON", selected.details?.entity || "", "textarea"],
        ]
      : [
          ["title", "Título", selected.title || ""],
          ["subtitle", "Subtítulo", selected.subtitle || ""],
          ...(selection.kind === "node" ? [["type", "Tipo", selected.type || "service", "select"]] : []),
          ["details.description", "Descrição", selected.details?.description || "", "textarea"],
          ["details.evidence", "Evidência", selected.details?.evidence || "", "textarea"],
          ["details.input", "Input JSON", selected.details?.input || "", "textarea"],
          ["details.entity", "Entity JSON", selected.details?.entity || "", "textarea"],
        ];
    const control = ([path, label, value, kind]) => {
      if (kind === "select" && path === "type") {
        return `<label>${label}<select data-field="${path}">${["service", "database", "external", "decision", "note"].map((option) => `<option ${option === value ? "selected" : ""}>${option}</option>`).join("")}</select></label>`;
      }
      if (kind === "select") {
        return `<label>${label}<select data-field="${path}">${["bound", "gap", "data"].map((option) => `<option ${option === value ? "selected" : ""}>${option}</option>`).join("")}</select></label>`;
      }
      return `<label>${label}${kind === "textarea" ? `<textarea data-field="${path}">${value}</textarea>` : `<input data-field="${path}" value="${value}">`}</label>`;
    };
    inspector.innerHTML = `<div class="ac-inspector-title">${selection.kind}</div>${fields.map(control).join("")}`;
  };

  return {
    render(diagram, view, selection) {
      viewport.replaceChildren();
      viewport.setAttribute("transform", `translate(${view.x} ${view.y}) scale(${view.zoom})`);
      const nodes = new Map(diagram.nodes.map((node) => [node.id, node]));
      diagram.groups.forEach((groupData) => viewport.append(drawGroup(groupData, selection)));
      diagram.edges.forEach((edge) => {
        const rendered = drawEdge(edge, nodes, selection);
        if (rendered) viewport.append(rendered);
      });
      diagram.nodes.forEach((node) => viewport.append(drawNode(node, selection)));
      if (selection.kind === "edge") {
        const edge = diagram.edges.find(({ id }) => id === selection.id);
        const from = edge && nodes.get(edge.from);
        const to = edge && nodes.get(edge.to);
        if (edge && from && to) {
          const obstacles = [...nodes.values()].filter(({ id }) => id !== edge.from && id !== edge.to);
          const route = routeEdge({ from, to, anchors: edge.anchors, obstacles });
          viewport.append(drawEdgeAnchor(edge, route, "from"));
          viewport.append(drawEdgeAnchor(edge, route, "to"));
        }
      }
      renderInspector(diagram, selection);
    },
    showTooltip(kind, item, clientX, clientY) {
      const title = kind === "edge" ? item.label || "Aresta" : item.title;
      tooltip.innerHTML = `<h3>${title}</h3>${details(item.details) || "<p>Sem detalhes adicionais.</p>"}`;
      tooltip.style.left = `${clientX + 14}px`;
      tooltip.style.top = `${clientY + 14}px`;
      tooltip.hidden = false;
    },
    hideTooltip() {
      tooltip.hidden = true;
    },
    exportSvg() {
      const copy = svgRoot.cloneNode(true);
      copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      return new XMLSerializer().serializeToString(copy);
    },
  };
};
