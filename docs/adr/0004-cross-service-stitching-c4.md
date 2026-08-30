---
status: accepted
note: L1 v1 implemented in skills/l1 (ADR 0007). L2+ still deferred.
---

# ADR 0004 — Stitching cross-service e C4 emergente bottom-up

## Contexto

Os ADRs 0002/0003 fixaram e provaram a camada **micro**: um grafo por serviço, verificado contra a revisão pinada (`comprovado`/`hipótese`), consumível cirurgicamente. O context-loader (Tarefa 2) provou isso no demo — carregar um flow resolve o subgrafo + código dos nós verificados sob demanda.

O objetivo real, porém, é a **knowledge base de uma empresa inteira**: N serviços, e o modelo C4 (componente → container → contexto) **emergindo de baixo pra cima**, sem arquiteto desenhando à mão. O caso de uso que justifica tudo é **análise de impacto**: "o que quebra se eu mudar o endpoint / o schema de evento / a tabela do serviço X", cruzando dezenas de serviços.

Achados empíricos desta sessão que balizam a decisão:

- O **Graphify** roda em Go/Kotlin/Java (tree-sitter AST, determinístico, sem LLM pra código), mas produz **só estrutura de código** (símbolos, calls, imports) — no payment service do demo deu 72 nós `type:code`, **cego a endpoint/evento** de primeira classe. Também **escreve `graphify-out/` dentro do repo-alvo** (mutação).
- O **Explorer** captura a **semântica de fronteira** (endpoint, producer, consumer) melhor que os graph engines, mas é grep-frágil por stack (colapsou no acme-tax: 0/153 endpoints).
- **Nenhum engine modela a fronteira cross-service nativamente** (HTTP outbound, publish/consume não são fato de primeira classe em Repowise nem Graphify).
- A **compressão de token é escala-dependente**: fraca em um flow intra-serviço (medido ~1.0–2.8x), decisiva no cross-service (N repos não cabem no context window — vira possível-vs-impossível).

## Decisão

### Modelo em quatro camadas

```
L0 micro    : cada serviço isolado → grafo verificado (ADR 0002/0003). SEM conexão cross-service.
L1 conexão  : casa nós de fronteira entre serviços por contrato canônico → arestas cross-service.
L2 macro-flow: encadeia micro-flows que compõem UM flow atravessando serviços.
L3+ C4      : container → contexto, projetados do grafo de sistema.
```

L0 está provado. L1/L2/L3 são o desenho deste ADR, ainda não construídos.

### Nó de fronteira

Fato de um serviço que aponta para fora dele: **chamada HTTP de saída**, **evento publicado** (producer), **evento consumido** (consumer). No grafo micro é uma **aresta pendurada** — o serviço fala com "algo" que o grafo dele não resolve.

### Join por contrato canônico

L1 casa nós de fronteira por identidade de contrato compartilhada. Há hierarquia de qualidade:

- **Tópico/fila = o join mais limpo.** O nome do tópico é identificador compartilhado e quase sempre canônico na empresa. Producer posta em `T`, N consumers ouvem `T` → casa por `T`.
- **HTTP = mais sujo.** Rota + host, frequentemente `${VAR}` ou service-discovery. Resolve-se para um **nome lógico** (serviço/rota), não endereço.

**Config/profile é fonte de primeira classe da conexão.** `application.yml`, clients HTTP, consumer groups, bindings SNS/SQS declaram o alvo concreto (host lógico, nome de tópico) e desambiguam o join que o código sozinho deixa ambíguo. Config é env-specific e cheia de placeholder — extrai-se o **nome lógico**, que é o join canônico; endereço real é runtime e fica de fora.

