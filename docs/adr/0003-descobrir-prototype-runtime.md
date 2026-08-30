---
status: accepted
---

# ADR 0003 — Protótipo descartável como mecanismo de validação executável do fluxo Descobrir

## Contexto

O ADR 0002 fixou o contrato do Artifact Adapter e o modelo canônico de Knowledge Records. O fluxo Descobrir (`workflows/descobrir/FLOW.md`) descreve seis fases e um Human Gate, mas permanece um documento de contrato sem nenhum caminho executável que prove que o contrato é satisfatível com os artefatos reais de um projeto.

O harness é explicitamente docs-first e sem runtime: o README declara que nenhum workflow vira executável antes de ter FLOW.md aprovado (Gate A), e que a implementação de produção vem depois da aprovação do contrato. Essa regra não exclui protótipos descartáveis de validação — exclui runtimes permanentes e dependências de pacote instaladas.

**Gate A congela o contrato e autoriza o protótipo pós-Gate-A.** Evidência executável é **Gate C**, não pré-requisito para Gate A. Este ADR descreve o desenho do protótipo que só deve ser implementado depois que Gate A aprovar o contrato docs-first.

Três questões ficaram em aberto após o ADR 0002 e motivam o protótipo (pós-Gate-A):

1. **Proveniência de artefatos nativos não rastreados.** Os artefatos produzidos pela skill `explorer` em `.claude/explorer/` são gitignored no repositório-alvo e portanto não participam do histórico de revisões. Indexá-los sem hash de conteúdo deixa a Evidence sem âncora verificável: não há como distinguir o artefato lido de um estado intermediário ou contaminado da árvore de trabalho.

2. **Verificação de código contra a revisão fixada.** O ADR 0002 exige que Repository References apontem para código na `source_revision`, não para bytes da árvore de trabalho atual. Usar diretamente os arquivos do diretório de trabalho como evidência viola essa regra: a árvore pode ter modificações não commitadas que contaminam a prova.

3. **Contrato e perfil de adapter ainda não exercitados em runtime.** O Artifact Adapter existe como decisão de design. Após Gate A, o protótipo deve produzir Knowledge Records a partir dos artefatos do piloto, verificar IDs canônicos, calcular Provenance Coverage e gerar relatório de lacunas — evidência de Gate C, não condição de Gate A.

O piloto disponível é o repositório com identidade lógica canônica **`demo-cloud`** (display `demo/cloud`) na revisão `633d3a5d16c165073ede2b2248bae708483f2efe`. Esse repositório possui duas entradas sujas preexistentes na árvore de trabalho — uma remoção rastreada e um caminho não rastreado — que não serão lidas como evidência de código fixado. O ambiente de execução possui Node v26 com as APIs nativas `node:crypto`, `node:fs`, `node:test` e `node:child_process` suficientes para o escopo da validação.

## Decisão

### Escopo: protótipo descartável pós-Gate-A, não skill de produção

O mecanismo de validação é um **protótipo descartável** isolado sob `prototypes/descobrir-v1/`, autorizado somente **depois** que Gate A congelar o contrato. Ele não faz parte da arquitetura permanente do harness, não introduz dependências de pacote externas, não instala nenhum runtime adicional e não é uma skill instalável. Seu único propósito é produzir evidência executável (Gate C) de que o contrato do ADR 0002 é satisfatível para o piloto `demo-cloud` na revisão fixada. Quando essa evidência existir e for aceita no Gate C, o diretório do protótipo pode ser apagado sem nenhum impacto no harness.

### Isolamento de saída

Toda saída do protótipo — Artifact Manifest, Knowledge Records, Relations, GraphIndex, Coverage Report, hashes, logs — é escrita exclusivamente sob `prototypes/descobrir-v1/output/`. A saída **não** copia corpos de Native Artifacts. Nenhum arquivo é criado ou modificado no repositório-alvo. Nenhum arquivo é criado fora do diretório do protótipo dentro do harness.

### Hash e preservação in-place de artefatos nativos

Artefatos nativos da skill `explorer` em `.claude/explorer/` são **untrusted**. São lidos do disco via `node:fs` com **confinamento realpath**: o path resolvido deve permanecer dentro da raiz permitida do repositório lógico; symlinks que escapem essa raiz são rejeitados. O conteúdo é imediatamente resumido com `node:crypto` (SHA-256). O hash é registrado no Artifact Manifest junto com o path relativo, o role, a revisão de produção declarada e `acquisition_mode`. Bytes brutos **não** são copiados para `output/`. Esse hash substitui a identidade de revisão git ausente para o artefato. O estado dos dois arquivos sujos pré-existentes no piloto é registrado no relatório de cobertura como contagens/nomes de path dirty da árvore de trabalho, **sem copiar seus conteúdos**.

