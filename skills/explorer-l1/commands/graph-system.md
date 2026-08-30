---
description: Load L1 system overlay (cross-repo callers/callees) — not L0 /graph
---

<!-- graph-system-install-owned:v1 -->

Run the **graph-system** skill.

User arguments: $ARGUMENTS

You own the runtime. Prefer:

`node ~/.agents/skills/l1/cli.mjs callers|callees|status|export-system …`

This is **not** `/graph` (single-repo L0). Load system edges from SQLite
`system_edges` under the given `--system-namespace` (Acme: `acme-system`).
