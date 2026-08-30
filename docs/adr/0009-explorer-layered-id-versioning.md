---
status: accepted
---

# ADR 0009 — Versioned layered identities (L0/L1/L2/Slice/Pack)

## Contexto

O ADR 0002 fixou que Canonical IDs de Knowledge Records e Relations são
`type + natural_key` e `relation_type + endpoints`. O ADR 0008 adicionou as
camadas L1 (system edges cross-repo) e L2 (journey bindings) e o pipeline
build↑ / query↓.

Até antes deste ADR, IDs fluíam pelas camadas em três formas divergentes:

| Camada | Formato | Largura do hash |
| --- | --- | --- |
| L0 record | `<type>:<natural_key>` | sem hash |
| L0 relation | `<type>:<from>-><to>` (com record ids no corpo) | sem hash |
| L0 FrontierFact (`frontier-export.mjs`) | `ff:<kind>:<16-hex-sha256>` | 16 hex |
| L1 FrontierFact (`frontier-extract.mjs`) | `ff:<short-kind>:<32-bit-imul>:<line>` | 8 hex, hash não-cripto |
| L1 edge | `l1:<32-hex-sha256>` | 32 hex |
| L2 journey_id | `<spec.id>` cru | sem hash |
| L2 bind_id | `<ns>:<journeyId>:<journeyHash>` | sem prefixo |
| L2 journey_hash | `<32-hex-sha256>` (sem version stamp) | 32 hex |
| Slice | `slice:<64-hex>` | 64 hex |
| Pack | sem `pack_id` determinístico | — |

Havia três problemas concretos:

1. **IDs sem prefixo de camada** — `service:billing` (L0) e `l1:<hash>` (L1)
   não revelam a camada no próprio ID; um leitor de Slice/Pack não consegue
   distinguir versões sem uma tabela externa.
2. **Geradores de FrontierFact divergentes** — `frontier-export.mjs`
   (SHA-256 de 16 hex) e `frontier-extract.mjs` (imul 32-bit com kind
   abreviado `in|out|cfg`) produziam IDs diferentes para a mesma âncora
   fática. A união L0→L1 dependia de coincidência de formato, não de
   identidade determinística.
3. **Sem versionamento de identidade** — qualquer mudança no formato de ID
   (L0, L1 ou L2) não invalidava de forma comprovável o `canonical_graph_hash`
   L0, o `edge_id` L1, o `journey_hash`/`bind_id` L2, a `derivation_key` /
   `slice_hash` do Slice, ou o `pack_id`. Uma alteração silenciosa poderia
   servir cache stale.

O plano `persistent-context-slice-engine-v2.md` (Todo 8b) exige um portão de
identidade que bloqueie todos os Todos 9–19 até que IDs sejam versionados e
padronizados cross-layer. Este ADR é esse portão.

## Decisão

### ID_VERSION=2 e prefixos de camada fechados

Toda nova identidade produzida pelo pipeline usa `ID_VERSION=2` e um único
módulo compartilhado (`skills/explorer-l0/src/layered-id.mjs`). Os formatos
fechados são:

| Identidade | Formato | Largura |
| --- | --- | --- |
| L0 record | `l0:<record-kind>:<canonical-natural-key>` | natural key legível |
| L0 relation | `l0:rel:<RELATION_TYPE>:<from-canonical-natural-key>-><to-canonical-natural-key>` | natural keys legíveis |
| L0 FrontierFact | `l0:ff:<kind>:<16-hex-sha256>` | 16 hex |
| L1 edge | `l1:edge:<32-hex-sha256>` | 32 hex |
| L2 journey | `l2:journey:<journey-id>` | verbatim |
| L2 bind | `l2:bind:<32-hex-sha256>` | 32 hex |
| Slice | `slice:<64-hex>` | 64 hex |
| Pack | `pack:<64-hex>` | 64 hex |

Larguras pré-existentes são **preservadas** (16 hex ff, 32 hex L1/L2, 64 hex
Slice/Pack). Não há encurtamento de entropia.

