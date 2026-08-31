---
name: explorer-l0
description: >
  Explorer L0 — index one Git repository into a Project Knowledge Graph baseline
  candidate (Graphify + Explorer semantics + finalize + accept). Use when the user
  says /explorer-l0, /descobrir (alias), baseline candidate, Graphify isolation,
  or Human Gate acceptance of structural knowledge records. Not L1 stitch (/explorer-l1)
  and not query orchestration (/explorer-query).
---

# explorer-l0 — baseline candidate (micro / L0)

Operates a Git project in one invocation: it checks Graphify, prepares an isolated
Graphify extraction, dispatches the deterministic chunks to the Explorer for semantic
enrichment, finalizes a verified candidate, and persists it to the central SQLite
store. The user supplies only project/config intent. No intermediate JSON is hand
edited, and Graphify is invoked by the skill — never manually by the user.

**Semantic LLM extraction is untrusted and stochastic.** Determinism applies only to:
output shape, schema validation, canonical IDs, normalization, stable ordering,
`canonical_graph_hash`, pinned-revision verification, CoverageReport derivation
(`passed`/counts), and transaction behavior.

Do **not** mark claims `comprovado` without repository evidence verified at the
pinned revision. Draft `status:"comprovado"` is downgraded unless `readAtRevision`
verifies pinned bytes. Do **not** auto-accept. Acceptance is an explicit
**Human Gate**.

Contracts (source of truth, self-contained): `contracts/*.schema.json` in this skill
Spec (condensed flow): repo `docs/spec/explorer-l0-contract.md` · ADRs: `docs/adr/0005`, `docs/adr/0008`

## One-invocation protocol (strict phase order)

The `/descobrir` command and the protocol module (`src/descobrir-protocol.mjs`)
implement a strict, observable phase order. Never skip, reorder, or run a later
phase before an earlier one completes:

1. **setup-status** — `cli.mjs setup-status`. Verify `graphifyy==0.9.32` is
   installed via `uv tool`. On missing or version mismatch, **stop** and emit
   the setup instruction (`cli.mjs setup`). Do **not** fall back to a manual
   Graphify command.
2. **prepare** — `cli.mjs prepare --namespace <ns> --logical-repo <repo>
   --project-path <path> [--source-revision <sha>] [--db <path>]`. Creates the
   isolated worktree, runs `graphify extract --code-only --no-cluster --out`
   inside it, projects stable chunks, builds the Artifact Manifest and run
   descriptor, then removes the worktree. Emits `{status:"prepared", run_id,
   chunk_index, manifest_id, descriptor_sha256, phase_timings_ms, graphify}` —
   no absolute paths in stdout.
3. **Explorer chunk dispatch** — for each chunk in `chunk_index.chunks`, dispatch
   one **`explorer-worker`** subagent (the cheap tier — the payload below is
   closed-shape and deterministic `finalize` recomputes everything, so the
   worker never needs a strong model; model binding is local to each member).
   The subagent reads its chunk file under the run root
   and writes exactly one payload to `explorer/payloads/<chunk_key>.json` using
   the closed Explorer contract below. No intermediate JSON is authored by the
   user. Failed chunks (those returning `retryable` blockers such as a banned
   authority field) are **re-dispatched in place** up to **3 attempts**; chunks
   that already succeeded are never re-dispatched.
4. **finalize** — `cli.mjs finalize --run-root <run_root> --db <db.sqlite>
   --source-repo <path>`. Validates prepared artifacts, merges payloads,
   re-derives evidence/ids/hash/coverage from the pinned Git reader, and
   persists the candidate idempotently. Returns either
   `{status:"finalized", candidate_id, canonical_graph_hash, coverage}` or
   `{status:"blocked", exit_code:2, blockers, retryable_chunk_keys}` with no
   DB write on blocked.

**Completion criteria**

- Status `finalized` AND `coverage.repository_verified_percentage > 0` AND
  `coverage.mutation_equivalent === true` → the candidate is persisted and
  ready for the explicit Human Gate (`cli.mjs accept`).
- Status `setup_required` → stop, surface the setup command, then resume from
  phase 1.
- Status `prepare_failed` → surface the cause; resume from phase 2 once fixed.
- Status `blocked` (dispatch) → the `failed_chunk_keys` exhausted retries; the
  run_id is preserved. Either re-dispatch with a corrected Explorer
  instruction and re-run `finalize`, or `cleanup --run-id <run_id> --force`
  to drop the run.
- Status `finalize_blocked` → blockers list the offending chunk keys and the
  offending field/locator. Re-dispatch only `retryable_chunk_keys`, then re-run
  `finalize` (idempotent: no duplicate candidate is written).

**Recovery / cancellation**

- If the protocol is interrupted (process killed, OpenCode session stopped,
  user Cancel), inspect leftover runs with `cli.mjs status`, then
  `cli.mjs cleanup --stale` to remove incomplete run roots, or
  `cli.mjs cleanup --run-id <id> [--force] [--source-repo <repo>]` to remove a
  specific run. Cleanup never touches SQLite candidates; it removes only run
  scratch space and, when `--source-repo` is supplied, force-unregisters
  leftover worktrees via the existing worktree helpers.
