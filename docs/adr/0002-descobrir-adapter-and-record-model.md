---
status: accepted
---

# ADR 0002 — Código em revisão fixada como verdade factual; Artifact Adapter como seam e modelo canônico de registros indexados para Descobrir

## Contexto

O ADR 0001 fixou que o Project Knowledge Graph é a fonte de verdade factual **operacional** de um projeto e que diagramas são projeções descartáveis. Ficou em aberto, porém, qual é a verdade **evidencial** que alimenta o grafo durante o fluxo Descobrir — em especial quando uma Discovery Engine opera sobre um Repositório e produz artefatos estruturados que poderiam, eles próprios, ser confundidos com a fonte.

A auditoria de consumo realizada durante o desenho do harness produziu quatro bloqueadores concretos para tratar a saída de uma skill como contrato direto de ingestão:

1. Perfis de projeto produzem schemas diferentes sem discriminação formal — o manifesto de metadados do explorer varia entre API, SPA e cron, e o índice de endpoints muda de significado.
2. Entry points vivem em Markdown livre e mudam de semântica por projeto.
3. Diagramas não registram revisão nem proveniência legível por máquina por item.
4. O linter produz falso OK: blocos de detalhe vazios passam e identificadores de relacionamento `j-*`/`le-*` escapam da validação.

A pontuação da auditoria (explorer 5,5/10; architecture-diagrams 3/10 para máquina; seam entre ambas 2,5/10) evidencia que o artefato nativo de uma skill é útil para navegação humana, mas insuficiente como contrato automático. Ao mesmo tempo, descartar esses artefatos e inventar um "grafo universal" próprio do harness romperia com a propriedade da skill sobre o seu formato e exigiria manter, em paralelo, dois modelos do mesmo código.

O fluxo Descobrir precisa de um contrato estável que (a) preserve o artefato nativo como evidência primária indexada, (b) mantenha as skills substituíveis e (c) gere registros determinísticos verificáveis contra a fonte real — sem fixar tecnologia de armazenamento, produtor específico ou enumeração fechada de tipos.

## Decisão

### Verdade evidencial vs índice operacional

O **código-fonte de um Repositório em uma revisão lógica fixada** é a **fonte evidencial**. Discovery Engines não são fonte de verdade: operam sobre essa fonte e a tornam navegável em formato indexável. Um Native Artifact comprova o que uma Discovery Engine disse sobre a fonte naquela revisão; não comprova, por si só, um fato do código.

O **Project Knowledge Graph** é o **índice factual operacional**: deriva e persiste fatos verificáveis a partir da evidência. Não há tensão com o ADR 0001 — o grafo continua sendo a fonte de verdade operacional do projeto; a âncora evidencial de cada fato comprovado é o código na revisão pinada.

### Posse e preservação de artefatos nativos

Cada **Discovery Engine é dona do seu formato nativo**. Native Artifacts são **untrusted**. Preservação v1 é **in-place**: o **Artifact Manifest** versionado registra path relativo ao repositório lógico, hash de conteúdo (SHA-256), role, revisão declarada, status e `acquisition_mode` (`reused`|`fresh`); os bytes brutos permanecem no Contexto-alvo e **não** são copiados para a saída do harness nem para o baseline. O harness não reescreve, normaliza nem descarta conteúdo nativo durante a adaptação; apenas lê via Artifact Adapter com confinamento de path (realpath; rejeitar symlink escape).

O ID do manifesto é content-addressed a partir do conjunto **atual** de artefatos (namespace + logical_repo + source_revision + engine/profile + hashes ordenados) e **exclui** `acquisition_mode`, timestamps e run ids. O manifesto não representa histórico de múltiplas execuções da engine.

### Seam do Artifact Adapter

O **Artifact Adapter é a única seam canônica** entre Native Artifacts e o Project Knowledge Graph. Satisfaz um contrato estável, independente de produtor: lê artefatos nativos sem mutá-los e emite Knowledge Records tipados e Relations separadas, cada um com Evidence apontando para a origem real. Substituir uma Discovery Engine ou adicionar uma nova exige apenas um novo Adapter; o contrato do grafo não muda.

### Modelo de registros

A unidade factual de entidade é o **Knowledge Record**, com campos mínimos genéricos:

```
KnowledgeRecord {
  id, namespace, type, name, summary,
  attributes,
  status,
  source_revision,
  source_engine,
  evidence[]
}
```

As relações entre entidades vivem em **registros separados**, não embutidas em atributos:

```
Relation {
  id, namespace,
  from_record, relation_type, to_record,
  status,
  source_revision,
  source_engine,
  evidence[]
}
```

A notação acima descreve campos, não formato de armazenamento. Os valores abaixo são **strings genéricas no contrato** e só ganham enumeração ou semântica operacional em um Project Profile, nunca neste ADR:

