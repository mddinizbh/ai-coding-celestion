---
name: architecture-canvas
description: Use when creating or revising an interactive architecture diagram that must be manually arranged with drag-and-drop, groups, editable edges, badges, evidence hover, or a reusable draw.io/Excalidraw-like workbench.
---

# Architecture Canvas

Use the ready HTML/SVG engine. The diagram is data (`diagram.json`); the canvas is the editor. Do not create SVG artesanal with fixed coordinates for a diagram that needs human layout refinement.

## Create the workbench

```bash
python3 ~/.agents/skills/architecture-canvas/scripts/create_canvas.py \
  --out <output-directory> --title "<diagram title>"
python3 -m http.server 8765 --directory <output-directory>
```

The generated directory is self-contained:

```text
index.html
assets/style.css
assets/js/{model,geometry,render,coordinates,viewport,app}.mjs
diagram.json
```

Open `http://127.0.0.1:8765`. The browser autosaves changes to local storage. Export JSON after human edits; that JSON becomes the source of truth for later renders.

## Populate data

1. Read the factual source first: code, accepted Descobrir SQLite baselines, L1 edges and L2 journeys.
2. Seed `diagram.json` with nodes, groups and edges. Use concise node labels; put proof in `details`.
3. Let the human arrange it in the workbench. Never overwrite a human-edited layout unless explicitly asked.
4. Use these semantic values:

| Element | Values |
|---|---|
| node `type` | `service`, `database`, `external`, `decision`, `note` |
| edge `status` | `bound`, `gap`, `data` |
| hover `details` | `description`, `evidence`, `input`, `entity` |

## Editor contract

- Drag a node freely; drag a group to move its members.
- Resize nodes and groups from the bottom-right handle.
- Click **Conectar**, then source and destination nodes to create an edge.
- Select an edge and drag its endpoint handles to change where the arrow binds to each node.
- Drag a badge to offset it from its edge.
- Select an element to edit its labels and hover payload in Inspector.
- Export/import JSON. Use **SVG** only for a visual snapshot, never as editable state.
- Use **Fit** after a large rearrangement.
- Use `Undo`, `Redo`, `Delete`, `Escape`, `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`.

## Verification gate

Run in the browser after every generation and after substantial human edits:

```js
ArchitectureCanvas.validate()
```

It must report `isValid: true`: no node overlap, dangling edge or edge crossing an unrelated node. Then exercise drag, group movement, group resize, edge creation, endpoint drag, badge drag, hover and JSON export.

## Do not regress to static diagrams

- Keep positions in `diagram.json`, not embedded as a hand-authored SVG scene.
- Keep `details` on nodes/edges, not long labels on the canvas.
- Preserve the engine assets when creating a new diagram; modify only `diagram.json` unless the engine itself needs a capability.
- For documentation suites, pair this workbench with `architecture-diagrams`; use its linter for published static/drill-down pages.
