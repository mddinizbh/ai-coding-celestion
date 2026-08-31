# Plano — grafo canônico + journal compartilhado

> Continuar **depois** de fechar o ritual local neste repo. Banco aqui é
> Docker (Postgres + Mongo) pra validar; depois o mesmo desenho aponta pra
> host real. App corporativa não se constrói neste git.
>
> Tarefas: projeto Linear [ai-dev-celestion](https://linear.app/uai-mk/project/ai-dev-celestion-f10118147316).

Decisão: **os dois**. Journal compartilhado desde o primeiro adapter remoto.
Grafo canônico da master, com accept humano e papel. Cada pessoa ainda pode
ter rascunho local.

Não reabre: grafo sempre da master; Human Gate; skills não abrem DB por path
hardcoded (`--db` / config); Graphify na máquina de quem indexa.

---

## O que já está neste repo (não refazer)

| Peça | Onde | Nota |
|---|---|---|
| L0 mecânico | `skills/explorer-l0` `emit-payloads` | volume sem LLM |
| Journal local | `skills/explorer-ops` → `~/.local/share/descobrir/ops.sqlite` | `log` / `list` / `challenges` |
| Indexer pergunta repos | `agents/opencode/explorer-indexer.md` | Fase 1 entrevista; Gate; log no ops |
| Grafo local | `~/.local/share/descobrir/<namespace>.sqlite` | L0 candidates + accepted; L1 no mesmo ou `--system-db` |
| Porta | `--db` na maioria das CLIs | ops também aceita `--db` |

Auditor B+C está implementado em `skills/explorer-audit` e
`agents/opencode/explorer-auditor.md`.

---

## Dois stores, duas perguntas

```
journal (SQL)     → "quais dores o time está vendo?"
grafo  (documento) → "qual a master aceita deste namespace?"
```

Não um bucket único. O agente de melhoria lê **journal agregado**, não o
`package_json` inteiro.

### Journal (primeiro a plugar remoto)

- Linha por fase: namespace, repos, phase, status, detail, challenge code,
  how_we_attacked.
- Já existe o schema em `skills/explorer-ops/src/schema.mjs`.
- Remoto: API boba + **SQL** (Oracle no destino). Skills continuam falando
  `log` / `challenges`; o adapter troca o SQLite por HTTP.
- Scrub na borda: sem path de máquina (`/Users/…`), sem host, sem secret.
  O L0 já recusa isso no grafo; o ops ainda precisa da mesma regra no `detail`.

### Grafo canônico (depois)

- Documento = candidate package L0 + edges L1 (JSON que já persistimos).
- Destino natural: **Mongo** (ou equivalente documento). Não re-modelar em
  tabelas Oracle no v1.
- Accept compartilhado: um baseline por `(namespace, logical_repo)` na master,
  com `approver` + papel. Rascunho local não pisa nisso.
- Freshness continua: publicar só revisão de master; senão o store vira wiki.

Indexar continua **local** (Graphify + emit-payloads + finalize). Publicar é
um passo depois do Gate.

---

## Ordem de construção (lá, não aqui)

1. App/dev: API do **journal só** (CRUD `log`/`list`/`challenges`). Time já
   gera dado heterogêneo.
2. Adapter na skill `explorer-ops`: se `OPS_URL` (ou `--db` URL) → HTTP; senão
   SQLite. Skills não ganham driver Oracle.
3. Auditor B+C (se ainda não existir neste repo) gravando no mesmo journal.
4. Porta do **grafo**: publish candidate aceito → Mongo; query lê o canônico.
5. Agente “lê histórico e planeja”: input = challenges agrupados por `code`,
   não dump de grafo.

---

## Falta **aqui** (este git)

Antes de levar:

- [x] **Auditor B+C** — `explorer-auditor` + skill `explorer-audit`
      (`sample` / `omissions` / `show`). Journal via ops. Não gera grafo.
- [ ] **Installer** — `explorer-ops` + comando `/explorer-indexer` no
      `opencode-explorer install` (hoje o ops só está no tree).
- [ ] **Scrub no `ops` `detail`/`challenge-detail`** — recusar path absoluto
      igual o L0.
- [ ] **L1: `template` não nasce edge** (ou nasce hipótese). Os 5 falsos
      `/private/{param}` do tax→crlv.
- [ ] Adapter L1 Kafka/Python — só se C do auditor confirmar omissão em
      volume; senão YAGNI.

Não falta: emit-payloads, Gate, freshness, journal local, indexer que pergunta
repos.

## Falta **lá** (app + banco)

- [ ] Serviço HTTP do journal (auth do ambiente).
- [ ] Schema Oracle alinhado a `ops_runs` / `ops_challenges`.
- [ ] Coletor: cada `cli.mjs log` no membro publica na API (depois do passo 2
      aqui).
- [ ] Mongo: collection de packages aceitos + system edges; id estável
      `(namespace, logical_repo, graph_hash)`.
- [ ] Papel de accept canônico vs rascunho pessoal.
- [ ] UI mínima opcional (listar challenges por code). Query do grafo pode
      esperar o `/explorer-query` apontando no canônico.

---

## Contrato pra não estragar

- Skills nunca importam cliente Oracle/Mongo.
- `--db` / env da porta. Path hardcoded = regressão.
- Journal compartilhado ≠ baseline compartilhado. Accept humano no canônico.
- Grafo da master. Feature branch no máximo rascunho local.
- Agente de melhoria consome **challenges**, cap de contexto, exemplos
  file:line já scrubados.
