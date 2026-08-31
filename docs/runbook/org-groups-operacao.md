# Runbook — ZapFlow Grupo (ADR-199): rebuild da constraint de email (F0c-1)

Operação do passo de MAIOR risco do ZapFlow Grupo: converter `users.email` de
`UNIQUE(email)` (global) para `UNIQUE(organization_id, email)`, permitindo que um
mesmo humano tenha linha de `users` em N orgs. Este runbook cobre **ensaio,
promoção e rollback**. Código: `src/server/migrations/usersEmailConstraint.ts`;
teste: `npm run test:users-email-rebuild`.

## Garantias de integridade (por que nenhum dado se perde)

1. **Snapshot antes de tudo** — `VACUUM INTO` grava uma cópia física do banco +
   `PRAGMA integrity_check`. Sem snapshot válido, o rebuild **aborta**.
2. **Transação única atômica** — create/copy/validate/drop/rename num só
   `db.transaction`. Qualquer erro (ou crash) → **rollback** → `users` intacta (ACID).
3. **Cópia dinâmica de TODAS as colunas** — lê `PRAGMA table_info` e copia toda
   coluna existente (nunca lista hardcoded). Zero risco de "esquecer coluna".
4. **Validação antes do commit** — `COUNT(*)` origem == destino; senão aborta.
   Pós: `foreign_key_check` + `integrity_check`.
5. **Idempotente** — se já está org-scoped, é no-op. Seguro rodar 2×.
6. **Gated por flag** — só roda quando `FEATURE_ORG_GROUPS` está ligada. Mergear o
   PR **não** altera o schema de produção.

Risco residual: **operacional, não de dados** — numa tabela `users` grande o rebuild
segura um lock por alguns segundos (login indisponível durante a cópia). O ensaio
abaixo mede esse tempo.

## Como o rebuild dispara

No boot (`db.ts` → `initDb`), ao final das migrations, **se e somente se**
`FEATURE_ORG_GROUPS` ∈ {1,true,yes,on}, chama `migrateUsersEmailConstraint(db)`.
Idempotente: nas próximas subidas detecta `org` e pula. Sem a flag, nunca roda.

## 1. Ensaio em staging (obrigatório antes de produção)

O comportamento em produção depende do VOLUME real da tabela, então ensaie com uma
cópia real:

1. Copie o banco de produção para o staging (arquivo `zappflow.db` do volume
   persistente — `DATA_DIR`). Nunca rode o ensaio contra o arquivo de produção.
2. `PRAGMA integrity_check` na cópia — confirme `ok` antes de começar.
3. Anote `SELECT COUNT(*) FROM users;` (contagem de referência).
4. Suba a instância de staging apontando `DATA_DIR` para a cópia, com
   `FEATURE_ORG_GROUPS=1`. No log procure a linha:
   `[DB][ADR-199] users email-constraint rebuild OK — linhas N→N, colunas C, integridade ok, fk ok, backup <path>`.
5. **Meça o tempo** entre o início do boot e essa linha (tempo de lock ≈ duração do
   rebuild). Se for além do aceitável pro seu SLA de login, agende janela de manutenção.
6. Verifique (§4). Só então libere pra produção.

## 2. Promoção em produção (canary)

1. **Backup manual** do volume (além do snapshot automático do rebuild).
   `PRAGMA integrity_check` = `ok`.
2. Ligue `FEATURE_ORG_GROUPS=1` **primeiro na instância/conta piloto** (Toulon) e
   reinicie. O rebuild roda uma vez no boot; confirme a linha de log OK e o §4.
3. Observe login/erros por um período. Só então amplie o alcance da flag.
4. O snapshot automático fica em `DATA_DIR/users-email-rebuild-backup-<ts>.sqlite` —
   guarde-o até validar; pode remover depois.

## 3. Rollback

- **Desligar a flag NÃO reverte o schema** (o rebuild já aconteceu; a nova constraint
  é um superconjunto seguro — mesmo email por org). Na prática, não é preciso reverter:
  a constraint org-scoped aceita tudo que a global aceitava.
- Se ainda assim precisar reverter o schema: pare a app e **restaure** o snapshot
  automático (ou o backup manual) por cima do `zappflow.db`. Confirme
  `PRAGMA integrity_check` = `ok` e suba com a flag **desligada**.
- Se o rebuild abortar no boot (log `ABORTADO (users intacta)`): a tabela não foi
  tocada (rollback da transação). Investigue a causa no log; o login segue no schema
  legado. Não há perda.

## 4. Verificação pós-rebuild

```sql
-- 1) contagem bate com a referência
SELECT COUNT(*) FROM users;
-- 2) constraint nova ativa (deve estar no DDL)
SELECT sql FROM sqlite_master WHERE type='table' AND name='users';  -- contém UNIQUE(organization_id, email)
-- 3) integridade
PRAGMA integrity_check;      -- ok
PRAGMA foreign_key_check;    -- (vazio)
-- 4) nenhum email duplicado DENTRO da mesma org (invariante da nova constraint)
SELECT organization_id, email, COUNT(*) c FROM users
  WHERE email IS NOT NULL GROUP BY organization_id, email HAVING c > 1;  -- (vazio)
```

Login e criação de conta devem funcionar normalmente (a resolução de credencial já
passa pela identidade desde a F0b — ver `AccountIdentityService`).

## Troca de operação (F0c-2)

Com o schema relaxado, a troca de operação também vive atrás de `FEATURE_ORG_GROUPS`
(sem a flag as rotas respondem 404 — feature invisível, single-org intacto):

- `GET /api/auth/organizations` — operações que a sessão atual pode abrir (o front só
  mostra o seletor quando há >1). Membership = ter linha de `users` ativa ligada à
  identidade (RN-GRP-01), nunca o grupo/holding.
- `POST /api/auth/switch-org { orgId }` — valida o membership (`resolveSwitch`) e
  **reassina o JWT** com os claims da org alvo + reemite o cookie httpOnly coerente
  (RN-GRP-07). Org sem membership → 403 + `SWITCH_ORG_DENIED` no audit; sucesso →
  `SWITCH_ORG`. O `orgId` do cliente nunca é autoridade sem a checagem.

Segurança: revogar o acesso a uma org = remover/bloquear a linha de `users` daquela org
(+ bump de `security_version`); a org some de `GET /organizations` e o `switch-org` passa
a recusá-la na hora.
