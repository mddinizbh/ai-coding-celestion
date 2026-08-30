# Architecture Canvas Design System

## 1. Atmosphere & Identity

Uma bancada técnica silenciosa: alta densidade sem ruído, precisão de CAD e leitura imediata de arquitetura. A assinatura é o grafo vivo — componentes discretos, conexões luminosas e detalhes que aparecem somente quando solicitados.

## 2. Color

| Role | Token | Light | Dark | Usage |
|---|---|---|---|---|
| Canvas | `--canvas` | `#f5f6f7` | `#090a0b` | Área infinita |
| Panel | `--panel` | `#ffffff` | `#111214` | Toolbar e inspector |
| Surface | `--surface` | `#f0f1f2` | `#191a1d` | Nós e grupos |
| Text | `--text` | `#17181a` | `#f4f5f6` | Texto principal |
| Muted | `--muted` | `#71757b` | `#8d929a` | Metadados |
| Border | `--border` | `#d9dce0` | `#2b2e33` | Estrutura |
| Accent | `--accent` | `#5266d8` | `#7c8cff` | Seleção e ações |
| Success | `--success` | `#278354` | `#61c38b` | Bound/confirmado |
| Warning | `--warning` | `#a96719` | `#e3a354` | Gap/externo |
| Data | `--data` | `#426e91` | `#79a8cc` | DB/entidade |
| Danger | `--danger` | `#b44343` | `#ef7373` | Remoção/erro |

Colors exist only as CSS tokens. Accent is reserved for interaction and selection.

## 3. Typography

- Primary: `system-ui, -apple-system, "Segoe UI", sans-serif`
- Mono: `ui-monospace, "SFMono-Regular", Menlo, monospace`
- H1: 16px / 600 / 1.25
- Node title: 13px / 600 / 1.3
- Body: 13px / 400 / 1.5
- Caption: 11px / 500 / 1.4
- Micro: 10px / 500 / 1.4

## 4. Spacing & Layout

Base unit: 4px. Tokens: `--s1:4px`, `--s2:8px`, `--s3:12px`, `--s4:16px`, `--s5:20px`, `--s6:24px`, `--s8:32px`.

The application occupies `100dvh`. Toolbar is 48px; inspector is 304px; all remaining space belongs to the canvas. The canvas has no maximum width.

## 5. Components

### Toolbar
- Compact horizontal action groups with labels and keyboard hints.
- States: default, hover, active mode, focus-visible, disabled.

### Canvas
- SVG viewport with grid, pan, zoom, fit and selection rectangle.
- States: idle, panning, connecting, dragging, empty.

### Node
- Rounded live SVG group with title, subtitle and semantic type.
- Variants: service, database, external, decision, note.
- States: default, hover, selected, dragging.

### Group
- Dashed container frame with header; dragging moves all members.
- States: default, hover, selected, dragging.

### Edge and Badge
- Orthogonal edge with arrow marker and one compact numbered badge near its midpoint.
- States: default, hover, selected, status bound/gap/data.

### Inspector
- Form fields edit the selected graph element and hover payload.
- States: empty selection, one element, multiple elements, invalid JSON.

### Tooltip
- Read-only progressive disclosure for description, evidence, input and entity data.
- States: hidden and visible; never blocks pointer interaction.

## 6. Motion & Interaction

- Micro feedback: 120ms ease-out; transform/opacity only.
- Dragging is immediate and has no transition.
- Pan: background pointer drag. Zoom: wheel and toolbar, centered under pointer.
- `Escape` cancels modes; `Delete` removes selection; `Ctrl/Cmd+Z` undo; `Ctrl/Cmd+Shift+Z` redo.
- Respect `prefers-reduced-motion`.

## 7. Depth & Surface

Strategy: borders plus tonal shift. Shadows appear only on floating inspector/tooltip surfaces. Canvas elements use borders and semantic fills, never decorative gradients.
