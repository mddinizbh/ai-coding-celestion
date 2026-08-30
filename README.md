# ai-coding-celestion

Template do time para OpenCode: **agents finos + skills próprias**. Clone,
instale, use. Sem runtime novo — é composição sobre o OpenCode.

pt-BR. Sem nome de empresa no código.

## O que tem

| Pasta | Conteúdo |
|---|---|
| `skills/explorer-*` | Pipeline de grafo de conhecimento (autoria própria) |
| `skills/architecture-*`, `skills/db-setup` | Skills próprias complementares |
| `agents/` | Agents finos (1 classe por papel, allow-list no frontmatter) |
| `packages/explorer-skills` | Instalador das skills no OpenCode |
| `skills.deps.json` | Skills de terceiros (modelo Maven: installer baixa e instala) |
| `contracts/` | Contratos de handoff (brainstorm → próxima fase) |
| `templates/` | Templates de config (mcp.json, schema de pipeline) |
| `docs/spec/` | Contrato condensado do L0 |
| `docs/adr/` | Decisões de arquitetura |
| `docs/provenance/` | READMEs dos repos de origem (histórico) |
| `docs/domain/glossary.md` | Vocabulário do pipeline |
| `ROADMAP.md` | O que falta (leia antes de contribuir) |

## Instalar

```bash
git clone <este-repo> && cd ai-coding-celestion
node packages/explorer-skills/bin/opencode-explorer.js install
# reinicie o OpenCode
```

O `install` faz três coisas: instala as skills próprias (symlink), instala as
skills complementares próprias e **baixa as skills de terceiros declaradas em
`skills.deps.json`** (clone raso + cópia com marker — modelo Maven: o repo
declara a dependência, o installer resolve). Sem rede, as próprias instalam do
mesmo jeito e as terceiros ficam pra depois.

Pré-requisito do L0 (uma vez por máquina): `node skills/explorer-l0/cli.mjs setup`
— instala `graphifyy==0.9.32` via `uv tool`.

## Pacote de modelos

| Papel | Tier recomendado | Quem define |
|---|---|---|
| explorer-worker | barato/rápido (qualquer default) | membro local |
| explorer-matcher | médio (claude-sonnet-4-5 default) | repo (override local) |
| explorer-synth | frontier/amplo contexto | membro local |

Mínimo viável: configure nada — tudo roda no seu modelo default (mais caro, mas funciona).

Recomendado: três tiers distintos no seu `~/.config/opencode`.

Override local: edite `~/.config/opencode/opencode.jsonc` (ou o arquivo de config do seu agente) e mapeie os roles para os models do seu pacote. O repo só entrega os papéis.

## Usar (pipeline explorer)

Cada um indexa o repositório **dele**. Merge de grafo é no namespace do
ambiente, não neste Git.

```
L0  indexa 1 repo → baseline em SQLite (Human Gate: você aceita)
L1  costura repos aceitos → edges cross-service (config-map promove confiança)
L2  journeys bottom-up (esqueleto L1 + âncoras L0 + read_plan)
consulta  explorer-query answer / slice — prefira ao grep largo
```

Convenções: `namespace` = projeto · `logical_repo` = repo · grafo sempre da
**master** · baseline só vira "aceito" com aprovação humana.

Store: `~/.local/share/descobrir/<namespace>.sqlite` (local, por máquina;
store compartilhado é futuro — ver ROADMAP).

## Fluxo de código (agents)

```
brainstorm  → visão.md + yaml de handoff
arquiteto   → SDD            (futuro)
planner     → tasks          (futuro)
orchestrator → coder → reviewer → tester   (futuro)
```

Hoje: `brainstorm` + pipeline explorer. Skills de escrita (`explorer-l0/l1/l2`)
só via agent com allow-list; `explorer-query` é livre. Regras completas:
`AGENTS.md`.

## Contribuir

1. Leia `ROADMAP.md` — não reabra decisão fechada.
2. Skill nova entra self-contida (contratos dentro da pasta da skill).
3. Toda skill tem teste (`node --test skills/<skill>/test/*.test.mjs`).
