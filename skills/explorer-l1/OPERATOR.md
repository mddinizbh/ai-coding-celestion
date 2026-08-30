# L1 OPERATOR

## What

Cross-service stitch on **accepted** Descobrir L0 baselines. Writes
`system_edges` / `system_stitch_runs` only. Edges may be `http-sync`,
`webhook`, `cron` or `queue`; `internal` continuity belongs to L2/L0.

## Install

```bash
node skills/l1/install.mjs install
# quit + restart OpenCode
node skills/l1/install.mjs status
```

## Coverage first (`frontier-report`)

An empty stitch is almost never "these services do not talk" — it is usually
"this repo was never parsed". Run the coverage report before trusting silence:

```bash
node skills/explorer-l1/cli.mjs frontier-report \
  --namespace demo --system-namespace demo-system \
  --repos "cloud=/path/cloud,portal=/path/portal"
# --revision <sha> reports on a repo that has no accepted baseline yet
```

Per repo it prints files scanned vs skipped (with the top skipped extensions),
which extractor claimed each file, facts by kind, and a `trust` verdict.
Exit code is **2** when any repo produced zero facts.

`stitch` enforces the same rule: a repo with an empty frontier returns
`status: "blocked"`, exit code 2, and **persists nothing**. Override with
`--allow-empty-frontier` when the emptiness is genuinely expected.

## Config map (what turns a guess into evidence)

A path-only match scores **0.55**; the same match scores **0.95** when the
caller's base-URL env key is mapped to the target repo. That map is project
data, resolved per system namespace (later wins):

1. legacy built-ins (deprecated, reported as `legacy_builtin`)
2. `skills/explorer-l1/config/<system-namespace>.config-map.json`
3. `<dirname(system_db)>/config-maps/<system-namespace>.json`
4. `--config-map-file <path>`
5. `--config-map KEY=repo,KEY2=repo2`

Both `stitch` and `frontier-report` print `unmapped_config_keys` — the keys seen
in the frontier that would promote edges if you mapped them.

## Language extractors

JVM rules (Spring, Micronaut, `@Value`, YAML, cron) live inline in
`src/frontier-extract.mjs` and are the default path. Other languages and file
shapes are adapters under `src/adapters/`, each owning its own assumptions and
declaring what it is blind to via `describes()`.

| Adapter | Reads | Emits |
|---|---|---|
| `go-huma` | `*.go` | `http_inbound` from `huma.Operation{}` |
| `route-manifest-yaml` | `demo.yaml` | `http_inbound` (the app's OWN routes) |
| `js-http-client` | `**/lib/**.js`, `*-client.js` | `http_outbound` + `config_binding` |

Adding a language = one file + one line in `src/adapters/index.mjs`.

`route-manifest-yaml` exists to fix a **direction** bug: the generic YAML rule
reads any `"/api/..."` literal as an outbound call, so a route manifest produced
arrows pointing the wrong way and any edge from it matched by accident.

## Acme proof

```bash
CRON=/Users/dev/projects/Acme/acme-cron
acme=/Users/dev/projects/Acme/acme-tax
RJ=/Users/dev/projects/Acme/tax-provider-alt

node skills/explorer-l1/cli.mjs stitch \
  --namespace acme \
  --system-namespace acme-system \
  --repos "acme-cron=$CRON,acme-tax=$acme,tax-provider-alt=$RJ" \
  --full

node skills/explorer-l1/cli.mjs callers \
  --namespace acme --system-namespace acme-system \
  --repo tax-provider-alt
```

Or:

```bash
node skills/explorer-l1/e2e/acme-pair.mjs
```

## Tests

```bash
node --test skills/explorer-l1/test/*.test.mjs
```

## Safety

- Never mutates L0 `candidate_packages` / accept rows beyond sharing the DB file.
- Never auto-accept.
- Evidence = `contract-matched` only.
- A connected edge proves the transport contract, not the business rule inside either body.
