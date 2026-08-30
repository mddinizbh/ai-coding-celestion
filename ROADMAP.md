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

### [GAP] Config-map vira artefato derivado (extrator de values + template)

**Decisão:** config-map deixa de ser input manuscrito e vira artefato derivado
com ciclo `candidate → Human Gate → confirmado`. O mapeamento é
`env_var → logical_repo` — **agnóstico de ambiente** (muda o host entre
dev/prod, não muda quem atende). Por isso um perfil local mantido como cópia
do dev (padrão bootstrap-local) é evidência válida: o que o map precisa é
**quem atende**, não a URL.

- Extrator lê values literais de `application*.yml/json`, `bootstrap*.yml`,
  `.env` → hostname → match exato contra `logical_repo` do sistema
- Casa única → entrada no candidate com evidência `file:line`;
  casa ambígua → **não propõe**, vira gap listado;
  sem match (localhost) → silêncio (dado ruim gera ausência, nunca entrada errada)
- `--emit-config-map-template` a partir de `unmapped_config_keys` (esqueleto
  com valores vazios — transforma caçada em preenchimento)
- Onde não há evidência em repo (config server externo sem cópia local,
  gateway de outro time) permanece **manual por design**: convenção de deploy
  varia por empresa e conhecimento fora do código indexado só entra por humano
- ⚠️ Risco empírico: hostname ≠ nome de repo (segmentos de ambiente, paths de
  gateway). Regras de match explícitas + o gate do candidate cobrem a primeira
  adoção; hit-rate só se sabe com repos reais

### [GAP] llm-assisted frontier (LLM localiza, bytes provam)

Para o que o extrator determinístico não pega — o caso-mestre: Spring Cloud
Stream, onde `streamBridge.send("binding")` liga ao tópico via
`bindings.{name}.destination` no YAML. A ligação é semântica (convenção de
framework); o valor final é byte.

- Fluxo: extrator roda → call-sites suspeitos (imports presentes, 0 fatos)
  viram fila → 1 subagente LLM por call-site, payload fechado com cadeia de
  evidência (`file:line` por link) → **validador determinístico por tipo de
  fato** re-deriva cada link dos bytes pinados (parser YAML existente, leitor
  Git pinado)
- Política de gate (refinada — links verificados não provam a cola semântica
  da cadeia):
  - **Padrão novo (primeiras ocorrências):** humano confirma a **cadeia**
    inteira, não só os links
  - **Padrão já codificado:** auto-accept com proveniência
    `llm-assisted+verified` (aditivo, sem migração)
  - Link não verificável → fato não nasce; vira hipótese/gap
- Proveniência separada na coverage (taxa `llm-assisted` própria) — se 40% do
  grafo vier dessa rota, tem que estar visível
- Determinismo/convergência: cache de fatos verificados keyado por
  `revisão + hash dos bytes`; run frio pode divergir (LLM é estocástico no
  dispatch), convergência vem de cache + wipe do restitch (P0) + codificação
- **Loop de convergência:** mesmo padrão resolvido N vezes → candidate adapter
  (1 arquivo + teste, como `go-huma`) → próxima indexação é extrator puro.
  O llm-assisted é bootstrap do extrator, não muleta permanente

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

### [SKILL] setup — onboarding guiado do template

**Decisão:** depois de skills/agents construídos, testados e instalados, o
README aponta pra **uma skill `/setup`** que guia a configuração local de ponta
a ponta — em vez de documentação espalhada pra seguir à mão. README fica
magro: `install` → `rode /setup`.

A skill checa estado e conduz, nessa ordem:

1. Pré-requisitos — node, `uv`, `graphifyy==0.9.32` (reaproveita os comandos
   `setup`/`setup-status` que já existem; roda com confirmação)
2. **Pacote de modelos** — binding dos 3 papéis (worker/matcher/synth) no
   `~/.config/opencode` do membro, checando o que já existe e oferecendo
   mínimo viável (1 modelo) vs recomendado (3 tiers)
3. Store sanity — path do SQLite, stores existentes, freshness deles
4. Smoke final — convenções confirmadas (namespace/master/Human Gate) e
   primeira consulta rodando

Onde mora: `skills/setup/` (mesmo padrão fino; só orquestra comandos que já
existem — nada de lógica nova de negócio). Última peça do fluxo do time:
só construir quando installer cleanup e papéis estiverem fechados.

### [AGENT] Resto do roster (futuro)

`arquiteto → planner → orchestrator (coder → reviewer → tester)`. Mesmo
padrão fino: frontmatter com allow-list, contratos em `contracts/`,
skill de terceiros só na allow-list da peça.



---

## Feitos (para não reabrir)

- ~~[P2] SQLite hardening~~ — WAL + `busy_timeout=5000` nos dois opens (L0 e
  L1); teste de contenção real (holder em processo separado segura o lock,
  writer espera ~1s e sucede — sem BUSY). Fan-out de N indexers no mesmo
  namespace é seguro
- ~~[P2] 3 papéis + pacote de modelos~~ — `explorer-worker` (barato),
  `explorer-matcher` (tier médio default pinado no repo), `explorer-synth`
  (frontier) — binding real é local de cada membro; README documenta mínimo
  viável vs recomendado
- ~~[P1] Stale visível na consulta~~ — `explorer-query freshness` (baseline vs
  HEAD, branch honesto) + seção additive no `answer` quando l0_db/repos
  presentes; re-index continua manual
- ~~[P1] Config-map derivado~~ — `propose-config-map` (extrator determinístico
  de values: application/bootstrap/.env → hostname → logical_repo, evidência
  file:line, ambíguo = gap) + `emit-config-map-template` via
  `unmapped_config_keys`
- ~~[AGENT] explorer-indexer~~ — `agents/opencode/explorer-indexer.md` no padrão fino:
  allow-list, ritual Fase 0-5, Gate em cada aceitação
- ~~[P0] PK `(system_namespace, edge_id)` + migração~~ — schema v3 com rebuild
  lossless (PK antiga garantia ausência de duplicatas, cópia não colide);
  mitigação `edge_id_conflicts` removida por obsoleta
- ~~[P0] Restitch não duplica~~ — `replaceSystemEdges` com wipe **por escopo
  do run** (from E to nos repos do run) em transação única + `removed/inserted`
  no report; `--pair` parcial preserva edges de repos fora do escopo
- ~~Extrator Go/huma no L1~~ — `go-huma.mjs` em `src/adapters/`, registrado e
  documentado; `route-manifest-yaml` resolveu a classificação do `demo.yaml`
- ~~Schemas do L0 self-contidos~~ — migrados para
  `skills/explorer-l0/contracts/`, path resolvido dentro da skill (instalável)
- ~~workflows/ + FLOW pesado~~ — removidos; contrato condensado em
  `docs/spec/explorer-l0-contract.md`
- ~~project-onboarding~~ — removido (wrapper redundante do L0, draft, infra
  fantasma)
