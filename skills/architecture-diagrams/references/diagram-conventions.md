# Convenções dos diagramas

Referência das convenções visuais e de dados. Os agentes de render **clonam a estrutura** de
`gold-class.html` (diagrama de classes) e `gold-er.html` (ER) e trocam só o conteúdo. Este doc é o
contrato explícito quando clonar não basta. O gate é `assets/lint.py` (roda em loop até `OK`).

## Anatomia de uma página (todas iguais)

```html
<head>
  <script>…apply-before-paint do tema…</script>               <!-- dark mode antes de pintar -->
  <link rel="stylesheet" href="../../_assets/diagram.css">     <!-- engine visual compartilhada -->
</head>
<body>
  <div class="bar"> h1 + .sub · .chips (data-flow) · #legendBtn · <a class="navlink">← pai</a> · #themeToggle </div>
  <div class="legend" id="legend"> … </div>                    <!-- painel recolhível -->
  <div class="stage" id="stage">
    <svg viewBox="0 0 W H" preserveAspectRatio="xMidYMid meet">
      <defs> markers a-mut / a-clay </defs>
      <g class="zone">…lanes/grupos…</g>
      <path class="edge" id="e-…" d="…"/>  <text class="elbl" id="l-…">…</text>
      <g class="node …" data-k="KEY"><rect…/><text class="t">…</text><text class="m">…</text></g>
    </svg>
    <div class="src">procedência</div>
    <div class="card" id="flowcap">…</div>
    <div class="card" id="detail">…</div>
  </div>
  <script> window.DETAIL={…}; window.FLOWS={…}; window.E2L={…}; </script>
  <script src="../../_assets/diagram.js"></script>             <!-- engine: tema, chips, detalhe, legenda, Home -->
</body>
```

`diagram.js` injeta o botão **⌂ Home** automaticamente (antes do primeiro `a.navlink`). Logo todo micro
ganha Home de graça; só precisa do `<a class="navlink">` do **pai** (um nível acima).

## Tipos de nó (classes → cor semântica, em `diagram.css`)

| classe | uso | cor |
|---|---|---|
| `.node.gate` | gateway / borda (nginx, API gateway) | clay |
| `.node.live` | serviço no ar | verde (olive) |
| `.node.do` | processo / job / worker / agente | olive |
| `.node.store` | data store / tabela / chave | bege (surface2) |
| `.node.bus` | event bus / tópico Kafka | azul |
| `.node.port` | interface / port (hexagonal) | azul |
| `.node.domain` | record / sealed / value object | violeta |
| `.node.ext` | externo / fonte (tracejado) | tracejado |
| `.node.wip` | scaffold / parcial | dourado |
| `.node.off` | desativado / roadmap (faded) | esmaecido |

Status dot opcional: `<circle class="dot ok|wip|off" …>`. Texto: `.t` (título 14px), `.m` (mono 10.5),
`.k` (clay caps 10), `.n` (clay mono 10.5), `.pk` (clay bold — PK no ER), `.th` (header de tabela 13).

## Layout por tipo de diagrama (lanes)

- **Classe (hexagonal):** `Adapter IN | Port IN | Application | Port OUT | Adapter OUT | Externo` +
  banda `Domain` embaixo. Aresta `implements` = `.edge.impl` (tracejada). Layered (MVC) sem hexágono:
  `Web | Service | Repository | Domain/Entity | DB`.
- **Python/módulos:** lanes por pacote (`CLI | common | ingestor | normalizer subpacotes | externo`).
- **React/componentes:** `pages | components | lib/auth | lib/api | modules | externo`.
- **ER por schema:** grid de cards de tabela agrupados por área; cada card = `.th` (nome) + `.pk` (🔑) +
  ~5 campos `.m` + `.n` ("…+N campos"). Arestas = joins (FK reais ou joins lógicos documentados, rotulados
  pela chave). **Todos os campos** vão no clique (DETAIL.fields), não no card.
