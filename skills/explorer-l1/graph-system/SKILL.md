---
name: graph-system
description: >
  Load and query Descobrir L1 system edges (cross-repo callers/callees / blast
  radius). Use when the user says /graph-system, "impacto cross-service",
  "quem chama o controller", or system-namespace queries. NOT for L0 single-repo
  load (/graph) and NOT for indexing (/descobrir) or stitching (/l1).
---

# graph-system — L1 system overlay consumer

You load **already stitched** system edges from SQLite (`system_edges`) and
answer cross-repo impact questions. You do **not** index. You do **not** stitch
(that is `/l1`).

## Triggers

- `/graph-system …`
- “quem chama tax-provider-controller?”
- “callees de acme-tax no sistema”
- blast radius cross-repo after L1 stitch

## Not this skill

- Single-repo accepted baseline → **`graph`** / `/graph`
- Build L0 candidate → **`descobrir`**
- Create system edges → **`l1`** / `/l1`

## Preconditions

1. `/l1 stitch` already ran for the `system-namespace`.
2. DB path defaults to `~/.local/share/descobrir/<namespace>.sqlite`.

## CLI

```bash
node ~/.agents/skills/l1/cli.mjs status \
  --namespace acme --system-namespace acme-system

# Who calls into a repo (edges where to_logical_repo = repo)
node ~/.agents/skills/l1/cli.mjs callers \
  --namespace acme --system-namespace acme-system \
  --repo tax-provider-controller

# What a repo calls (edges where from_logical_repo = repo)
node ~/.agents/skills/l1/cli.mjs callees \
  --namespace acme --system-namespace acme-system \
  --repo acme-tax

node ~/.agents/skills/l1/cli.mjs export-system \
  --namespace acme --system-namespace acme-system \
  --output /tmp/acme-system.json
```

## Session protocol

1. Parse args: system-namespace (default prompt if missing), repo, side
   (callers|callees|status), optional contract filter from question text.
2. Run CLI; parse JSON.
3. Answer in pt-BR with:
   - edge_count
   - top edges: `from.logical_repo → to.logical_repo`, `contract_key`,
     `match_kind`, `score`, evidence file:line
4. Evidence class is `contract-matched` — say so; do not upgrade to runtime proof.
5. If zero edges → tell user to run `/l1 stitch` first.

## Install

Bundled with L1:

```bash
node skills/l1/install.mjs install
```