### IDs legados como id_version=1

Qualquer ID sem prefixo de camada (`service:billing`, `ff:http_inbound:...`,
`l1:<hash>`) é reconhecido como `id_version=1` por `detectIdVersion`. Leitores
v2 rejeitam mistura v1+v2 com `MixedVersionError` tipado — sem alias table,
sem dual-read, sem dual-write, sem fallback silencioso.

### Body de Relation contém natural keys; endpoints persistem record ids

O ID de uma Relation carrega **canonical natural keys** no corpo
(`l0:rel:EXPOSES:billing->get:/billing`), nunca record ids completos. Os
campos `from_record`/`to_record` da relação persistida continuam armazenando
o **L0 record id completo** (`l0:service:billing`, `l0:endpoint:get:/billing`).
Isso mantém o ID legível e estável quando apenas o tipo de origem muda, sem
perder a integridade referencial.

### Fronteiras L1

L1 é exclusivamente cross-repo. Edge endpoints **sempre** referenciam
`l0:ff:*` (FrontierFacts), nunca `l0:method:*`, `l0:endpoint:*`, ou outro L0
record id direto. `assertL0FfEndpoints` valida essa invariante na construção
de cada edge no matcher; a resolução para `l0:<record-kind>:*` ocorre
somente via `frontierFactsWithOrigins` + `slice-anchor-resolver` (mapa
explícito), nunca por matching de arquivo/nome. `frontierFactsWithOrigins`
continua sendo a ponte explícita `l0:ff:* -> l0:<record-kind>:*`.

### Um único gerador de FrontierFact

L0 export (`frontier-export.mjs`) e L1 extraction (`frontier-extract.mjs`)
chamam o mesmo `makeFrontierFactId` com **inputs normalizados idênticos**:
`{kind, namespace, logical_repo, source_revision, identity_key, file, line}`.
A ordem do material é
`idv<ID_VERSION>|namespace|logical_repo|source_revision|kind|identity_key|file|line`.
Kind sempre canonical (`http_inbound|http_outbound|config_binding|topic_publish|topic_consume`),
nunca alias abreviado.

### ID_VERSION entra em todo hash

`ID_VERSION` entra no material de cada hash determinístico (FrontierFact,
L1 edge, L2 bind, journey_hash, spec_revision, derivation_key, slice_hash,
pack_id). Mudar **somente** `ID_VERSION` invalida:

- `canonical_graph_hash` L0 (porque os record/relation ids mudam);
- `edge_id` L1 e `edge_set_hash`;
- `journey_hash`/`bind_id`/`spec_revision` L2;
- `derivation_key` e `slice_hash` (campo `id_version` no struct canônico);
- `pack_id`.

Nenhum relógio (`*_at`, durações) participa de qualquer hash.

### Comparação raw de code units

Toda ordenação canônica usa `compareRaw(a, b) = a < b ? -1 : a > b ? 1 : 0`.
`localeCompare` foi removido do `graph-hash.mjs`, `candidate-package.mjs`,
`frontier-export.mjs` e `frontier-extract.mjs`. O plano proíbe `localeCompare`
em qualquer ordenação canônica.

### Schema migration forward-only

- Component-scoped versioning via `explorer_schema_versions(component='context-slice')`
  — nunca `PRAGMA user_version` global.
- Slice schema bumped v1 → v2 com `ALTER TABLE context_slices ADD COLUMN id_version`.
  Forward-only; fail-closed para versão futura.
- L1/L2 continuam sem bump de schema (são derivados; seus dados são
  re-derivados após migração L0 aceita).
- `engine_version` bumped para `context-slice-engine/v2-idv2`;
  `slice_schema_version` bumped para `2`. Ambos participam da derivation key.

### Migração explícita, dry-run-first

`skills/explorer-query/src/slice-migrate.mjs` implementa a migração. Contrato:

- **dry-run** lista contagens (`v1_detected`, `edges_before`, `binds_before`,
  `rows_before`) e a cascata planejada, **sem writes**.
