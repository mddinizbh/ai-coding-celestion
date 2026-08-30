# Glossário — pipeline Explorer

> Vocabulário vivo do pipeline (explorer-l0/l1/l2/query). Termos da era
> harness que não têm mais implementação aqui foram removidos.
> Decisões técnicas: `docs/adr/`. Contrato do L0: `docs/spec/explorer-l0-contract.md`.

---

## Estrutura

### Projeto / namespace
Fronteira lógica de isolamento. Um projeto = um namespace = um SQLite
(`~/.local/share/descobrir/<namespace>.sqlite`). IDs são únicos dentro do
namespace; nada cruza namespace. Um projeto pode ter vários repositórios
(cada um com seu `logical_repo`).

### Project Knowledge Graph
O grafo do projeto: Knowledge Records + Relations + L1 edges + L2 journeys,
com evidência de origem. É índice factual operacional; a fonte de verdade é o
código-fonte na revisão pinada. O grafo deriva dela.

---

## L0 — unidades de conhecimento

### Knowledge Record
Unidade de **entidade** (serviço, módulo, endpoint, schema…). Identidade
estável única no namespace, tipo, conteúdo, status, evidências. Relações NÃO
ficam embutidas — vivem em Relation separada.

### Relation
Vínculo **tipado** entre duas entidades, persistido como registro separado.
ID canônico type-prefixed; namespace deve coincidir com o dos records
conectados.

### Canonical ID
Identificador estável, único no namespace, sem path de máquina e sem revisão —
sobrevive a reindexação. Produção é do módulo compartilhado
`skills/explorer-l0/src/layered-id.mjs`.

### Layered ID decoder ring (ADR 0009, `ID_VERSION=2`)

| Camada | v2 (atual) |
| --- | --- |
| L0 record | `l0:<record-kind>:<natural-key>` |
| L0 relation | `l0:rel:<TYPE>:<from-natural-key>-><to-natural-key>` |
| L0 FrontierFact | `l0:ff:<kind>:<16-hex>` |
| L1 edge | `l1:edge:<32-hex>` |
| L2 journey | `l2:journey:<journey-id>` |
| L2 bind | `l2:bind:<32-hex>` |
| Slice | `slice:<64-hex>` |
| Pack | `pack:<64-hex>` |

Leitores v2 rejeitam mistura v1+v2 (`MixedVersionError`). Endpoints L1 sempre
referenciam `l0:ff:*`, nunca record id direto.

### Status de um registro

| Status | Significado |
|---|---|
| `comprovado` | Repository Reference verificada contra código na revisão pinada |
| `hipótese` | Evidência só de artefato, ou não verificada |
| `contradição` | Fontes incompatíveis; nada canônico até resolução |
| `stale` | `source_revision` atrás do código atual |

---

## Evidência

### Repository Reference
Aponta para código-fonte: repo lógico + revisão + arquivo + intervalo
(`repo://<repo>@<rev>/<path>#L<a>-L<b>`). É o que promove um fato a
`comprovado`.

### Artifact Reference
Aponta para um trecho de Native Artifact: `{kind:"artifact", manifest_id,
artifact_path, content_sha256, range}`. Sozinha, nunca promove além de
`hipótese`.

### Artifact Manifest
Inventário dos artefatos da carga (Graphify): path relativo, hash, revisão
declarada, `acquisition_mode` (`reused`|`fresh`). Content-addressed.

### Provenance Coverage
Duas taxas, definição única: `artifact_reference_percentage` (evidência de
artefato válida) e `repository_verified_percentage` (Repository Reference
verificada **e** status `comprovado`).

### Repeatability
Mesmos bytes de artefato + mesma revisão ⇒ mesmo `canonical_graph_hash`.
É gate bloqueador do L0.

---

## L1 / L2

### SystemEdge (L1)
Edge cross-service derivado de **contrato** (HTTP client→controller, tópico,
cron, webhook), nunca de palpite. Confidence promove com config-map
(0.55 → 0.95). Persistido no SQLite do namespace.

### JourneySpec / bind (L2)
Jornada bottom-up: esqueleto proposto a partir de L1, enriquecido com âncoras
L0, com `read_plan` obrigatório. Dois estados independentes:
`structural_status` (contratos fechados?) e `understanding_status` (leituras
verificadas?). Narrativa de domínio só após ler o código.

---

## Consulta (explorer-query)

### Context Slice
Subgrafo materializado deterministicamente sob política explícita
(`journey@1`, `impact@1`, `drill-down@1`). Completo **relativo ao grafo
indexado**; gaps viram `misses`. Content-addressed (`slice_hash`).

### Context Pack
Projeção **orçada** de um Slice para consumo por agente — é aqui que
`max_nodes`/`max_edges`/`max_chars` aplicam. Content-addressed (`pack_id`).

---

## Governança

### Human Gate
Pausa explícita que aguarda aprovação humana. Consenso entre agentes não
substitui. No L0: `accept` publica o baseline atomicamente; rejeição deixa o
anterior inalterado.

### Unverified Projection
Derivado humano (diagrama, `.explorer/*.md`, relatório). Descartável; nunca é
entrada factual.
