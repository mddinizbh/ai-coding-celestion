---
status: accepted
---

# ADR 0007 — Skill L1 de costura de sistema + consumo `/graph-system`

## Contexto

ADR 0004 descreveu L1 (join de fronteira cross-service) como desenho. L0
operacional (ADR 0005/0006) entrega baselines **aceitos** por serviço no SQLite
central. Falta um executável que:

1. leia só baselines aceitos;
2. extraia fronteira HTTP/config de forma determinística;
3. grave arestas num **namespace de sistema** sem fundir L0;
4. exponha consumo separado de `/graph` (L0).

Prova Acme: `acme-tax` → `tax-provider-controller` via
`PROVIDERCONTROLLER_API_URL` e
`GET /api/debits/{state}/category/{category}/renavam/{renavam}`.

## Decisão

- Skill **`skills/l1/`** + comando OpenCode **`/l1`**.
- Extrator v1: `git show` na revisão pinada do package aceito (Spring/Kotlin
  annotations + `@Value` + yml) — **não** reexecuta Graphify/Explorer.
- Matcher: **config-binding first**, depois path contract normalizado
  (`method` + path com params canônicos `{param}`).
- Evidência obrigatória: `contract-matched` (nunca promover a `comprovado` L0).
- Persistência: tabelas `system_edges` / `system_stitch_runs` (mesmo arquivo
  SQLite do namespace L0 ou `--system-db` separado). L0 `candidate_packages`
  intacto.
- Consumo: skill **`/graph-system`** (callers/callees/status/export) — **não**
  sobrecarrega `/graph`.
- L2 macro-flow chaining, Neo4j, Docker: **continuam deferred**.

## Consequências

- Análise de impacto cross-repo fica possível sem carregar N repos inteiros.
- Qualidade do join depende de config keys mapeadas e de cobertura do extrator;
  path-only é score mais baixo e ruidoso.
- ADR 0004 permanece o modelo de camadas; este ADR aceita a **implementação L1
  v1** no harness.

## Links

- Skill: `skills/l1/SKILL.md`
- Consumo: `skills/l1/graph-system/SKILL.md`
- Plano: `.omo/plans/l1-acme-costura.md`
- ADR 0004: `docs/adr/0004-cross-service-stitching-c4.md`
