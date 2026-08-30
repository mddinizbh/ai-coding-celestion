---
status: accepted
---

# ADR 0006 — Orquestração operacional do Descobrir e projeção Obsidian one-way

## Contexto

O ADR 0005 entregou a skill de produção com store SQLite, Human Gate e CLI de
persist/accept/export. A skill ainda dependia de o operador invocar Graphify
manualmente e montar um draft JSON intermediário — o que impede uso global
“uma invocação” em projetos externos.

Decisões de produto já aprovadas:

- Graphify pinado `graphifyy==0.9.32` em worktree Git isolada.
- Explorer (LLM do OpenCode) só emite semântica; IDs/hash/coverage/status são
  código-owned.
- SQLite central por namespace em XDG data.
- Accept nunca é automático.
- Obsidian é projeção one-way do baseline aceito, nunca fonte de verdade.

## Decisão

### Pipeline prepare → Explorer → finalize

1. **`prepare`** (determinístico): resolve config/revisão HEAD, cria run root
   sob XDG cache, abre worktree detached, executa
   `graphify extract --code-only --no-cluster --out`, carrega/projeta/chunka,
   monta Artifact Manifest + run descriptor (paths relativos, hashes
   verificáveis), remove a worktree em `finally`.
2. **Explorer** (estocástico, só semântica): lê chunks gerados e grava
   payloads em `explorer/payloads/` sob o run root. Campos de autoridade
   (ids, hashes, coverage, status `comprovado`, paths absolutos) são
   rejeitados.
3. **`finalize`** (determinístico): revalida descriptor/artefatos, faz merge
   dos payloads, mapeia evidence via key-map + `bindReadAtRevision`,
   recomputa coverage/mutation, persiste candidate no SQLite. Exit `2` em
   blockers semânticos (sem write no DB). Exit `0` em sucesso; retention
   remove o run root salvo `--retain-run`.

### Install global e comando `/descobrir`

- `install.mjs` instala symlink live em `~/.agents/skills/descobrir` e
  comando owned em `~/.config/opencode/commands/descobrir.md`.
- O comando orquestra setup-status → prepare → dispatch por chunk → finalize
  com retry seletivo (protocolo em `descobrir-protocol.mjs`).
- `status` / `cleanup` operam só em run roots (nunca no SQLite de candidates).

### Store canônico + Obsidian one-way

- SQLite permanece source of truth (ADR 0005).
- `project-obsidian` lê **somente** baseline aceito e gera Markdown
  determinístico (wikilinks tipados, banner read-only). Nunca lê o vault de
  volta para o SQLite.

### Setup Graphify

- `setup` / `setup-status` instalam e verificam **exatamente**
  `graphifyy==0.9.32` via `uv tool`. Runs normais **nunca** auto-instalam.

## Consequências

**Positivas**

- Uma invocação `/descobrir <projeto>` após setup explícito, em qualquer
  repositório Git, sem draft JSON manual.
- Fronteira clara estocástico vs determinístico.
- E2E hermético (`skills/descobrir/e2e/run.mjs --graphify fake`) prova
  instalação global + lifecycle + cleanup sem rede.

**Negativas / residual**

- L1/L2 stitching, Neo4j e Docker **não** estão no escopo.
- Fallback de modelo LLM no Explorer depende do runtime OpenCode
  (`runtime_fallback`); hang silencioso sem erro HTTP pode não trocar de
  modelo.
- Operador deve reiniciar o OpenCode após `install`/`uninstall`.

## Escopo entregue vs deferred

| Item | Estado |
|---|---|
| L0 operacional (install, setup, prepare, finalize, protocol, accept, project-obsidian, status, cleanup, E2E fake) | **Entregue** |
| L1/L2 cross-service stitching | Deferred |
| Neo4j / grafo normalizado | Deferred |
| Docker deploy | Deferred |
| Auto-accept | **Proibido** |