- `type` (em KnowledgeRecord) e `relation_type` (em Relation);
- `source_engine`, `source_revision` e `namespace` (fronteira de projeto);
- qualquer valor que identifique engine, projeto ou profile.

### Namespace e identidade

- IDs de Knowledge Record e Relation são **únicos dentro do Knowledge Namespace**.
- Persistência e Relations **não cruzam** namespaces.
- O `namespace` de uma Relation deve coincidir com o dos records conectados e com o namespace da carga.
- O **Canonical ID de um Knowledge Record** deriva deterministicamente de `type + natural_key normalizada`, **excluindo** path de máquina, revisão e engine.
- O **Canonical ID de uma Relation** é determinístico e **type-prefixed**, derivado de `relation_type + from_record + to_record`.

A normalização da natural_key é responsabilidade do Artifact Adapter para cada `type`; o contrato apenas exige que o resultado seja estável, determinístico e independente de ambiente.

### Evidence como união discriminada

`evidence[]` é uma união discriminada por `kind`:

```
RepositoryReference = {
  kind: "repository",
  uri: "repo://<repo-lógico>@<revisão>/<caminho>#L<início>-L<fim>"
}
ArtifactReference = {
  kind: "artifact",
  manifest_id,
  artifact_path,
  content_sha256,
  range
}
Evidence = RepositoryReference | ArtifactReference
```

Uma Repository Reference sempre aponta para código-fonte (repositório lógico + revisão + caminho + intervalo). Path segments proíbem percent-encoding e caracteres reservados `% ? # @` (ver `repo-reference.md`).

Uma Artifact Reference aponta para um intervalo dentro de um Native Artifact. Shape exato: `{kind:"artifact", manifest_id, artifact_path, content_sha256, range}`. `artifact_path` usa as mesmas restrições estritas de path relativo das entradas do manifesto e deve resolver para um artefato listado com hash correspondente.

### Regras de status da fonte

| status | Condição |
|---|---|
| `comprovado` | O registro/relação possui **sua própria** Repository Reference resolvível e verificada contra o código na `source_revision`. |
| `hipótese` | A única Evidence é Artifact Reference, ou a Repository Reference não foi verificada ou não é resolvível. |
| `contradição` | **Status** (nunca flag): fontes distintas apresentam afirmações incompatíveis; nenhuma versão é promovida a canônica até resolução explícita. |
| `stale` | O código avançou além da `source_revision` em que o fato foi observado. Consumido por checagens de freshness posteriores; v1 registra `source_revision` e não implementa updater incremental. |

**Artefato nativo prova o que a engine disse; `comprovado` exige Repository Reference resolvível e verificada no próprio registro/relação.** Não existe status `comprovado` apoiado apenas em Artifact Reference. Amostragem é auditoria, não promoção em lote.

### Provenance Coverage

Provenance Coverage é um **conjunto de métricas** com duas taxas (definição única):

1. `artifact_reference_percentage` — proporção de records/relations com Artifact Reference válida.
2. `repository_verified_percentage` — proporção de records/relations com Repository Reference verificada e status `comprovado`.

Artefato-only permanece `hipótese`.

### Repeatability

Repeatability é propriedade do **índice produzido pelo Artifact Adapter** para bytes idênticos de Native Artifact + mesma `source_revision`. Compara Records/Relations canônicos **incluindo** evidence e status, **excluindo** metadados narrativos/observacionais. O GraphIndex carrega `canonical_graph_hash` sobre o conjunto canônico completo e estruturado; o resultado compara esse hash. Manifest id e hashes brutos de artefato não substituem o conteúdo do grafo. Reexecução da Discovery Engine não faz parte do gate v1.

### GraphIndex

Cada carga produz um **GraphIndex** com IDs ordenados de records e relations, contagens e `canonical_graph_hash`.

### Baseline candidate e Human Gate

A fase final do fluxo **prepara um baseline candidate**; não publica no namespace aceito. Aprovação no Human Gate publica/aceita atomicamente; rejeição deixa o namespace anterior inalterado.

### Fronteira de dados e segurança

- Nunca persistir segredos, env, connection strings, payloads brutos de código, paths absolutos ou conteúdo de arquivos dirty em records, summary, attributes ou reports.
- Repositório-alvo nunca é mutado; evidência de código vem da revisão pinada, nunca da working tree.
- Paths de máquina só na config efêmera do resolver.
- Política de namespace e Data Boundary Policy aplicam-se integralmente.

### Compressão narrativa

Compressão narrativa (resumos, renderização, prosa para consumo humano) pode ser aplicada **apenas depois** da saída estruturada existir, e **não pode mutar**: IDs, atributos, Relations, Evidence, hashes, status ou contagens. A saída estruturada é o contrato; a prosa é projeção sobre ela, nunca o inverso.

## Consequências

**Positivas:**