### Verificação de código contra a revisão fixada (execução segura)

Para que uma Repository Reference receba status `comprovado`, o protótipo resolve o conteúdo do arquivo na revisão-âncora `633d3a5d16c165073ede2b2248bae708483f2efe` via acesso somente-leitura ao objeto git do repositório local.

Acesso futuro a git **deve** usar `child_process.spawn` ou `child_process.execFile` com:

- `shell: false`
- argv explícito (sem interpolação de string de shell)
- revisão e path **validados** antes da execução (sem metacaracteres de path; path relativo seguro conforme `repo-reference.md`)
- `cwd` fixo na raiz resolvida pelo Repository Resolver
- ambiente mínimo (não herdar secrets desnecessários do process env)
- **sem** fallback para bytes da working tree

Exemplo de forma: `git show <revisão-validada>:<caminho-validado>` via argv. Se o caminho não existir na revisão, o registro recebe status `hipótese`. Os dois arquivos pré-existentes com estado sujo não são tratados como fontes comprovadas: sua Repository Reference aponta para a revisão fixada, e o conteúdo verificado é o que estava commitado naquela revisão, não o que está no disco.

### Evidência de mutação: estado pré/pós do repositório-alvo

O protótipo registra o estado do repositório-alvo antes e depois da execução como evidência de que nenhuma mutação foi introduzida: presença do objeto da revisão-âncora, contagens de arquivos rastreados, contagem/nomes de paths dirty (sem conteúdos), e hash dos artefatos lidos. O estado pós-execução deve ser **equivalente** ao pré-execução para qualquer superfície fora de `prototypes/descobrir-v1/output/`. Equivalência pré/pós é obrigatória no Coverage Report (`mutation.equivalent`).

### Zero dependências externas

O protótipo usa exclusivamente:

- `node:fs` — leitura confinada de artefatos nativos e escrita de saída estruturada
- `node:crypto` — hashing de conteúdo (SHA-256)
- `node:child_process` — `spawn`/`execFile` com `shell:false` para acesso a objetos git e captura de estado do repositório
- `node:test` — asserções de contrato e relatório de cobertura embutido no Node v26

Nenhum `package.json`, `node_modules`, instalação de dependência ou ferramenta externa é necessária. O protótipo é portável entre máquinas com acesso local ao repositório piloto e Node v26 instalado.

### O que o protótipo valida (Gate C)

O protótipo valida dois artefatos do ADR 0002:

1. **Contrato do Artifact Adapter.** Para cada artefato nativo lido de `.claude/explorer/`, o protótipo aplica um adapter mínimo e produz Knowledge Records e Relations com todos os campos obrigatórios. IDs canônicos são computados a partir das regras do ADR 0002. Artifact References usam o shape `{kind:"artifact",manifest_id,artifact_path,content_sha256,range}`. O GraphIndex inclui `canonical_graph_hash`. O relatório de cobertura registra Provenance Coverage (`artifact_reference_percentage`, `repository_verified_percentage`), histograma de status, repeatability, producer_baseline, mutation e `passed`.

2. **Perfil de adapter para o piloto `demo-cloud`.** O protótipo exercita o perfil concreto do repositório-alvo: quais tipos de artefato existem, quais types de Knowledge Record e relation_types emergem, qual a natural_key por type para esse perfil. Esse perfil é escrito em `prototypes/descobrir-v1/output/adapter-profile.json` e constitui evidência empírica de Gate C.

### Portabilidade e VDI

O protótipo não depende de rede, de ambiente Kubernetes, de credenciais nem de paths absolutos embutidos. O Repository Resolver mapeia a identidade lógica `demo-cloud` (display `demo/cloud`) ao path local no contexto de execução; esse mapeamento não é embutido no código do protótipo e permanece efêmero. Em contexto VDI sem acesso ao repositório local, o protótipo falha na Fase 1 com bloqueador explícito registrado, sem gerar saída parcial silenciosa.

### Rollback e deleção

Deletar `prototypes/descobrir-v1/` integralmente remove o protótipo sem efeito residual no harness ou no repositório-alvo. Nenhum estado externo depende desse diretório. Se a validação (Gate C) revelar que o contrato do ADR 0002 precisa ser revisado, o protótipo é descartado, o ADR 0002 é atualizado sob novo ciclo de Gate A, e um novo protótipo pode ser criado a partir do zero.

## Consequências

**Positivas:**

