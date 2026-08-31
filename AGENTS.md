# ai-coding-celestion

Repo **template do time**: agents + skills para OpenCode. Qualquer membro
clona, instala e usa. Dados de projeto (o `.sqlite` indexado) ficam na máquina
de cada um — neste repo entra só a ferramenta.

pt-BR. Sem nome de empresa no código.

## Padrão

1. Skill = método. Agent `.md` = classe. Invocação = `new` (cwd + este AGENTS.md + prompt).
2. Um coder, muitos `new`. Não uma subclasse por projeto.
3. Workflow = service burro. Orchestrator de código = só coder → reviewer → tester.
4. Uma run = um use case. Sem Kafka, sem memória distribuída, sem 10 loaders na v1.
5. Artefato do brainstorm = `contracts/brainstorm-visao.md` + ponteiro yaml. Não é PRD nem SDD.
6. `code_references` = path + why. Sem colar corpo de arquivo.
7. Skill de terceiros só na allow-list da peça. Não substitui o roster.

## Convenções do grafo (explorer)

- `namespace` = projeto · `logical_repo` = cada repositório. Decide-se uma vez; mudar nome fragmenta o grafo.
- Grafo sempre da **master**. Baseline velho é declarado na consulta, nunca escondido.
- Store: SQLite local (`~/.local/share/descobrir/<namespace>.sqlite`) — porta hexagonal; adapter compartilhado é futuro (ver ROADMAP).
- Human Gate: baseline só vira "aceito" com aprovação humana. Consenso entre agentes não substitui.

## Política de skill

Skills de **escrita** (`explorer-l0/l1/l2`) só são chamadas por agent com
allow-list explícito. `explorer-query` (leitura) é livre.

## Roster

Agents:

| Agent | Status | Nota |
|---|---|---|
| `agents/opencode/brainstorm.md` | ✅ | explorer-query + grilling. Handoff só com frontier vazia |
| `agents/opencode/explorer-indexer.md` | ✅ | Ritual L0 → Gate → L1 (config-map proposto) → freshness; L2 sob demanda |
| `agents/opencode/explorer-auditor.md` | ✅ | Depois do L1: amostra exact/template + omissões HTTP/Kafka/Python; journal; não gera grafo |
| `agents/opencode/roles/explorer-worker|matcher|synth` | ✅ | Tiers de execução do indexer — binding de modelo é local |
| arquiteto, planner, orchestrator, coder, reviewer, tester | futuro | Mesmo padrão fino quando entrarem |

Skills próprias (instaladas via `packages/explorer-skills`):

| Skill | Status | Papel |
|---|---|---|
| `explorer-l0` | ✅ auto-contida | Indexa 1 repo: prepare → emit-payloads → finalize (Human Gate) |
| `explorer-l1` | ✅ | Stitch cross-service. PK v3 + restitch atômico + config-map derivado (llm-assisted: ROADMAP) |
| `explorer-l2` | ✅ | Journeys bottom-up (L1 → L0 → read_plan) |
| `explorer-query` | ✅ | Consulta com freshness (avisa baseline stale vs HEAD) |
| `explorer-ops` | ✅ | Playbook operacional + journal SQLite das runs (desafios) |
| `explorer-audit` | ✅ | Método do auditor: `sample` / `omissions` / `show` (pinado) |
| `architecture-canvas`, `architecture-diagrams`, `db-setup` | ✅ | Complementares (diagrama interativo, docs de arquitetura, Postgres p/ agentes) |

Skills de **terceiros** (superpowers etc.) não são versionadas aqui — ficam
declaradas em `skills.deps.json` e o installer baixa na instalação (modelo
Maven). O `brainstorm` depende de `grilling`/`domain-modeling`, que ainda não
têm fonte distribuída (ver ROADMAP).

O que falta: `ROADMAP.md`. Contrato do L0: `docs/spec/explorer-l0-contract.md`.
Vocabulário: `docs/domain/glossary.md`. Instalação: `README.md`.