- Skills permanecem donas do formato nativo; substituir uma Discovery Engine ou adicionar uma nova exige apenas um novo Artifact Adapter, sem mudar o contrato do grafo.
- Native Artifacts são preservados in-place como evidência primária rastreável, sem copiar corpos untrusted para o harness.
- Canonical IDs determinísticos permitem que reindexações, migrações de Contexto e comparações de baseline tratem o mesmo fato lógico pelo mesmo id dentro do namespace.
- A separação Repository Reference vs Artifact Reference torna explícito o que é fato do código e o que é afirmação de engine, impedindo promoção silenciosa de hipótese a fato.
- Repeatability ancora no conteúdo canônico do grafo (`canonical_graph_hash`), não em reexecução de engine.
- Diagramas e projeções permanecem fora do contrato factual, mantendo coerência com o ADR 0001 (grafo = índice operacional; código pinado = evidência).

**Negativas/riscos:**

- Project Profiles precisam definir a natural_key por `type`; sem isso, IDs canônicos não são computáveis e o contrato não opera.
- Adaptadores são código por tipo de artefato nativo: cobrir todos os formatos relevantes é trabalho contínuo, e lacunas resultam em registros `hipótese`.
- Registros suportados apenas por Artifact Reference nunca atingem `comprovado`, o que pode manter `repository_verified_percentage` abaixo de limiares desejados mesmo quando a engine é confiável.
- A regra "compressão narrativa não muta campos estruturados" precisa ser enforced por ferramentas; violação silenciosa quebra a rastreabilidade que este contrato garante.
- Preservação in-place exige que o Contexto-alvo mantenha os bytes dos Native Artifacts acessíveis enquanto o manifesto e as Artifact References forem usados para auditoria.

## Alternativas rejeitadas

### Markdown do produtor como verdade canônica

Tratar manifestos de metadados, índices de endpoints, blocos de detalhe e listas de fluxos como contrato direto de ingestão, sem Adapter.

Rejeitada porque a auditoria mostrou schemas instáveis entre perfis (metadados variam entre API, SPA e cron), entry points vivem em Markdown livre com semântica variável por projeto, e o linter produz falso OK (blocos de detalhe vazios passam, identificadores `j-*`/`le-*` escapam). Sem discriminação formal de schema, ingestão direta quebra a cada mudança de produtor.

### Nodes e edges genéricos sem tipo

Modelar o grafo como nodes e edges sem tipo, com toda a semântica em metadata.

Rejeitada porque serviço, contrato, evento, fluxo, classe e decisão têm significado próprio e invariantes distintos; achatar tudo em entidade genérica força cada consulta e cada teste a reconstruir tipo e regras a partir de metadata, perdendo profundidade na interface. Relations tipadas separadas preservam a semântica e mantêm o teste focado na seam do Adapter.

### Diagramas como grafo round-trip

Tratar a projeção visual produzida por skills de diagrama como um grafo editável que pode ser lido de volta como fato.

Rejeitada porque o diagrama é uma projeção sem SHA nem proveniência legível por máquina por item (pontuação 3/10 para máquina na auditoria); tratá-lo como round-trip viola o ADR 0001 (diagramas são projeções descartáveis) e introduz um caminho de mão dupla em que coordenadas, tema e animação passariam a ser tratados como verdade do domínio.

### Copiar Native Artifacts para o harness como preservação padrão

Copiar corpos de Native Artifacts para `output/` ou baseline como forma padrão de preservação.

Rejeitada em v1: aumenta superfície de dados untrusted no harness, multiplica risco de vazar segredos embutidos em artefatos e não é necessária para indexação — path relativo + hash + leitura confinada bastam. Cópias explícitas, se algum dia forem necessárias, exigem decisão e política separadas.

## Evidência

A auditoria de consumo incorporada a este ADR é a base empírica direta:

- Explorer 5,5/10 — base útil, incremental e navegável, mas manifesto de metadados instável, índice de endpoints muda de significado e sem IDs canônicos fechados.
- Architecture Diagrams 3/10 máquina / 7/10 humano — boa projeção visual, mas sem SHA/proveniência por item, linter aceita bloco de detalhe vazio e regex ignora edges `j-*`.
- Seam entre ambas 2,5/10 — funciona para navegação humana, mas perde dados e identidade no caminho; sem canonical key comum.

A modelagem registrada neste ADR estabelece os campos mínimos e a separação entre Record e Relation. A decisão de tratar skills como contratos de conhecimento preserva o artefato nativo e sua fonte real, enquanto seções, links e IDs indexados são derivados e projeção visual não vira verdade do domínio.

O fluxo `workflows/descobrir/FLOW.md` operacionaliza esta decisão em seis fases (resolver fonte → obter artefatos nativos → adaptar artefatos → normalizar referências → validar evidências → preparar baseline candidate), incluindo GraphIndex com `canonical_graph_hash`, verificação de Repeatability do índice do Adapter, Provenance Coverage com duas taxas, e Human Gate em que Marley aprova o baseline candidate para publicação atômica no namespace aceito.
