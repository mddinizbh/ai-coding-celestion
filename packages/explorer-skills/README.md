# opencode-explorer

Instala as skills **Explorer** no [OpenCode](https://opencode.ai):

| Skill | Comando |
|--------|---------|
| explorer-l0 | `/explorer-l0` (alias `/descobrir`) |
| explorer-l1 | `/explorer-l1` (alias `/l1`) |
| explorer-l2 | `/explorer-l2` |
| explorer-query | `/explorer-query` |

## Install (usuário final)

```bash
# quando publicado no npm:
npx opencode-explorer@latest install
npx opencode-explorer setup          # Graphify pinado (uma vez)
npx opencode-explorer setup-status

# reinicie o OpenCode por completo
```

Ou global:

```bash
npm i -g opencode-explorer
opencode-explorer install
opencode-explorer setup
```

## Uso no OpenCode

```text
/explorer-l0
namespace: minha-empresa
logical-repo: meu-servico
```

(cwd = root git do serviço)

```text
/explorer-l1 stitch
namespace: minha-empresa
system-namespace: minha-empresa-system
repos: a=/path/a b=/path/b
```

```text
/explorer-query
system-namespace: minha-empresa-system
pergunta: como flui o pagamento?
```

## Dev (deste monorepo)

```bash
cd ai-coding-celestion
node packages/explorer-skills/bin/opencode-explorer.js install
node packages/explorer-skills/bin/opencode-explorer.js setup
```

## Publicar no npm

```bash
cd packages/explorer-skills
npm run sync-skills    # copia skills/ → packages/.../skills/
npm pack               # confere o tarball
npm publish --access public   # se o nome estiver livre / scoped
```

`prepack` já roda `sync-skills`.

## Desinstalar

```bash
npx opencode-explorer uninstall
```

Só remove symlinks/commands **owned** por este installer.

## Requisitos

- Node ≥ 20  
- `uv` no PATH (para `setup` do Graphify)  
- OpenCode que leia `~/.agents/skills` e `~/.config/opencode/commands`
