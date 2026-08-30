# ai-dev-harness

Repositório independente para evoluir o Harness por uso real. Agnóstico a projeto e a empresa.

## O que é este repositório

O Harness é uma camada de composição sobre `opencode`/`jcode` que adiciona workflows versionados, contratos de agentes e o Project Knowledge Graph. Ele não é um runtime novo, não tem dependências de pacote e não tem remote nesta etapa.

Os arquivos aqui são documentos vivos. Skills project-local e contratos versionados vivem neste repositório; código de domínio de cada empresa continua nos repositórios de projeto.

## Princípios

**Docs-first.** Nenhum workflow vira executável antes de ter FLOW.md aprovado. O documento é o contrato; a implementação vem depois.

**YAGNI.** Só o que o workflow aprovado precisa. Store e skill entram quando o contrato e o Gate autorizam — não antes.

**Grafo como fonte factual.** O Project Knowledge Graph é a fonte de verdade sobre um projeto. Diagramas são projeções descartáveis de um Context Slice, não documentação autônoma.

**Decisões baseadas em evidência.** Propostas permanecem overlays até aprovação. Afirmações de sucesso sem evidência executável não concluem nada.

**Namespaces e fronteiras de dados estritos.** Cada projeto tem namespace próprio. Conhecimento corporativo não é promovido automaticamente para o namespace pessoal; só padrões sanitizados e aprovados explicitamente cruzam essa fronteira.

## Por que Project Onboarding vem primeiro

O onboarding constrói o Project Knowledge Graph baseline. Sem ele, não há evidência factual para alimentar os workflows seguintes.

Dependem diretamente desse grafo:

- **Technical Discovery** para mapear serviços, contratos e jornadas.
- **`html-diagram`** para projetar arquitetura navegável a partir de um Context Slice.
- **`/grill-me`** para questionar decisões com base em fatos do projeto, não suposições.

Onboarding primeiro garante que os outros workflows trabalhem com evidência real, não com memória de sessão.

## Descobrir

Descobrir indexa conhecimento verificável e prepara um **baseline candidate**.
Os schemas em `workflows/descobrir/contracts/` são a fonte de verdade do
contrato de dados. A skill de produção é **operacional** (ADR 0005 + ADR 0006):
Graphify + Explorer + guardrails + SQLite + (opcional) projeção Obsidian.

**Status atual:**

| Gate / artefato | Estado |
|---|---|
| Gate A (contrato) | Aprovado por Marley em 2026-08-02 |
| Protótipo descartável `prototypes/descobrir-v1/` | Existe — **não** é runtime de produção |
| Skill **`explorer-l0`** (alias `/descobrir`) | L0 index (Graphify + Explorer + finalize + accept) |
| Skill **`explorer-l1`** (alias `/l1`, `/graph-system`) | L1 stitch + callers/callees |
| Skill **`explorer-l2`** | JourneySpec bind + gaps |
| Skill **`explorer-query`** | ensure ↑ · answer/context-pack ↓ · Slice persistente opt-in · generate-human (repo) |
| Human Gate (baseline aceito) | Explícito; **nunca** auto-accept |
| FTS5 / single-flight / L3 / Neo4j / Docker / grafo incremental | **Deferred** |

### Escopo explorer-l* 

| Item | Estado |
|---|---|
| `explorer-l0` (+ alias descobrir) | Entregue |
| Graphify pinado `0.9.32` em worktree isolada | Entregue |
| prepare / finalize determinísticos | Entregue |
| `export-frontier` L0 → L1 | Entregue |
| `explorer-l1` stitch (git ou frontier-dir) | Entregue |
| `explorer-l2` journey bind | Entregue |
| `explorer-query` ensure / answer / generate-human | Entregue |
| Projeção humana `.explorer/L{N}.md` on-demand | Entregue |
| Context Slice persistente SQLite (`slice`, `slice-show`, opt-in `answer`) | Entregue |
| L3, incremental update, Neo4j | Deferred |

### Operação rápida

