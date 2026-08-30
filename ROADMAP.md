# ROADMAP

> O que falta construir, em ordem. Decisões já tomadas estão embutidas nos
> itens — não reabrir sem motivo. Histórico de decisões de arquitetura: `docs/adr/`.

---

## P0 — corrigir o que está quebrado

### [BUG] L1: PK `(system_namespace, edge_id)` + migração

`skills/explorer-l1/src/system-store.mjs` declara `edge_id TEXT PRIMARY KEY`
sem o system namespace. Dois namespaces com o mesmo par de fatos colidem e o
`INSERT OR IGNORE` descarta em silêncio (observado: edge perdido no
`demo-system` por colisão com namespace de teste).

- Fix: PK composta `(system_namespace, edge_id)`
- Migração definida para stores existentes, sem perda
- Teste: dois namespaces, mesmo edge, ambos persistem

### [BUG] L1: restitch não pode deixar edge duplicado

O stitch é aditivo e o `edge_id` deriva de `arquivo+linha`; trocar extrator ou
o código andar duplica contratos idênticos (observado: 8 linhas para 5
contratos no `demo-system`).

- **Decisão tomada: wipe por system namespace** (não `superseded_by_run`).
  Histórico de topologia é YAGNI; ninguém consome.
- Delete + insert **na mesma transação** (crash no meio não pode deixar
  namespace vazio)
- Report do stitch imprime `removed: N, inserted: M`
- Jornadas L2 ligadas a edges: `bind`/`journeys-for-edge` avisam quando o edge
  sumiu (ID só muda se código/extrator mudou — e aí o `read_plan` precisa de
  revisão de qualquer jeito)

---

## P1 — honestidade do grafo (time)

### [GAP] Stale visível na consulta

Regra do time: **o grafo sempre reflete a master**. Baseline velho responde
com confiança sobre código que não existe mais — pior que não ter grafo.

- **v1:** `explorer-query answer` compara a revisão do baseline aceito com o
  HEAD da master de cada repo e imprime aviso:
  `baseline cloud@633d3a5d · master 20c3d3d2 (+23 commits) — reindexe`
- Re-index continua **manual** (`/explorer-l0`): a skill não tem acesso a CI,
  e Human Gate proíbe aceitar sem humano olhando
- Mesma checagem disponível como comando curto (para o agente indexador e para
  checagem de início de sessão)

### [GAP] Store hexagonal: local hoje, compartilhado depois

Hoje o SQLite nasce na máquina (`~/.local/share/descobrir/<ns>.sqlite`). O
modelo alvo: a camada de store é uma **porta** — aponta para SQLite local
agora, para um store compartilhado do time depois (todo mundo consulta a base
pré-carregada, qualquer um adiciona repo/atualiza, grafo sempre da master).

- Não construir agora. Exigência: nenhuma skill pode abrir o DB por path
  Hardcoded — sempre via `--db`/config (a maioria já aceita; fechar os gaps)
- Quando o time sentir a dor de N máquinas dessincronizadas, plugar o adapter
  compartilhado sem tocar nas skills

---

## P2 — fechar o roster

### [LIMPEZA] Installer: modelo Maven consolidado

Feito: `skills.deps.json` declara skills de terceiros e o installer baixa na
instalação (`src/install-deps.mjs`); skills próprias complementares
(`architecture-canvas/diagrams`, `db-setup`) instalam por symlink.

Falta:

- Matar os `install.mjs` de cada skill explorer (o installer deve ser o único
  caminho de instalação)
- CLIs das skills viram location-agnostic (resolver o próprio dir via
  `import.meta.url`, não cwd) — L1/L2/query ainda assumem path relativo ao repo
- Instalar **não** copia `test/` nem `e2e/` (hoje symlink/copy leva tudo)
- `grilling` e `domain-modeling` (dependências do brainstorm) ainda não têm
  fonte distribuída — publicar ou achar upstream e entrar no `skills.deps.json`

### [AGENT] explorer-indexer

Motorista do pipeline (só depois de P0/P1 fechados). Mesmo padrão fino do
`brainstorm`:

- Frontmatter com allow-list: `explorer-l0/l1/l2: allow`, `"*": deny`
- Ritual: setup → L0 por repo (para no Human Gate) → L1 stitch com config-map
  → L2 sob demanda
- Convenções que o agent impõe: namespace = projeto, `logical_repo` estável,
  grafo sempre da master, nunca auto-accept
- Skills de escrita ficam **bloqueadas** para os demais agents
  (`explorer-query` continua liberada — é leitura, e o `brainstorm` usa)

### [AGENT] Resto do roster (futuro)

`arquiteto → planner → orchestrator (coder → reviewer → tester)`. Mesmo
padrão fino: frontmatter com allow-list, contratos em `contracts/`,
skill de terceiros só na allow-list da peça.

---

## Feitos (para não reabrir)

- ~~Extrator Go/huma no L1~~ — `go-huma.mjs` em `src/adapters/`, registrado e
  documentado; `route-manifest-yaml` resolveu a classificação do `demo.yaml`
- ~~Schemas do L0 self-contidos~~ — migrados para
  `skills/explorer-l0/contracts/`, path resolvido dentro da skill (instalável)
- ~~workflows/ + FLOW pesado~~ — removidos; contrato condensado em
  `docs/spec/explorer-l0-contract.md`
- ~~project-onboarding~~ — removido (wrapper redundante do L0, draft, infra
  fantasma)