- Source working tree is never mutated. Prepare captures pre/post snapshots and
  asserts `mutation.equivalent === true`. A mutated source fails the run, never
  the user's working tree.

## Explorer output contract (exact)

Emit **one JSON object** per chunk to `explorer/payloads/<chunk_key>.json`.
Unknown fields are rejected. **No** `confidence`, `artifact_id`, prose scores,
`id`, `status`, `evidence`, `canonical_graph_hash`, `path`, `uri`, absolute
paths, raw source, or invented endpoint/call-chain schemas.

```json
{
  "chunk_key": "<chunk_key from chunk_index>",
  "records": [
    {
      "node_key": "<opaque node key from chunk>",
      "type": "Service",
      "natural_key": "billing",
      "name": "Billing",
      "summary": "short factual summary",
      "attributes": {}
    }
  ],
  "relations": [
    {
      "edge_key": "<opaque edge key from chunk>",
      "relation_type": "EXPOSES",
      "from_type": "Service",
      "from_natural_key": "billing",
      "to_type": "Endpoint",
      "to_natural_key": "get:/billing"
    }
  ]
}
```

Rules:

- Every record/relation MUST reference opaque keys present in the dispatched
  chunk. Inventing keys, deriving IDs, or smuggling repository paths is a
  `retryable` blocker.
- Relation endpoints must exist in the merged record set after canonical ID
  recomputation.
- Relations must not be self-edges and must use a supported `relation_type`.
- `chunk_key`, `node_key`, `edge_key` are the ONLY keys the Explorer supplies
  that the deterministic stages treat as opaque references. Everything else
  (canonical IDs, hashes, evidence, coverage, status, acceptance) is recomputed.

## Guardrails (deterministic, owned by finalize)

- Reject banned/unknown fields (`confidence`, `path`, `uri`, `evidence`, `id`,
  `status`, `canonical_graph_hash`, …).
- Recompute all canonical IDs; reject duplicates; sort by id.
- Recompute relation endpoints/ids from natural keys; reject missing natural-key
  fields; reject relations whose endpoints are missing from the record set.
- Reject artifact evidence that does not resolve against the manifest.
- Downgrade draft `comprovado` → `hipótese` unless `readAtRevision` verifies
  repository evidence via the pinned Git reader.
- Build `graph_index` and `canonical_graph_hash` (summary excluded from hash).
- Recompute CoverageReport from closed inputs; never trust the Explorer for
  `passed`, provenance, or coverage.
- `mutation.equivalent` is recomputed from `pre`/`post` snapshots; the caller
  boolean is never authority.
- Same-key persist with divergent package JSON is rejected (collision);
  identical JSON is idempotent (created=false).

## CLI surface

`L0CLI` below is the path to this skill's `cli.mjs` (repo: `skills/explorer-l0/cli.mjs`;
installed: `~/.config/opencode/skills/explorer-l0/cli.mjs`).

```bash
# Protocol phases
node "$L0CLI" setup-status
node "$L0CLI" setup
node "$L0CLI" prepare \
  --namespace <ns> --logical-repo <repo> --project-path <path> \
  [--source-revision <sha>] [--db <path>]
node "$L0CLI" finalize \
  --run-root <run_root> --db <db.sqlite> --source-repo <path>

# Recovery
node "$L0CLI" status
node "$L0CLI" cleanup --stale
node "$L0CLI" cleanup --run-id <id> [--force] [--source-repo <repo>]

# Human Gate (only after explicit acceptance)
node "$L0CLI" accept --db <store.sqlite> \
  --namespace <ns> --logical-repo <repo> --graph-hash <hex> --approver "<nome do aprovador>"

# Audit/export (JSON is export-only; SQLite is canonical)
node "$L0CLI" export --db <store.sqlite> \
  --namespace <ns> --logical-repo <repo> --accepted --output <out.json>

# Legacy draft persist (canonicalizes but cannot verify repository bytes)
node "$L0CLI" persist-candidate --db <store.sqlite> --input <draft.json>
```

## Central store

- DB: `${XDG_DATA_HOME:-~/.local/share}/descobrir/<namespace>.sqlite`, mode `0600`.
- Run scratch: `${XDG_CACHE_HOME:-~/.cache}/descobrir/runs/<run_id>/`, mode `0700`.
- Multiple candidates per namespace + logical repo (keyed by revision + graph hash).
- One accepted baseline pointer per namespace + logical repo (atomic upsert).
- Idempotent persist for the same key. Namespace isolation on all queries.

## Out of scope (this skill)

- L1/L2 macro-flow, Neo4j, Docker, external LLM SDK
- Auto-accept, normalized entity/evidence SQL tables, prototype imports

## Tests

```bash
node --test skills/descobrir/test/*.test.mjs
```
