---
name: explorer-l1
description: >
  Explorer L1 — stitch cross-service system edges from accepted explorer-l0
  baselines. Use when the user says /explorer-l1, /l1 (alias), /graph-system (alias),
  system edges, callers/callees cross-repo, or contract-matched joins. NOT for L0
  indexing (/explorer-l0) and NOT for journey L2 (/explorer-l2).
---

# explorer-l1 — cross-service stitch (L1)

Stitches **accepted L0 baselines** into a **system namespace** of
`contract-matched` edges. The result is a structural skeleton with source
pointers, not a substitute for reading implementation bodies. Does **not**
re-run Graphify. Does **not** merge L0 namespaces.

## CLI

```bash
node skills/explorer-l1/cli.mjs stitch \
  --namespace <ns> --system-namespace <sys> \
  --repos a=/path/a,b=/path/b \
  [--pair a->b] [--frontier-dir /path] [--dry-run] [--full]

node skills/explorer-l1/cli.mjs frontier-report \
  --namespace <ns> [--system-namespace <sys>] --repos a=/path/a,b=/path/b [--revision <sha>]

node skills/explorer-l1/cli.mjs status --namespace <ns> --system-namespace <sys>
node skills/explorer-l1/cli.mjs callers --namespace <ns> --system-namespace <sys> --repo <logical>
node skills/explorer-l1/cli.mjs callees --namespace <ns> --system-namespace <sys> --repo <logical>
```

## Trigger model

| Trigger | L1 source | Match |
|---------|-----------|-------|
| `http-sync` | HTTP client → controller | config binding, then path contract |
| `webhook` | HTTP contract whose path is webhook/notification | same HTTP matcher |
| `cron` | active crontab `curl` operations | each poll/fan-out call becomes one edge; `pipeline_id` links the line |
| `queue` | topic publisher → topic consumer | normalized topic contract |
| `internal` | not an L1 edge | added by L2 from accepted L0 call relations |

Cron extraction preserves `schedule`, config key, operation order and exact
`file:line`. Common JVM Kafka/SQS/SNS/Rabbit/JMS publishers and consumers are
exported as topic facts. Unknown runtime values remain config-key references;
they are never guessed.

Matcher order: **config_binding**, path contract, topic contract. Evidence
class remains `contract-matched`. The additive trigger metadata is persisted in
the existing `edge_json`; no SQLite migration is required.

## Coverage, config map e extractores

Zero fatos de fronteira num repo → `status: "blocked"`, exit 2, **nada
persistido** (`--allow-empty-frontier` para forçar). Antes de acreditar num
stitch vazio, rode `frontier-report`: ele mostra arquivos varridos vs ignorados,
qual extractor reivindicou cada arquivo, fatos por tipo e um veredito `trust`.

O config map (env de base-URL → logical_repo) é o que promove um edge de `0.55`
(palpite por path) para `0.95` (evidência de configuração). Ele é dado de
projeto, resolvido por system namespace, nesta ordem: built-ins legados →
`config/<sys>.config-map.json` → `<dir-do-store>/config-maps/<sys>.json` →
`--config-map-file` → `--config-map K=repo`. `stitch` e `frontier-report`
imprimem `unmapped_config_keys` — as chaves que promoveriam edges se mapeadas.

As regras JVM (Spring, Micronaut, `@Value`, YAML, cron) seguem inline em
`src/frontier-extract.mjs`. Outras linguagens são adapters em `src/adapters/`,
cada um declarando o que enxerga e **o que não enxerga** (`describes()`).
Incluídos: `go-huma` (rotas `huma.Operation{}`), `route-manifest-yaml`
(`demo.yaml` → rotas **de entrada** do próprio app) e `js-http-client`
(clientes JS: `process.env.X_URL` + path literal → saída **com** config key).
Adicionar linguagem = 1 arquivo + 1 linha no `src/adapters/index.mjs`.

Install: `node skills/explorer-l1/install.mjs install`
