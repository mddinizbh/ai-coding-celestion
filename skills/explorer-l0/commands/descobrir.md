---
description: >
  Alias of /explorer-l0 — Descobrir legacy name. Prefer /explorer-l0.
---

# /descobrir (alias → explorer-l0)

Run the global `explorer-l0` skill for: $ARGUMENTS

<!-- explorer-l0-install-owned:v1 -->

This command is a **legacy alias** of `/explorer-l0`. Follow the explorer-l0
SKILL.md protocol exactly (setup-status → prepare → emit-payloads → finalize).

CLI paths:

```bash
node skills/explorer-l0/cli.mjs setup-status
node skills/explorer-l0/cli.mjs prepare ...
node skills/explorer-l0/cli.mjs emit-payloads --run-root ...
node skills/explorer-l0/cli.mjs finalize ...
```

Never auto-accept. Prefer telling the user the canonical name is **explorer-l0**.