**Nota empírica (observação empírica, sessão de origem):** o join por nome de tópico da prosa **falha** no primeiro par real. O acme-tax documenta tópicos `crlv-provider-notification` / `order-notification`, mas o acme-crlv-provider publica em `acme-crlv-topic` (ARN via env `SNS_TOPIC`) e não tem listener interno nenhum. Nomes divergem entre times; o binding real é o ARN/URL do deploy. Consequência para L1: o join confiável resolve o **binding de deploy** (ARN de tópico, URL de client — o `application.yml` do acme-tax declara `PROVIDERCONTROLLER_API_URL` e `TAX_PROVIDER_ALT_URL`), não o nome documentado. A fronteira **HTTP-via-config mostrou-se mais confiável** que o match de nome de evento. Confirma na prática o risco central deste ADR: variância de nomeação é o problema, e a config de deploy é o desambiguador — não a prosa.

### Namespace de sistema: composição, não merge

L1 **não funde** os namespaces dos serviços (isso violaria a fronteira de dados). Cria um **namespace de sistema** que apenas **referencia** `(namespace, node_id)` de cada serviço. Cada endpoint/evento permanece no namespace do seu projeto; a aresta cross-service é um fato **novo**, na camada de cima. Conhecimento corporativo não é promovido; é composto.

### Classes de evidência — a honestidade da pilha

Cada camada que sobe, a evidência enfraquece. Isso é marcado, não escondido:

| Classe | Significado |
|---|---|
| `comprovado` | verificado no código na revisão pinada (L0) |
| `contract-matched` | inferência estática: contratos de fronteira batem (L1/L2) |
| `runtime-observed` | trace de runtime confirmou o fluxo (futuro) |

**Princípio: não precisa ser 100% perfeito.** O objetivo não é provar; é um mapa honesto sobre a confiança. Para análise de impacto, calibra-se para **recall alto** (não perder um impacto possível), tolerando **precisão menor** (falso-positivos que se confere na mão). Um impacto perdido é caro; um falso-positivo é só um check.

### Macro-flow = reconstrução de trace distribuído, estática

L2 encadeia micro-flows via nós de fronteira: o flow do serviço A termina publicando o evento `E`; o flow do serviço B começa consumindo `E` → A→B é continuação do **mesmo** macro-flow, mesmo tendo nomes diferentes em cada micro. Isso é reconstruir estaticamente o que Jaeger/Zipkin fazem em runtime.

Consequências disso, obrigatórias no design:
- **Fan-out:** um evento tem N consumidores → o macro-flow **ramifica**. É um **DAG**, não uma linha.
- É **`contract-matched`** (hipótese sobre hipótese) até um trace confirmar.

### Estratégia de engine: híbrida

```
código → Graphify (substrato estrutural determinístico, multi-linguagem, provenance por nó)
       → Explorer semântico EM CIMA da estrutura (endpoint/evento/consumer sobre AST, não grep de prosa)
       → Descobrir (verifica no git + canoniza + classes de evidência)
```

Cada um faz o que é bom: Graphify dá profundidade intra-serviço e cobre Go/Kotlin/Java; Explorer para de grepar prosa stack-específica e ganha assertividade/portabilidade raciocinando sobre estrutura; Descobrir prova. **Restrição:** o Graphify muta o alvo (escreve `graphify-out/`). Deve rodar **isolado** (worktree/cópia efêmera), ler o `graph.json`, e **nunca deixar artefato no repo-alvo** — a invariante de não-mutação do ADR 0003 continua valendo.

### Store obrigatório em escala

JSON gitignored serve ao protótipo (um grafo por vez). Em escala de empresa, L1 e L2 precisam de **N grafos consultáveis ao mesmo tempo** — o store deixa de ser opcional. Deve ser **graph-capable** (travessia + query de impacto): candidatos Neo4j, Postgres com recursivo, ou o SQLite/JSON do próprio Graphify. Decisão de tecnologia fica para ADR próprio; aqui fixa-se que o store passa a ser pré-requisito de L1/L2.

### Deploy na fronteira corporativa (VDI)

A pilha é portátil (Descobrir = Node built-in, zero dep; Graphify = pip; store = container) e instala-se **dentro** da VDI — a ferramenta vai até o código, não o contrário, respeitando o data boundary. Separação:
- **Offline/determinístico** (roda mesmo air-gapped): Graphify AST, Descobrir (git), verificação.
- **Precisa de LLM**: a camada semântica do Explorer e o enrichment do Graphify. Exige um **LLM aprovado dentro da fronteira** (gateway corporativo / IA da própria VM); LLM externo costuma ser bloqueado.