```bash
# 1) Install skills (recomendado — um comando)
node packages/explorer-skills/bin/opencode-explorer.mjs install
node packages/explorer-skills/bin/opencode-explorer.mjs setup

# ou, depois de publicar no npm:
#   npx opencode-explorer install && npx opencode-explorer setup

# (alternativa manual)
# node skills/explorer-l0/install.mjs install
# node skills/explorer-l1/install.mjs install

# 2) Setup Graphify pinado (uma vez por máquina)
node skills/explorer-l0/cli.mjs setup
node skills/explorer-l0/cli.mjs setup-status

# 3) L0 index (OpenCode: /explorer-l0  ou alias /descobrir)
node skills/explorer-l0/cli.mjs prepare \
  --namespace <ns> --logical-repo <repo> --project-path <abs-git-root>
node skills/explorer-l0/cli.mjs finalize \
  --run-root <abs-run-root> --db <store.sqlite> --source-repo <abs-git-root>
node skills/explorer-l0/cli.mjs accept --db <store.sqlite> \
  --candidate-id <id> --approver "Marley"

# 4) Pipeline hermético (fixtures — sem monorepo)
node --test skills/explorer-l0/test/frontier-export.test.mjs
node --test skills/explorer-l1/test/*.test.mjs
node --test skills/explorer-l2/test/*.test.mjs
node --test skills/explorer-query/test/*.test.mjs
node skills/explorer-query/e2e/run.mjs
node skills/explorer-query/e2e/context-slice-run.mjs

# 5) Query / human projection (on-demand)
# node skills/explorer-query/cli.mjs answer --edges edges.json --system-namespace sys
# node skills/explorer-query/cli.mjs generate-human --repo-root . --layer l1 --from-pack pack.json

# 6) Context Slice persistente (opt-in; rollback = remover --use-slice-cache)
# node skills/explorer-query/cli.mjs slice \
#   --system-namespace sys --system-db system.sqlite \
#   --l0-db l0.sqlite --policy journey --seeds seeds.json
# node skills/explorer-query/cli.mjs slice-show \
#   --system-db system.sqlite --slice-hash <64-hex>
# node skills/explorer-query/cli.mjs answer --use-slice-cache \
#   --system-namespace sys --system-db system.sqlite \
#   --l0-db l0.sqlite --policy journey --seeds seeds.json
# node skills/explorer-query/src/slice-gc-cli.mjs --db system.sqlite
```

**Paths centrais (defaults):**

- DB: `${XDG_DATA_HOME:-~/.local/share}/descobrir/<namespace>.sqlite` (`0600`)
- Runs: `${XDG_CACHE_HOME:-~/.cache}/descobrir/runs/<run-id>/`
- L1 edges: tabelas `system_edges` / `system_stitch_runs` no mesmo DB (ou `--system-db`)
- Context Slice: tabelas `context_slice_*` no `--system-db`; `context_slice_current` é ponteiro derivado, não fonte canônica
- Após `install`/`uninstall`: **quit e restart OpenCode**

**Exit codes:** `0` ok · `1` erro infra/typed · `2` blockers semânticos (sem write parcial no DB)

**Slice vs Pack vs diagrama:** L0/L1/L2 são fatos aceitos; Context Slice é cache derivado completo; Context Pack é projeção budgetada para agente; HTML/C4 é projeção descartável. Budgets de Pack não prometem token exato. Métricas locais: `cache_hit`, `cache_miss`, `materialization_ms`, `nodes`, `edges`, `misses_by_reason`, `slice_query_scan_rows`, `pack_truncated`.

### Navegação Descobrir

- L0: [`skills/explorer-l0/SKILL.md`](skills/explorer-l0/SKILL.md)
- L1: [`skills/explorer-l1/SKILL.md`](skills/explorer-l1/SKILL.md)
- L2: [`skills/explorer-l2/SKILL.md`](skills/explorer-l2/SKILL.md)
- Query: [`skills/explorer-query/SKILL.md`](skills/explorer-query/SKILL.md)
- ADR 0008: [`docs/adr/0008-explorer-l-pipeline.md`](docs/adr/0008-explorer-l-pipeline.md)
- ADR 0010: [`docs/adr/0010-persistent-context-slice-cache.md`](docs/adr/0010-persistent-context-slice-cache.md)
- Plano: [`.omo/plans/pkg-pipeline-l0-l1-l2-context.md`](.omo/plans/pkg-pipeline-l0-l1-l2-context.md)
- E2E hermético: [`skills/explorer-query/e2e/run.mjs`](skills/explorer-query/e2e/run.mjs)

## Mapa de arquivos

```
ai-dev-harness/
├── skills/
│   ├── explorer-l0/      # index micro (ex-descobrir)
│   ├── explorer-l1/      # system edges (ex-l1)
│   ├── explorer-l2/      # journeys
│   └── explorer-query/   # ensure + answer + generate-human
├── docs/adr/0008-explorer-l-pipeline.md
└── docs/adr/0010-persistent-context-slice-cache.md
```

## Navegação

- Fluxo detalhado do onboarding: [`workflows/project-onboarding/FLOW.md`](workflows/project-onboarding/FLOW.md)
- Vocabulário do domínio: [`docs/domain/glossary.md`](docs/domain/glossary.md)
- Decisão sobre grafo e projeções: [`docs/adr/0001-graph-source-diagram-projection.md`](docs/adr/0001-graph-source-diagram-projection.md)
- Exemplo com o Demo: [`examples/demo/README.md`](examples/demo/README.md)
