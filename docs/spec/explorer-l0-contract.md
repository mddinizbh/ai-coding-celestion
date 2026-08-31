# Spec: contrato do explorer-l0 (condensado)

> Versão condensada do fluxo "Descobrir" (original: `workflows/descobrir/FLOW.md`, removido).
> A implementação viva é a skill: `skills/explorer-l0/`. Esta página existe para
> quem precisa entender o contrato sem ler o código.

---

## Propósito

Transformar um repositório Git num grafo de conhecimento verificável (Knowledge
Records + Relations), persistido em SQLite como baseline aceito — só depois de
aprovação humana explícita (Human Gate).

## Papéis

| Papel | Confiança | Função |
|---|---|---|
| Graphify | Determinístico | Extração estrutural em worktree isolada da revisão pinada. Invocado pela skill, nunca à mão. |
| `emit-payloads` | Determinístico | Fatos Graphify → payload fechado (mapa global de nós). LLM não entra no hot path. |
| Guardrails (`finalize`) | Determinístico | Valida shape, recompute IDs canônicos, hash, cobertura, downgrade de status. |
| Store SQLite | Canônico | Candidates + 1 ponteiro de baseline aceito por `(namespace, logical_repo)`. JSON é só export. |

## Fases (ordem estrita)

1. **setup-status** — verifica `graphifyy==0.9.32` via uv. Faltou? para e instrui.
2. **prepare** — worktree efêmera + extração + chunk index + Artifact Manifest. Repo-fonte nunca é mutado (snapshot pre/post obrigatório).
3. **emit-payloads** — encoder mecânico: fatos Graphify → payload fechado (um processo, todos os chunks). LLM não entra no hot path do L0.
4. **finalize** — valida, funde payloads, re-deriva evidência/IDs/hash/cobertura via leitor Git pinado, persiste idempotente. Bloqueio = nada escrito.

## Semântica de status

| Status | Significado |
|---|---|
| `comprovado` | Repository Reference **verificada** contra o código na revisão pinada. Draft do LLM nunca promove — só o `finalize`. |
| `hipótese` | Evidência só de artefato, ou não verificada. |
| `contradição` | Fontes incompatíveis. Nenhuma versão vira canônica até resolução explícita. |
| `stale` | `source_revision` atrás do código atual. v1 registra; checagem de freshness é gap conhecido (ver `ROADMAP.md`). |

## Human Gate

`accept` exige `coverage_report.passed === true` + identidade do aprovador.
**Sem auto-accept. Consenso entre agentes não substitui aprovação humana.**
Rejeição deixa o baseline anterior inalterado.

## Guardrails essenciais

- Repo-alvo nunca é mutado; evidência vem da revisão pinada, não da working tree.
- LLM não é autoridade: IDs, status, evidência, hash e cobertura são recomputados.
- Mesma chave + JSON divergente = rejeição (colisão); JSON idêntico = idempotente.
- Nunca persistir segredos, env, connection strings, paths absolutos ou dirty files.
- IDs únicos dentro do namespace; nada cruza namespace.

## Store

- DB: `${XDG_DATA_HOME:-~/.local/share}/descobrir/<namespace>.sqlite`, modo `0600`.
- Scratch de run: `${XDG_CACHE_HOME:-~/.cache}/descobrir/runs/<run_id>/`.
- Múltiplos candidates; um baseline aceito por `(namespace, logical_repo)`.

## Referências

- Skill + contratos self-contidos: `skills/explorer-l0/` (`SKILL.md`, `contracts/*.schema.json`)
- ADRs: `docs/adr/0005` (store SQLite), `0008` (pipeline), `0009` (layered IDs)
- Vocabulário: `docs/domain/glossary.md`
