# Stack Local de Desenvolvimento (Docker Compose)

> **UAI-34** — infraestrutura apenas. Postgres para journal (runs/challenges) e MongoDB para grafo aceito + memória de agentes.  
> SQLite continua sendo o default quando o stack está parado.  
> Próximas issues (UAI-35/UAI-37) farão a integração de clientes.

## Pré-requisitos
- Docker + Docker Compose v2+ (testado com v5.1.0)
- Portas 5432 e 27017 livres na máquina local (ou sobrescreva via env vars)

## Iniciar o stack
```bash
docker compose up -d --wait
```
- `--wait` aguarda os healthchecks passarem.
- Ambos os serviços sobem com volumes persistentes (escopo do projeto Compose, sem colisão entre worktrees/clones).

### Sobrescrever portas host (evita colisão)
```bash
POSTGRES_HOST_PORT=5433 MONGO_HOST_PORT=27018 docker compose up -d --wait
```
- Defaults: 5432 (Postgres), 27017 (Mongo).
- Use portas diferentes em cada clone/worktree.

## Verificar status
```bash
docker compose ps
docker compose logs --tail=20
```
Healthchecks:
- Postgres: `pg_isready`
- MongoDB: `mongosh ... ping`

## Valores de conexão (desenvolvimento)
As portas host são parametrizadas (veja "Sobrescrever portas host").

**Postgres (journal):**
- Host: localhost:${POSTGRES_HOST_PORT:-5432}
- DB: dev_journal
- User: dev_user
- Password: dev_password
- String exemplo (default): `postgres://dev_user:dev_password@localhost:5432/dev_journal`
- String exemplo (override 5433): `postgres://dev_user:dev_password@localhost:5433/dev_journal`

**MongoDB (grafo/memória):**
- Host: localhost:${MONGO_HOST_PORT:-27017}
- User: dev_mongo_user
- Password: dev_mongo_pass
- String exemplo (default): `mongodb://dev_mongo_user:dev_mongo_pass@localhost:27017/?authSource=admin`
- String exemplo (override 27018): `mongodb://dev_mongo_user:dev_mongo_pass@localhost:27018/?authSource=admin`

> **Atenção**: credenciais são apenas para desenvolvimento local. Não use em produção, não commite senhas reais.

## Parar o stack
```bash
docker compose down
```
- Containers param, mas volumes permanecem (dados preservados).

## Reset completo (apagar volumes)
```bash
docker compose down -v
```
- Remove containers + volumes (escopo do projeto Compose). Use com cuidado.

## Notas importantes
- Quando o stack está parado, o sistema continua usando SQLite local (`~/.local/share/descobrir/...`).
- Este compose é só para dev local — sem TLS, auth extra, Oracle, nem orquestração de produção.
- Imagens fixadas em major versions: `postgres:16-alpine`, `mongo:7`.
- Healthchecks nativos de cada imagem + restart `unless-stopped` para conveniência em dev.
- Sem nomes de empresa no código ou configs.

## Validação
- `docker compose config --quiet` → OK
- `docker compose up -d --wait` → serviços saudáveis + healthchecks OK; `docker compose down -v` → zero containers/volumes residuais (verificado)
- Sem `container_name` fixos nem `name:` globais em volumes (isolamento entre worktrees/clones)

Consulte também: `docs/plans/store-compartilhado.md`
