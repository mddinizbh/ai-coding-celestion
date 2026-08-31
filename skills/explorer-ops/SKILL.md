---
name: explorer-ops
description: >
  Playbook operacional do pipeline Explorer (L0 mecânico, Gate, L1) e journal
  SQLite das runs. Use quando for indexar, quando um finalize/stitch
  bloquear, ou quando o usuário pedir desafios de runs anteriores.
  Antes de uma run nova, liste challenges. Depois de cada fase, grave log.
---

# explorer-ops — playbook + journal

Dois trabalhos: **como rodar** (o que esta validação ensinou) e **o que
guardar** (cada fase vira linha no SQLite, pra próxima sessão ler).

Store: `${XDG_DATA_HOME:-~/.local/share}/descobrir/ops.sqlite` (não o grafo).
CLI: `node skills/explorer-ops/cli.mjs`.

## Antes de indexar

```bash
node skills/explorer-ops/cli.mjs challenges --limit 20
```

Leia os `code`s. Se o blocker da run atual já apareceu, use o
`how_we_attacked` em vez de reinventar.

## Como rodar L0 (volume)

Ordem estrita. O agente **executa** os CLIs; não spawna LLM por chunk.

1. `explorer-l0 setup-status`
2. Pergunte namespace + repos (isso é do indexer).
3. Por repo, cap 2–3 em paralelo: `prepare` → `emit-payloads` → `finalize`
4. Human Gate. Sem auto-accept.
5. Grave a fase:

```bash
node skills/explorer-ops/cli.mjs log \
  --phase finalize --status ok \
  --namespace <ns> --repos <logical_repo> \
  --run-id <run_id> \
  --detail '{"coverage":87}'
```

Blocker:

```bash
node skills/explorer-ops/cli.mjs log \
  --phase finalize --status blocked \
  --namespace <ns> --repos <logical_repo> \
  --challenge missing_payload \
  --challenge-detail "esqueceu emit-payloads" \
  --how-we-attacked "rodar emit-payloads --run-root <run_id> e re-finalize"
```

## Blockers que já vimos (ataque)

| code | o que é | ataque |
|---|---|---|
| `missing_payload` | não rodou emit-payloads, ou arquivo `c:0000.json` em vez de `c_0000.json` | `emit-payloads`; filename `:` → `_` |
| `unsupported_relation` | relation cujo endpoint não está no record set | encoder mecânico com **mapa global** de nós (já é o emit-payloads) |
| `duplicate_conflict` | mesmo (type, natural_key), summary diferente | `natural_key` = `graphify_id` copiado; não inventar record de edge |
| `unknown_node_key` | `node_key` não é a chave opaca `n:…` | `node_key` = `fact.key` |
| `invalid_shape` | faltou `from_type`/`to_type`/`attributes` | não usar LLM no hot path |
| `empty_repos` (L1) | frontier HTTP vazia (ex.: Python/Kafka) | não é bug de Gate; falta adapter ou o par não se chama |
| `template` L1 score 0.5 | overlap `/private/{param}` | ler só `path_match=exact` |
| `audit_rejected` | auditor B: código pinado não sustenta a ligação | não tratar como contrato; AIDEV-01.4 |
| `l1_omission` | auditor C: HTTP/Kafka/Python no pinado sem fato L1 | adapter só se volume confirmar; senão YAGNI |

Não despache `explorer-worker` por chunk. Volume = `emit-payloads`.

## L1

Stitch depois de **todos** os L0 aceitos. Python/Kafka não aparece na frontier
Java/Kotlin. Config-map gaps: subagente `explorer-matcher` (allow-list do indexer).

## Journal

```bash
node skills/explorer-ops/cli.mjs list --namespace uai --limit 20
node skills/explorer-ops/cli.mjs challenges --code missing_payload
```