- Gate A permanece docs-first: o contrato pode ser aprovado sem exigir runtime prévio; o protótipo é consequência autorizada, não pré-condição.
- Gate C ganha evidência executável concreta: Knowledge Records reais, hashes reais, GraphIndex, relatório de cobertura real, tudo produzido a partir dos artefatos do piloto na revisão fixada.
- Artefatos gitignored passam a ter identidade verificável via hash de conteúdo, sem copiar corpos untrusted para o harness.
- A separação entre bytes da árvore de trabalho e bytes da revisão fixada é enforced pela implementação segura de git (`spawn`/`execFile`, `shell:false`).
- Zero dependências externas garantem reprodutibilidade em qualquer máquina com Node v26 e acesso local ao repositório.
- O perfil de adapter produzido é evidência empírica reutilizável quando a skill de produção for implementada.

**Negativas/riscos:**

- O protótipo não é instalável nem reutilizável diretamente: produz evidência de Gate C, não uma skill. A skill de produção requer decisão e design separados.
- Acesso git exige que o repositório-alvo seja um repositório git válido com o objeto da revisão-âncora acessível localmente; repositórios rasos ou sem fetch da revisão exata bloqueiam a Fase 1.
- Artefatos nativos produzidos em contextos diferentes (máquinas distintas, instâncias diferentes do `explorer`) podem produzir hashes diferentes para o mesmo conteúdo lógico se o formato nativo não for determinístico; esse gap é registrado no relatório de cobertura. Repeatability v1 compara o índice do Adapter para os **mesmos** bytes de artefato, não exige reexecução da engine.

## Alternativas rejeitadas

### Runtime permanente com banco de dados

Introduzir um banco de dados local (SQLite, arquivo JSON persistido fora do diretório do protótipo) como armazenamento do Project Knowledge Graph nesta etapa.

Rejeitada porque o README do harness é explícito: não existe runtime, banco nem Context Gateway real nesta etapa. Adicionar persistência permanente agora misturaria a validação do contrato com uma decisão de tecnologia de armazenamento que não faz parte do escopo do ADR 0002 e que o FLOW.md deliberadamente não fixa.

### Leitura da árvore de trabalho como evidência de código fixado

Usar diretamente o conteúdo dos arquivos no diretório de trabalho do piloto como prova de que um fato existe na revisão pinada.

Rejeitada porque viola o ADR 0002: `comprovado` exige Repository Reference verificada contra o código na `source_revision`, não contra bytes que podem ter sido modificados depois da revisão. Os dois arquivos pré-existentes com estado sujo no piloto ilustram exatamente esse risco: seus bytes no disco diferem dos bytes commitados e lê-los como evidência produziria um `comprovado` falso.

### Graphiti, enrichment semântico ou recuperação por similaridade

Usar um grafo de conhecimento com armazenamento semântico, embeddings ou recuperação vetorial para enriquecer os Knowledge Records durante a validação.

Rejeitada porque introduz dependências externas, requer instalação de pacotes e adiciona uma camada de transformação que não é auditável como contrato. O protótipo precisa provar que o Artifact Adapter funciona; enriquecimento semântico é uma decisão posterior e independente.

### Commits ou escrita no repositório-alvo

Commitar os Knowledge Records no repositório piloto ou escrever qualquer artefato fora de `prototypes/descobrir-v1/output/`.

Rejeitada porque contamina o repositório-alvo com artefatos de validação e mistura o estado de prova com o estado operacional do projeto. A evidência do protótipo vive no harness, não no alvo.

### Exigir protótipo executável antes de Gate A

Tratar evidência runtime como pré-requisito para aprovar o FLOW.md.

Rejeitada porque viola a política docs-first do harness: Gate A congela o contrato; Gate C valida executavelmente. Inverter a ordem acopla aprovação de contrato a um artefato descartável ainda inexistente e incentiva implementação antes do contrato estável.

### `shell: true` ou string interpolation para git

Invocar git via shell com strings interpoladas de revisão/path.

Rejeitada por risco de command injection e por violar a regra de argv explícito com `shell:false`.

## Evidência

O repositório piloto com identidade lógica **`demo-cloud`** (display `demo/cloud`) na revisão `633d3a5d16c165073ede2b2248bae708483f2efe` é o alvo concreto do protótipo pós-Gate-A. Duas entradas sujas preexistentes aparecem na árvore de trabalho antes do início do protótipo; esse estado é registrado como condição inicial no relatório de cobertura sem copiar seus valores. Os artefatos nativos em `.claude/explorer/` são gitignored e serão lidos do disco com confinamento realpath e hash SHA-256 registrado no Artifact Manifest (sem cópia de corpos). O acesso ao código fixado ocorre exclusivamente via `spawn`/`execFile` (`shell:false`) com `git show <revisão-validada>:<caminho-validado>` sobre o repositório local.

O protótipo valida o contrato do ADR 0002 e produz um perfil de adapter para `demo-cloud` como evidência de Gate C. Não é uma skill instalável de produção. **Não é pré-requisito de Gate A.**
