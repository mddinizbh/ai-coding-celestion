# AI Dev Agents

Pipeline de agentes para desenvolvimento de software com Claude Code. Cada fase do desenvolvimento e feita por um agente especializado, com comunicacao estruturada via contratos de handoff em YAML.

## Guia de Instalacao no Projeto

### 1. Instalar o framework (uma vez por maquina)

```bash
git clone https://github.com/marleydiniz/ai-dev-agents.git
cd ai-dev-agents
chmod +x install.sh update.sh uninstall.sh
./install.sh
```

Isso instala:
- Skills dos agentes em `~/.claude/skills/`
- Contratos YAML em `~/.claude/contracts/`
- MCP writer server em `~/.claude/mcp-server/` (requer Node.js)
- Skill `/db-setup` para configuracao de PostgreSQL

### 2. Configurar no seu projeto de trabalho

```bash
cd seu-projeto
```

**Adicione ao `.gitignore`** do projeto:
```
# Claude Code agents
.claude/
```

**Configure PostgreSQL** (se o projeto usa banco):
```bash
/db-setup
# Responda as perguntas (connection string, permissoes)
# Reinicie o Claude Code apos a configuracao
```

### 3. Comecar a usar

```bash
# Primeira vez no projeto: gere a knowledge base
/explorer

# Discutir uma ideia com o arquiteto (com ref cirurgico, opcional)
/brainstorm "ref: .claude/explorer/flows/post-payments.md — adicionar idempotencia"

# Ou ir direto pro planejamento
/planner "Preciso adicionar cache Redis distribuido"
```

### 4. Atualizar o framework

```bash
cd ai-dev-agents
./update.sh
```

### 5. Desinstalar

```bash
cd ai-dev-agents
./uninstall.sh
```

## Arquitetura

```
.claude/explorer/         ← Project knowledge base (permanente, incremental)
      ↑ mantido por /explorer
      ↓ consultado por:

                /explorer                                  (Opus, knowledge base)
                     │
                     ▼ (ref opcional)
/brainstorm ──▶ /arquiteto ──▶ /planner ──▶ /orchestrator
                                                  │
                                ┌─────────────────┼─────────────┐
                                ▼                 ▼             ▼
                              /coder           /coder         /coder      (Sonnet, paralelo)
                                ▼                 ▼             ▼
                            /reviewer         /reviewer     /reviewer    (Opus, review)
                                ▼                 ▼             ▼
                              /tester           /tester       /tester     (Sonnet, testes)
                                │                 │             │
                                └─────────────────┼─────────────┘
                                                  ▼
                                              /resumer                     (Sonnet, consolidacao)
```

O `/explorer` e um agente **independente** da pipeline sequencial. Ele mantem a knowledge base do projeto em `.claude/explorer/`, que e consultada por `/brainstorm` e `/planner` via loading hibrido (overview leve sem ref, contexto cirurgico com ref a arquivo especifico).

## Agentes

| Agente | Modelo | Papel |
|--------|--------|-------|
| **explorer** | Opus | Mantem project knowledge base em `.claude/explorer/` — staleness detection + update incremental |
| **brainstorm** | Opus | Arquiteto tecnico. Discute ideias, explora codigo, propoe abordagens |
| **arquiteto** | Opus | Detalhamento tecnico. Recebe visao (do brainstorm ou direto) e produz contratos, exemplos e padroes pras tasks que o planner vai criar. Nao decompoe em tasks nem implementa codigo. |
| **planner** | Sonnet | Decomposicao operacional. Recebe spec tecnico do arquiteto e quebra em tasks executaveis com dependencias e ordem. Nao faz decisoes tecnicas — referencia o spec do arquiteto nas tasks. |
| **orchestrator** | Opus | Gerencia execucao autonoma do roadmap |
| **coder** | Sonnet | Implementa tasks seguindo checklist e padroes |
| **reviewer** | Opus | Revisa codigo, verifica conformidade com task e padroes |
| **tester** | Sonnet | Roda testes, reporta resultados detalhados |
| **resumer** | Sonnet | Consolida handoffs e tasks num resumo, limpa intermediarios |

## Quando usar cada entry point

O framework e um conjunto de agentes standalone + um fluxo recomendado pra trabalhos grandes. Voce decide quando usar tudo, parte, ou nada.

### /brainstorm — caminho longo (explorar e discutir)

Use quando:
- A mudanca envolve decisao arquitetural nao trivial
- Voce nao tem conhecimento total da tecnologia/abordagem
- Quer discutir trade-offs antes de escolher caminho
- A mudanca toca multiplos fluxos ou introduz padrao novo no projeto

### /arquiteto — caminho medio (detalhar tecnicamente)

