---
name: architecture-diagrams
description: Use when you need navigable interactive architecture documentation for one or more repos — a macro→micro suite (services map, per-service class diagrams, ER schemas with every field, messaging/cache contracts, deploy), in any stack. Use when one ad-hoc diagram is not enough and you want consistent drill-down across many components.
---

# Architecture Diagrams (suíte macro→micro)

## Overview

Gera uma **suíte** de documentação de arquitetura interativa (HTML/SVG, dark mode) com navegação
**macro→micro** para um repo ou uma lista de repos, em qualquer stack.

**Princípio central:** um **gate determinístico de legibilidade** (`assets/lint.py`) roda em **loop** em cada
página. É o que torna a geração paralela confiável — sem ele, agentes produzem SVG com texto sobreposto e
setas soltas/atravessando cards, e ninguém percebe.

**REQUIRED SUB-SKILL:** `/explorer` (mapa do código) · **REQUIRED SUB-SKILL:** `/html-diagram` (estética SVG).
Fan-out via **Workflow**.

## Quando usar

- Onboarding/entendimento de um serviço ou de uma plataforma multi-repo.
- Um "faça um diagrama" que precisa virar algo **navegável e mantível**, não um PNG one-shot.
- Você tem ≥1 repo e quer descer de serviços→classes e de bancos→schemas→campos.

**Não use** para um único diagrama descartável — aí use só `/html-diagram`.

## Input

`/architecture-diagrams <repo-path | repoA,repoB,…> [--out <dir>]`
- 1 repo → `<repo>/docs/diagramas/` (default). Lista → 1 macro multi-repo + micros por repo.

## Pipeline

**0. Detect (adaptativo).** Olhe o repo e gere só as trilhas que existem: build files / pacotes →
serviços+classes · DDL/migrations/MCP de banco → ER · Kafka/Redis/SQS → contratos · compose/CI → deploy.

**1. Map.** Rode `/explorer` (consome/atualiza `.claude/explorer/`: overview, endpoints, consumers, flows,
database). Complemente com **Explore agents** para os specifics de cada trilha (classes por serviço,
colunas/tipos por schema, payloads de evento, config de deploy). **Aterre na realidade** — introspecção MCP
de banco, DDL/migrations reais, grep do código, infra rodando. Nunca confie só em prosa/docs.

**2. Foundation (gold-reference-first).** Copie `assets/{diagram.css,diagram.js,lint.py}` → `<out>/_assets/`.
Construa **À MÃO 2 gold references** do repo real (1 de classe a partir de `references/gold-class.html`, 1 de
ER a partir de `references/gold-er.html`), rodando `python3 _assets/lint.py <file>` até dar `OK`. Elas fixam
o padrão antes do fan-out — **não pule**.

**3. Fan out (Workflow).** 1 agente de render por página micro. Cada agente: lê o gold correspondente + sua
fatia do mapa, escreve o HTML **clonando a estrutura**, e roda o **LOOP render→lint→fix**
(`python3 _assets/lint.py <file>` → corrige → repete até `OK`). Trilhas: classe/serviço · ER/schema (todos
os campos com tipo+descrição no clique) · contratos · deploy. Depois construa os **macro** (arquitetura de
serviços, fluxo de dados) — também passando no linter.

**4. Navigate.** Hub `index.html` (uma seção por trilha). Drill-down `↳` nos nós macro (serviço→classe;
store→hub do banco→ER). `diagram.js` injeta **⌂ Home**; cada página tem um **← pai** (um nível acima).

**5. Verify.** `lint.py` em **todas** as páginas (0 violações) · todos os `href` resolvem ·
**anti-alucinação:** amostre o dado gerado contra a fonte real (nomes de tabela / contagem de colunas via
MCP/DDL; nomes de classe via grep).

> Tipos de nó, lanes por estilo, formato `DETAIL/FLOWS/E2L` e regras anti-overflow:
> `references/diagram-conventions.md`. Os dois gold em `references/` são exemplares lint-clean para clonar.

## Princípios (as lições não-óbvias)

- **O linter é o gate do loop.** Uma página só "fica pronta" quando `lint.py` dá `OK`. É o que garante "nada
  sobrescrevendo informação".
- **Gold-reference-first.** 1 exemplar à mão por tipo, antes do fan-out, melhora muito a consistência da frota.
- **Aterre + verifique contra a fonte.** Introspecção/DDL/grep, e então confira a amostra (anti-alucinação).
- **Assets compartilhados.** Cada página carrega só seus dados + SVG — não 400 linhas freehand.
- **Adaptativo.** Só gere a trilha que o repo realmente tem.

## Red flags — PARE

- Gerar o HTML **sem rodar `lint.py`** → você não tem garantia de legibilidade ("parece ok" engana).
- `lint.py` dá `OK` com **0 nós num diagrama** → a página não clonou a estrutura do gold; o gate não checou
  nada. (O hub `index.html` legitimamente não tem SVG — "sem <svg>" ali é esperado.)
- Pular as 2 gold references e mandar o fan-out direto → saída inconsistente.
- Preencher campos/classes de cabeça em vez de introspecção/DDL/grep → alucinação.
- Um único diagrama gigante em vez de macro→micro navegável.

## Rationalizations

| Desculpa | Realidade |
|---|---|
| "O diagrama parece legível" | "Parece" não audita. Rode `lint.py` — ele acha overflow / sobreposição / seta solta / atravessando card. |
| "Validei stubando o DOM" | Isso só checa sintaxe JS, não overlap visual. Use o linter geométrico. |
| "Clonar o gold é overhead" | Sem o gold cada agente inventa a estrutura → o gate não aplica e a suíte fica inconsistente. |
| "Os campos eu sei de cabeça" | Schemas mudam. Introspecte (MCP/DDL); depois confira a amostra. |
| "Um diagrama só resolve" | Um repo real tem camadas; o macro→micro com drill-down é o que faz a arquitetura "clicar". |
