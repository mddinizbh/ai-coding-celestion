---
name: explorer-l2
description: >
  Explorer L2 — bottom-up journeys: propose-from-l1 → enrich-from-l0 → bind/persist.
  Use when the user says /explorer-l2, journey, macro-flow, or wants ordered hops
  over a system namespace. Does not index or stitch. NEVER invent domain narrative
  (partner defaults, plate rules) without L0 body read.
---

# explorer-l2 — journeys (bottom-up)

## Pipeline (obrigatório)

```text
L1 system_edges  →  propose-from-l1  →  skeleton tipado por trigger
L0 accepted pkgs →  enrich-from-l0   →  anchors + continuidade internal + read_plan
                 →  bind (+ persist) →  structural_status + understanding_status
```

**Não** escrever JourneySpec de domínio na mão e “carimbar” com bind.
Spec humano só depois de enrich — ou via `synthesize`.

## synthesize (one-shot)

```bash
node skills/explorer-l2/cli.mjs synthesize \
  --system-namespace acme-system \
  --namespace acme \
  --db ~/.local/share/descobrir/acme.sqlite \
  --from acme-tax --to tax-provider-controller \
  --min-score 0.9 \
  --journey-id journey-l1-acme-tax-tpc \
  --persist \
  --out /tmp/journey-spec.json
```

## Passo a passo

```bash
# 1) esqueleto só L1
node skills/explorer-l2/cli.mjs propose-from-l1 \
  --system-namespace acme-system --from acme-tax --to tax-provider-controller \
  --min-score 0.9 --out /tmp/draft.json

# 2) âncoras L0 + read_plan obrigatório
node skills/explorer-l2/cli.mjs enrich-from-l0 \
  --spec /tmp/draft.json --namespace acme --out /tmp/enriched.json

# 3) bind + SQLite
node skills/explorer-l2/cli.mjs bind --spec /tmp/enriched.json --persist --namespace acme
```

## Query

```bash
node skills/explorer-l2/cli.mjs list --system-namespace acme-system
node skills/explorer-l2/cli.mjs show --system-namespace acme-system --journey-id …
node skills/explorer-l2/cli.mjs journeys-for-edge --edge-id 'l1:…'
```

## Regras

| Pode | Não pode |
|------|----------|
| Steps `http-sync`, `webhook`, `cron` e `queue` a partir de edge L1 | Claim “default RENDIMENTO” sem body de `choosePartner` |
| Continuidade `internal` a partir de relações L0 comprovadas | Inventar ordem de negócio só porque dois símbolos são vizinhos |
| L0 anchors Method/Service no evidence file | Tratar enrich como verdade de domínio |
| `read_plan` com arquivo, linha, símbolo e motivo | Tratar `structural_status=complete` como entendimento confirmado |

## Dois estados, duas perguntas

- `structural_status`: todos os hops possuem contrato L1 correspondente?
- `understanding_status`: os itens obrigatórios do `read_plan` já foram lidos e
  marcados como `verified`?

O campo legado `status` continua espelhando `structural_status` para
compatibilidade. Uma jornada pode ser estruturalmente `complete` e continuar
com `understanding_status=code-read-required`. Alterar um item de leitura para
`verified` muda a revisão e o hash da jornada. Os campos são aditivos em
`spec_json`/`bind_json`; não exigem migração SQLite.

Human gate: executar o `read_plan`, revisar os bodies e registrar `verified`;
só então aceitar narrativa de domínio. O skeleton L1+L0 continua válido para
navegação e blast radius antes dessa confirmação.
