---
description: Explorer L1 — stitch system edges from accepted L0 baselines
---

# /explorer-l1

Run the **explorer-l1** skill.

User arguments: $ARGUMENTS

<!-- explorer-l1-install-owned:v1 -->

You own the runtime. Prefer:

`node ~/.agents/skills/explorer-l1/cli.mjs …`

(aliases: `~/.agents/skills/l1`)

Do not reindex with Graphify. Do not merge L0 namespaces. Edges are
`contract-matched` only and may carry `http-sync`, `webhook`, `cron` or `queue`
triggers. Treat them as a source-navigation skeleton; after stitch, use
callers/callees or `/explorer-query` and read the referenced code.