- **Contratos (Kafka/Redis):** `Produtores/Escritores | Tópicos/Chaves (com payload/estrutura) | Consumidores/Leitores`.
- **Deploy:** `Origem/CI | control plane (compose/nginx/CI) | runtime/VPS`.

## Formato dos dados (globais da página)

```js
window.DETAIL = {
  "KEY": { t:"Título", m:"meta curta", b:"<b>html</b> do detalhe" },          // classe/serviço
  "KEY": { t:"tabela", m:"meta", note:"contexto", fields:[                     // ER / contrato
     { n:"campo", ty:"tipo curto", nn:true, pk:true, fk:true, d:"descrição" }  // nn=nullable
  ]},
};
window.FLOWS = { "chipKey": { name:"Nome do fluxo", edges:["e-…"], nodes:["KEY"], steps:["<b>html</b>"] } };
window.E2L   = { "e-edgeId":"l-labelId" };   // acende o rótulo junto da aresta no fluxo
```
- Tipos curtos no ER: `text/int/num/int2/int8/bool/timestamptz/geometry/jsonb/date/char/uuid/HLL/event`.
- Reutilize consts pra campos repetidos (ex.: `const V={n:"version_id",ty:"int",d:"…"}`).

## Regras anti-overflow (o que o linter cobra)

- Linha `.m` em lane estreita: **≤ ~26 caracteres**. Nome de classe longo em lane estreita: `style="font-size:11px"`.
- Card mostra PK + ~5 campos + "…+N"; o resto vai no clique.
- **Toda ponta de aresta encosta (≤24px) na borda de um nó real.** Sem setas soltas.
- **Aresta não passa por dentro de card que não é ponta dela** — roteie pelos **corredores** (gap entre
  lanes / espaço entre cards), com pontos de controle no vazio. Arestas longas que pulam uma lane viajam
  pelo gap, nunca reto sobre os cards do meio.
- Markers via CSS var (nunca hex no SVG) pra seguir o tema.

## Checks do `lint.py` (o gate — `python3 _assets/lint.py <arquivo>` até "OK")

1. `[overflow]` texto estoura a caixa do nó · `[fora]` texto fora da caixa
2. `[colisão]` linhas de texto do mesmo nó muito próximas
3. `[overlap]` dois nós se sobrepõem
4. `[viewBox]` rect (nó/zona) fora dos limites do viewBox
5. `[seta-solta]` ponta de aresta sem nó perto · `[seta-atravessa]` aresta passa por dentro de card alheio
6. estrutura: todo edge/nó de `FLOWS` existe · todo `E2L` aponta label existente · todo `data-k` tem `DETAIL` · HTML parseia

⚠️ Cuidado: se a página **não usa as classes** `.node`/`.edge`/`.t`/`.m`, o linter checa 0 elementos e dá
"OK" falso. **Sempre clone a estrutura do gold** pra o gate ter o que checar.

## Navegação

- **⌂ Home** → `index.html`. O `diagram.js` **injeta** o Home assumindo profundidade-2 (`../../index.html`),
  certo para os micros em `micro/x/`. **Macros e hubs na raiz** (`<out>/`) precisam de Home **inline** com
  `href="index.html"` e o atributo **`data-home`** (o JS pula a injeção se já existe `a.navlink[data-home]`),
  senão o caminho `../../` quebra. Páginas mais fundas que 2 níveis: idem, Home inline com o caminho certo.
- **← pai** (um nível acima): micro de classe/contrato/deploy → macro; ER → hub do banco → macro.
- **Drill-down `↳`** nos macros: nó de serviço → seu micro de classe; nó de store → hub do banco → ER.
  É um `<a class="drill" href="…"><circle/><text>↳</text></a>` no canto do nó (não conflita com o clique
  de detalhe, que é no `.node`).
- **Hub `index.html`:** seções por trilha (Macro · Serviços · Dados · Infra), cards com link.