Três "vão/não vão" são **organizacionais**, não técnicos: (1) o IT permite instalar container/pip na VDI; (2) há LLM aprovado interno pra dirigir Explorer/Graphify; (3) a VDI persiste (senão, volume persistente ou rebuild por sessão).

### Payoff: análise de impacto

O grafo de sistema responde por query o que hoje é grep manual em dezenas de repos: quem chama esse endpoint, quem consome esse evento, quais macro-flows atravessam o nó que vou mudar. É o context-loader escalado para **raio de impacto** — para o humano entender antes de mexer e para a IA mexer com mais segurança.

## Consequências

**Positivas:**
- C4 verificado e emergente, derivado do código, não desenhado à mão; cada nível é projeção do grafo de sistema.
- Engines permanecem substituíveis atrás do Adapter (ADR 0002); a fronteira e a verificação são donas nossas, não do engine.
- A honestidade por classe de evidência torna o mapa útil sem fingir certeza — e a calibragem por recall serve exatamente a análise de impacto.
- Portabilidade permite operar dentro do data boundary corporativo (corporação via VDI).

**Negativas/riscos:**
- L1 e L2 são **inferência**; sem trace, o macro-flow é hipótese calibrada, não fato. Marcação de confiança é obrigatória sob pena de virar ficção confiante.
- Ambiguidade e variância de nomeação (mesma rota `POST /webhook`, tipos de evento nomeados por times diferentes) são o problema central em escala — dependem de canonicalização rígida e de config como desambiguador.
- Store e (possivelmente) LLM interno são novas dependências operacionais que não existem no protótipo.
- Rodar Graphify sem isolamento **muta o alvo** — exige disciplina de worktree/limpeza.

## Alternativas rejeitadas

- **`merge-graphs` do Graphify como stitching.** É união estrutural de grafos, não join semântico por contrato de fronteira; não infere quem-fala-com-quem. L1 continua sendo trabalho nosso.
- **Trocar Explorer por um graph engine.** Ganha profundidade intra-serviço, **perde a fronteira** (endpoint/evento). A fronteira é justamente o que L1/L2 precisam.
- **Exigir 100% de precisão.** Nunca ship; e para impacto, recall importa mais que precisão. Rejeitado em favor de classes de confiança.
- **Runtime tracing como pré-requisito de v1.** Não temos instrumentação garantida em todos os serviços. O estático + classes de evidência é o v1; `runtime-observed` é enriquecimento futuro.
- **Fundir namespaces num grafo global.** Viola a fronteira de dados; composição por referência preserva namespaces e permite conhecimento corporativo isolado.

## Evidência

Base empírica desta sessão: Graphify rodado no payment service do demo (72 nós, só estrutura de código, cego a fronteira; escreveu `graphify-out/` no alvo — mutação, limpa); Graphify declara suporte a Go/Kotlin/Java via tree-sitter; context-loader do demo provou L0 (66 nós verificados, resolução cirúrgica, diagrama navegável); teste de token mostrou compressão escala-dependente (~1.0–2.8x intra-serviço, decisiva cross-service). O modelo em camadas, o join por contrato canônico com config como desambiguador, as classes de evidência calibradas por recall e o alvo de análise de impacto são a decisão registrada aqui. **Prova fina do L1 (esta sessão):** 4 arestas cross-service verificadas entre `acme-tax` e `tax-provider-alt` pelo join config-binding + contrato de rota (`TAX_PROVIDER_ALT_URL` + `POST /private/debits/{state}/{debitType}/pay`, com nomes de param normalizados — cliente usa `{category}`, servidor `{debitType}`), e o macro-flow `acme-tax:pagamento-tributos → tax-provider-alt:post-pay-debit` emergindo da própria aresta — **L0→L1→L2 demonstrados em dado real** (artefato em `prototypes/descobrir-v1/output/l1-proof-*.json`). Resta a **automação** (extrator de outbound-call + route-matcher, chaining de L2) e o **store** — o trabalho que este ADR autoriza construir.
