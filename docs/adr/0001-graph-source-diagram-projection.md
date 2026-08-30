---
status: accepted
---

# ADR 0001 — Project Knowledge Graph como fonte de verdade; html-diagram como projeção descartável

## Contexto

Durante o design do harness, o entendimento do fluxo dependia de discussões textuais longas antes de qualquer visualização existir. Quando o primeiro `html-diagram` foi criado, problemas de conectividade excessiva e de relações mal resolvidas só ficaram óbvios na renderização — evidência de que a visualização deveria entrar mais cedo, mas também de que ela era uma ferramenta de descoberta, não um registro de fatos.

Essa experiência levantou uma questão de governança: quando um agente ou o Marley edita o diagrama para propor uma solução, essa edição é conhecimento factual do projeto ou é especulação ainda não aprovada?

O Project Knowledge Graph acumula fatos verificados: serviços, contratos, dependências, jornadas, episódios e evidências com rastreabilidade para `kb://` e `repo://`. Um html-diagram é gerado a partir de um Context Slice, que é um subgrafo temporário carregado para uma Session específica. O diagrama é legível, navegável e útil para decisão, mas não tem identidade própria na Context Layer.

Se tratarmos edições no diagrama como mutações diretas do grafo, contaminamos conhecimento factual com especulação. Se o diagrama for regenerado sem rastrear o que foi proposto como overlay, perdemos a proposta sem registro.

## Decisão

O **Project Knowledge Graph é a fonte de verdade factual** do projeto. Um `html-diagram` é uma **projeção visual descartável** gerada a partir de um Context Slice; nunca é o original, nunca é canônico.

Mudanças propostas durante uma Session de Solution Design são **overlays**: anotações visuais sobre a projeção que representam o que ainda não aconteceu. Um overlay não modifica o grafo. O grafo só é atualizado depois que duas condições forem satisfeitas: aprovação do Decision Owner e verificação executável da implementação.

Essa separação preserva duas garantias:

1. O grafo reflete apenas o que foi construído e comprovado, não o que foi imaginado.
2. Diagramas podem ser regenerados a qualquer momento a partir do estado atual do grafo mais qualquer overlay pendente, sem perda de rastreabilidade.

## Consequências

**Positivas:**
- Agentes podem gerar e regenerar diagramas livremente sem risco de corromper o grafo factual.
- Overlays são rastreáveis como parte do Solution Council output, separados de Curated Knowledge.
- Knowledge Freshness do grafo não é afetada por especulação visual.

**Negativas/riscos:**
- Requer que ferramentas de geração de diagrama conheçam a distinção entre fato e overlay ao renderizar.
- Overlays sem aprovação acumulados por muito tempo perdem contexto se o grafo evoluir sob eles.

## Alternativa rejeitada

**Edições no diagrama como mutações diretas do grafo.** Nessa abordagem, arrastar um nó, adicionar uma aresta ou renomear um serviço no `html-diagram` atualizaria o Knowledge Record correspondente imediatamente.

Rejeitada porque:
- Confunde o ato de visualizar e explorar com o ato de decidir e comprovar.
- Remove a separação entre especulação e fato, invalidando a rastreabilidade `kb://`/`repo://`.
- Permite que um diagrama gerado em uma Session modifique silenciosamente o baseline de outra Session.

## Evidência

A lição `0001-visualize-before-decomposing` documenta o caso concreto: o `workflow.html` só ficou legível quando conexões transversais passaram a ser reveladas por lentes. A utilidade do diagrama era de descoberta, não de registro. Usar a visualização como ferramenta de decisão sem separá-la do grafo factual foi a causa do ruído inicial no design.

Referência: `.claude/handoff/harness-design/docs/lessons/0001-visualize-before-decomposing.md`
