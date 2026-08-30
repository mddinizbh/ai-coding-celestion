---
name: explorer-query
description: >
  Orchestrate explorer-l* pipeline: ensure (build↑ stitch from frontiers) and
  answer/context-pack (query↓ L2→L1→code pointers). On-demand generate-human to
  .explorer/L{N}.md in the repo. Use when the user says /explorer-query, context-pack,
  ensure-domain, or list-projections. Prefer this over broad repo grep.
---

# explorer-query

## Build ↑

```bash
node skills/explorer-query/cli.mjs ensure \
  --namespace demo --system-namespace demo-system \
  --repos svc-a,svc-b \
  --frontier-dir /path/to/frontiers \
  --system-db /tmp/sys.sqlite \
  --config-map B_URL=svc-b
```

## Query ↓

```bash
node skills/explorer-query/cli.mjs answer \
  --system-namespace demo-system \
  --edges /path/edges.json \
  [--journey journey.json] \
  [--question "debits"] \
  [--repo-root . --with-projections]
```

Default `answer` is the legacy path. It reads edges/JourneySpec and does not
open or create Slice tables.

## Persistent Context Slice (opt-in)

```bash
node skills/explorer-query/cli.mjs slice \
  --system-namespace demo-system \
  --system-db /tmp/system.sqlite \
  --l0-db /tmp/l0.sqlite \
  --policy journey \
  --seeds /tmp/seeds.json

node skills/explorer-query/cli.mjs slice-show \
  --system-db /tmp/system.sqlite \
  --slice-hash <64-hex>

node skills/explorer-query/cli.mjs answer --use-slice-cache \
  --system-namespace demo-system \
  --system-db /tmp/system.sqlite \
  --l0-db /tmp/l0.sqlite \
  --policy journey \
  --seeds /tmp/seeds.json
```

`--use-slice-cache` is opt-in. Rollback is removing the flag; the legacy
`answer` path remains compatible and does not require deleting cache rows.

Slice identity is derived from normalized seeds, traversal policy/version,
options hash, accepted L0 baseline hashes, scoped L1 edge-set hash, scoped L2
bind hashes, engine version and schema version. Any policy-relevant change must
miss and create a new `slice_hash`; `context_slice_current` is only a current
pointer for the same `(system_namespace, policy_name, seed_set_hash)`.

Policies:

- `journey@1`: ordered L2 journey steps, bound edges, explicit gaps.
- `impact@1`: upstream, downstream, cross-service, and explicit typed data dependencies.
- `drill-down@1`: forward allowlist with `max_hops` option.

Coverage/misses are part of the Slice. Pack budgets are applied only by the
Context Pack projection (`max_nodes`, `max_edges`, `max_chars`) and do not stop
materialization. `max_chars` is a deterministic estimator, not a token promise.

Metrics are local/in-process only: `cache_hit`, `cache_miss`,
`materialization_ms`, `nodes`, `edges`, `misses_by_reason`,
`slice_query_scan_rows`, `pack_truncated`. No remote telemetry.

Safe retention:

```bash
node skills/explorer-query/src/slice-gc-cli.mjs --db /tmp/system.sqlite
node skills/explorer-query/src/slice-gc-cli.mjs --db /tmp/system.sqlite --execute --keep-current
```

`slice-gc` is dry-run by default, deletes only `context_slice_*`, preserves
L0/L1/L2, and never runs `VACUUM`.

Deferred: FTS5 search, process-wide single-flight, optimized incremental
rematerialization, and explorer-l3. Do not promise these in answers.

## Human projection (on-demand, repo primary)

```bash
node skills/explorer-query/cli.mjs generate-human \
  --repo-root . --layer l1 --from-pack pack.json

node skills/explorer-query/cli.mjs list-projections --repo-root .
```

**Protocol:** run `answer` / `list-projections` before broad codebase search.
Never auto-write `.explorer/*.md` on stitch — only `generate-human`.
Never treat a Slice, Pack, generated Markdown, or diagram as an accepted L0/L1/L2 fact.