Use quando:
- A visao tecnica ja esta clara (voce sabe O QUE e POR QUE)
- Falta o COMO: contratos, padroes, exemplos, riscos
- A mudanca e bem delimitada (um fluxo, um endpoint, um consumer)
- Pode ser invocado direto sem brainstorm previo se voce ja tem clareza

### /planner — caminho de decomposicao (depois do arquiteto)

Use quando:
- Voce ja tem o detalhamento tecnico do arquiteto
- Precisa quebrar em tasks executaveis com dependencias e roadmap
- Geralmente usado em sequencia depois do arquiteto, raramente direto

### /orchestrator — execucao autonoma

Use quando:
- Tem o roadmap do planner e quer execucao automatizada das tasks
- Coder, reviewer e tester rodam em sequencia via orchestrator

### /coder, /reviewer, /tester — invocacao direta

Cada um pode ser invocado direto pra trabalho pontual:
- `/coder "corrigir bug X em arquivo Y"` — quando voce sabe exatamente o que fazer
- `/reviewer "revisar PR #123"` — quando quer critica isolada
- `/tester "rodar testes do modulo X"` — quando quer so verificacao

### Principio geral

Os agentes podem **sugerir** mudar de caminho no meio do processo quando detectam que voce escolheu errado (planner pode sugerir voltar pro arquiteto, arquiteto pode sugerir invocar brainstorm antes, etc). **Sugestao sempre, execucao nunca** — voce decide se aceita.

## Project Knowledge Base (`.claude/explorer/`)

O agente `/explorer` mantem uma knowledge base permanente sobre o projeto atual. Diferente dos outros agentes, o `/explorer` **nao participa do fluxo sequencial** — ele e invocado pontualmente pra inicializar ou atualizar o mapeamento.

### Estrutura

```
.claude/explorer/
├── .meta.yaml               # metadata: staleness, contadores, indices
├── overview.md              # stack, estrutura, patterns, diagrama
├── endpoints.md             # endpoints HTTP
├── consumers.md             # listeners de mensageria
├── producers.md             # publishers de mensageria
├── database.md              # tabelas e relacionamentos
├── config.md                # profiles, properties, env vars
├── flows/                   # catalogo de fluxos de negocio
│   ├── _index.md
│   └── <slug>.md
└── insights/                # observacoes manuais, nunca regeneradas
    ├── README.md
    └── <slug>.md
```

### Como usar

```bash
# Primeira vez no projeto (ou quando o diretorio nao existe)
/explorer
# → modo first-run: gera toda a estrutura

# Atualizacao apos mudancas no codigo
/explorer
# → modo incremental update: detecta mudancas, regenera so o afetado

# Rebuild completo (preserva insights/)
/explorer --force
```

### Staleness detection automatica

`/brainstorm` e `/planner` verificam o `.meta.yaml.last_commit_sha` no inicio da execucao. Se o HEAD mudou desde o ultimo update, eles perguntam se devem atualizar antes de prosseguir.

### Loading hibrido no brainstorm/planner

```bash
# Contexto amplo (carrega overview + indice de fluxos)
/brainstorm "Quero adicionar cache distribuido"

# Contexto cirurgico (carrega so o fluxo especifico)
/brainstorm "ref: .claude/explorer/flows/post-payments.md — Adicionar idempotencia nesse endpoint"
```

### Insights manuais

`.claude/explorer/insights/` guarda observacoes duraveis sobre o projeto que nao sao regeneraveis automaticamente. Populado manualmente ou pelo `/brainstorm` no fim de uma sessao. O `/explorer` **nunca** toca em arquivos desse diretorio.

### Integracao com Repowise