- **execute** roda em ordem de dependência:
  1. L0: cria um **candidate v2** derivado do payload aceito v1; **nunca**
     reescreve uma baseline aceita in-place; o candidate fica pendente de
     Human Gate (via `acceptBaseline` existente).
  2. L1/L2/Slice: tabelas derivadas são resetadas em uma transação
     `BEGIN IMMEDIATE`. Re-derivação só ocorre após o usuário aceitar o
     candidate v2.
- **Rollback**: qualquer exceção durante o execute faz `ROLLBACK` e o
  relatório retorna `rolled_back: true` com a mensagem. Nunca deixa estado
  misto v1/v2 em disco.
- **Sem alias/dual**: nenhum alias table, dual-read, dual-write, ou fallback
  silencioso. v2 readers rejeitam mistura com `MixedVersionError`.

## Consequências

- **Cache invalidation comprovável**: bump de `ID_VERSION` invalida todo
  cache downstream. Não há caminho para servir cache stale após uma mudança
  de formato.
- **Grep guardado**: outputs v2 novos não contêm IDs legados
  (`^(method|service|controller|endpoint|ff|l1):` fora das fixtures v1
  explícitas da migração).
- **Decoder ring**: o glossário (`docs/domain/glossary.md`) ganha uma tabela
  v1↔v2 para leitores humanos.
- **Projeção Obsidian**: arquivos de projeção mudam de nome
  (`l0:service:billing` em vez de `service:billing`); uma regeração completa
  substitui os antigos (writeProjectionAtomic). Humanos que mantinham links
  devem regenerar.
- **Migração é evento explícito**: bases aceitas L0 exigem um Human Gate
  separado por repo; não há auto-promoção. Operadores precisam executar
  `slice-migrate execute` + `accept` para cada repo antes de re-derivar
  L1/L2/Slice.

## Alternativas rejeitadas

1. **Alias table v1↔v2**: permitiria dual-read silencioso e serviria cache
   stale sob mudança de formato. Rejeitada — viola o princípio de
   content-addressed cache.
2. **Dual-write durante janela de transição**: duplicaria persisted rows e
   exigiria GC deambiguous. Rejeitada — complexity sem benefício.
3. **Encurtar hashes para alinhar com exemplo esquemático**: reduziria
   entropia e abriria colisão. Rejeitada — larguras atuais preservadas.
4. **Aceitar `l0:method:*` como endpoint L1**: quebraria a fronteira "L1 é
   cross-repo via FrontierFacts". Rejeitada — `assertL0FfEndpoints` mantém a
   invariante.
5. **Rewrite de baseline aceita in-place**: bypass do Human Gate.
   Rejeitada — candidate v2 + accept é o único caminho.
6. **PRAGMA user_version global**: colidiria com L1/L2 no DB compartilhado.
   Rejeitada — component-scoped `explorer_schema_versions`.

## Rollback

Reverter este ADR significa:

1. Rebaixar `ID_VERSION=1` em `layered-id.mjs` (quebra determinismo dos v2
   outputs a partir daquele ponto);
2. Reexecutar `slice-migrate execute` em modo "un-migrate" não implementado
   (teria que ser adicionado);
3. Recuperar backups das bases aceitas L0 (o migrador nunca reescreve
   aceitos in-place, então o rollback é restaurar o DB anterior).

Operacionalmente, o caminho mais seguro é manter `ID_VERSION=2` e nunca
reverter; o custo de manter v2 é menor que o de orquestrar rollback
cross-layer. Este ADR é **irreversível na prática** após a primeira baseline
v2 ser aceita.

## Referências

- `.omo/plans/persistent-context-slice-engine-v2.md` Todo 8b (este ADR é o
  entregável documental do portão de identidade).
- ADR 0002 — Canonical ID de Knowledge Record/Relation.
- ADR 0008 — Pipeline L0/L1/L2 e `frontierFactsWithOrigins`.
- `skills/explorer-l0/src/layered-id.mjs` — implementação de referência.
- `skills/explorer-query/src/slice-migrate.mjs` — comando de migração.
