# Architecture Canvas

Portable no-build architecture drawing workbench. Run `scripts/create_canvas.py` to copy the engine to a project or output directory.

## State schema

`diagram.json` has `groups`, `nodes`, and `edges`. Each element holds free canvas coordinates. The engine recalculates edge routes while nodes/groups move.

## Boundaries

- `assets/js/model.mjs`: immutable graph mutations, grouping, alignment, undo/redo.
- `assets/js/geometry.mjs`: border-aware, obstacle-aware edge routing and graph validation.
- `assets/js/render.mjs`: SVG and Inspector rendering.
- `assets/js/coordinates.mjs`: screen/world coordinate conversion.
- `assets/js/viewport.mjs`: desktop viewport sizing and fit synchronization.
- `assets/js/app.mjs`: browser interactions, persistence, import/export.

Run `node --test tests/engine.test.mjs` and `python3 -m pytest tests -q` before changing the engine.