O `/explorer` detecta automaticamente se [repowise](https://github.com/repowise-dev/repowise) esta disponivel e o usa como fonte primaria de grafo de dependencias, hotspots de churn, ownership e analise de risco. No primeiro uso, pergunta antes de rodar `repowise init` — nenhum side effect sem permissao.

Sem repowise, o `/explorer` funciona com greps tradicionais mas o update incremental e mais limitado.

## Como Usar

### Fluxo completo

```bash
# (Primeira vez no projeto) Inicialize a knowledge base
/explorer

# (Quando codigo mudou) Atualize antes de brainstormar
/explorer
# Ou deixe o brainstorm/planner detectarem e perguntarem automaticamente.

# 1. Discuta a ideia com o brainstorm
/brainstorm "ref: .claude/explorer/flows/post-payments.md — adicionar idempotencia"

# 2. Detalhe tecnicamente com o arquiteto
/arquiteto "ref: .claude/handoff/<session>/brainstorm-output.yaml"

# 3. Decompoe em tasks com o planner
/planner "ref: .claude/handoff/<session>/arquiteto-output.yaml"

# 4. Execute o roadmap
/orchestrator "ref: .claude/handoff/<session>/planner-output.yaml"
```

### Atalhos (pular etapas)

```bash
# Ir direto pro planner sem brainstorm (ele gera o session name)
/planner "Preciso adicionar cache Redis distribuido"

# Rodar so o coder numa task especifica
/coder ".claude/task/minha-sessao/task-1.1-pipeline.md"
```

## Organizacao por Sessao

Cada execucao do pipeline sequencial e organizada numa **sessao** com nome semantico (slug kebab-case). O brainstorm gera o nome automaticamente. A knowledge base do projeto (`.claude/explorer/`) e **permanente** e nao depende de sessao.

```
.claude/
├── explorer/                          # permanente, project knowledge base
│   ├── .meta.yaml
│   ├── overview.md
│   ├── endpoints.md
│   ├── consumers.md
│   ├── producers.md
│   ├── database.md
│   ├── config.md
│   ├── flows/
│   │   ├── _index.md
│   │   └── <slug>.md
│   └── insights/
│       ├── README.md
│       └── <slug>.md
│
├── handoff/                           # efemero, limpo pelo resumer
│   └── minha-sessao/
│       ├── brainstorm-output.yaml
│       ├── planner-output.yaml
│       ├── orchestrator-status.yaml
│       └── task-1.1/
│           ├── coder-output.yaml
│           ├── reviewer-output.yaml
│           └── tester-output.yaml
│
├── task/                              # efemero, limpo pelo resumer
│   └── minha-sessao/
│       ├── roadmap-tasks.md
│       └── task-1.1-nome.md
│
└── agent-memory/                      # permanente por agente
    └── brainstorm/
        ├── MEMORY.md                  # indice raiz (todas as sessoes)
        └── minha-sessao/              # memorias dessa sessao
            └── decisoes.md
```

Quatro categorias: `explorer/` (permanente por projeto), `handoff/` e `task/` (efemeros por sessao), `agent-memory/` (permanente por agente).

**Limpeza:** Pra limpar uma sessao, basta deletar as subpastas:
```bash
rm -rf .claude/handoff/minha-sessao/ .claude/task/minha-sessao/
```

## Comunicacao entre Agentes

Os agentes se comunicam via **contratos de handoff** — arquivos YAML com formato fixo organizados por sessao.

```
~/.claude/contracts/        ← Templates YAML (globais, deste repo)
.claude/handoff/<session>/  ← Outputs gerados (por projeto, no .gitignore)
```

Cada contrato tem campos como `status`, `agent`, `next`, `session`, permitindo comunicacao deterministica.

## Memoria dos Agentes

Cada agente mantem memoria permanente em `.claude/agent-memory/<agent>/` por projeto. A memoria guarda **conhecimento sobre COMO operar** (preferencias do usuario, armadilhas do projeto, convencoes de processo) — **nao fatos sobre o codigo** (esses moram em `.claude/explorer/`, mantido pelo `/explorer`).

Cada agente executa um **Memory Check obrigatorio** ao final da sessao com 5 perguntas concretas (3 comuns + 2 especificas do papel). Se alguma bater, salva o aprendizado; se nenhuma bater, reporta explicitamente "Memory check: nenhuma memoria nova nesta sessao."

Detalhes completos da ontologia, formato dos arquivos, e casos especiais (explorer e resumer): [`docs/agent-memory.md`](./docs/agent-memory.md).

> O diretorio `.claude/` esta no `.gitignore`, por isso o doc da ontologia mora em `docs/` neste repo.

## Estrutura do Repo

```
ai-dev-agents/
├── agents/                 ← Definicoes dos agentes
│   ├── explorer.md
│   ├── brainstorm.md
│   ├── arquiteto.md
│   ├── planner.md
│   ├── orchestrator.md
│   ├── coder.md
│   ├── reviewer.md
│   ├── tester.md
│   └── resumer.md
├── contracts/              ← Templates de handoff (YAML)
│   ├── brainstorm-output.yaml
│   ├── arquiteto-output.yaml
│   ├── planner-output.yaml
│   ├── coder-output.yaml
│   ├── reviewer-output.yaml
│   ├── tester-output.yaml
│   ├── orchestrator-status.yaml
│   └── resumer-output.yaml
├── mcp-server/             ← MCP writer server (TypeScript)
│   ├── package.json
│   ├── tsconfig.json
│   └── src/index.ts
├── skills/                 ← Skills auxiliares
│   └── db-setup/
│       └── SKILL.md
├── templates/              ← Templates de configuracao
│   ├── mcp.json.template
│   └── pipeline-schema.sql
├── install.sh
├── update.sh
├── uninstall.sh
└── README.md
```
