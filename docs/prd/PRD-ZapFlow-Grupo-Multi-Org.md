# PRD — ZapFlow Grupo (Multi-Org / Multi-Marca)

**Status:** Draft para revisão de engenharia
**Autor:** Emerson (TesseractAuto) + análise técnica
**Sistema:** ZapFlow (produção) — repositório `exaforgeStudio`
**Tipo de mudança:** Aditiva, atrás de feature flag, zero-regressão obrigatória
**Última atualização:** 2026-08-31

---

## 1. Contexto e problema

Um cliente é franqueado de **duas franqueadoras distintas** (Toulon e Democrata), **CNPJs separados**, e quer gerenciar as duas operações a partir de **um único login no ZapFlow**, com **paridade total de serviços** por marca (atendimento, funil, vendas, recuperação, fiscal, ERP — tudo que o plano entrega). Existem clientes potenciais com **3+ franquias de marcas diferentes** na mesma situação.

### Realidade da arquitetura atual (verificada no código)

- `organization_id` é a fronteira de tenant. Está carimbado em praticamente toda tabela; todo service consulta com `WHERE organization_id = ?`.
- **Um usuário pertence a exatamente uma org.** `users.organization_id` é coluna única `NOT NULL`; `users.email` é `UNIQUE` global. Não existe tabela de membership, grupo, holding, nem troca de org.
- O login (`src/server/routes/auth.ts`) assina um JWT com os claims `{ userId, organizationId, role, role_profile_id, email, name, platform_role, sv }`.
- O middleware (`src/server/middleware/auth.ts`) faz `req.organizationId = decoded.organizationId`. **Todo o app deriva o tenant desse único claim.**
- Já existe **multi-loja dentro de uma org**: `retail_stores` (cada loja com `whatsapp_identifier`, `code` de filial, gerente, margem) + `user_stores` (escopo por usuário, imposto no servidor — `RetailStoreScopeService`).
- `channels` é `UNIQUE(organization_id, channel_id, identifier)` → uma org já suporta múltiplos números de WhatsApp.
- Existe `organization_settings` (status/onboarding por org) e `users.security_version` (`sv`) usado para invalidar sessões.

### Consequência de projeto

Como a org da sessão é **apenas um campo do token**, "trocar de operação" é **re-emitir o JWT com outro `organizationId`** — o restante do sistema, todo org-scoped, continua funcionando **sem alteração**. Isso é a espinha dorsal deste PRD.

---

## 2. Objetivos e não-objetivos

### Objetivos
1. Um login (identidade) pode pertencer a **N organizações** e alternar entre elas.
2. Cada marca/operação permanece uma **org completa e isolada** (dados, catálogo, fiscal, ERP, WhatsApp, plano próprios).
3. Provisionar uma nova operação no grupo com **paridade de plano** de forma repetível.
4. Visão **consolidada** (read-only) do grupo, por agregação, com filtro por marca.
5. **Zero regressão** para os usuários single-org existentes.

### Não-objetivos (fora de escopo desta entrega)
- Compartilhar catálogo, contatos, fiscal ou estoque entre orgs. **Proibido** (CNPJs separados exigem isolamento).
- Reescrever qualquer service org-scoped para "entender grupo".
- Billing automatizado de grupo em produção (ver §11 — bloqueado por gateway de pagamento).
- Federação de permissões complexa entre orgs além do necessário para o MVP.

---

## 3. Invariante de isolamento (regra sagrada)

> **A consolidação de dados de várias orgs é feita SOMENTE por _fan-out_: chamar o mesmo service org-scoped, uma vez por org, cada chamada com um único `organization_id`, e somar/mesclar os resultados na camada de consolidação. É PROIBIDO adicionar `groupId`/`group_id` a qualquer service org-scoped, e é PROIBIDO qualquer query que leia mais de uma org numa única instrução SQL.**

Violar isso vaza dado de uma marca na tela da outra e fere o isolamento contratual/fiscal. Esta regra não é uma recomendação — é uma **invariante enforced** (ver §9). Toda dúvida se resolve a favor do isolamento.

---

## 4. Arquitetura da solução

Três peças novas, **todas aditivas**. A org continua sendo a unidade de tudo.

### 4.1 Camada de identidade
Hoje `users.email UNIQUE` + senha em `users` implica "um humano = uma linha = uma org". Introduz-se:

- `account_identities` — a **credencial de login** (email + password_hash + MFA) passa a viver aqui.
- `users.identity_id` (FK nullable) — liga as linhas de `users` que são o mesmo humano em orgs diferentes.
- Cada org **mantém sua própria linha em `users`** (role, permissões, escopo de loja, avatar permanecem por org, intactos).

O login autentica a **identidade**, resolve as orgs em que ela tem linha de `users`, e emite o JWT para a org ativa — com os mesmos claims de hoje, derivados da linha de `users` daquela org. **Nada a jusante muda.**

### 4.2 Grupo (holding)
- `org_groups (id, name, owner_identity_id, ...)`.
- `org_group_members (group_id, organization_id, ...)` — quais operações/marcas compõem o grupo.

### 4.3 Troca de org
- `POST /api/auth/switch-org { orgId }`: valida que a identidade tem membership naquela org e **re-assina o JWT** com o novo `organizationId`. Registra no audit log.

### 4.4 Consolidação (fan-out)
- `GroupConsolidationService` — **único** ponto autorizado a iterar orgs. Para cada org do grupo, chama os snapshots já existentes (`ExecutiveBusinessSnapshotService`, `BusinessSnapshotV2Service`, `RetailDashboardService`), cada um com um `organization_id`, e agrega. Read-only. Filtro por marca. **Nunca** SQL cross-org.

---

## 5. Modelo de dados (proposto — revisar com o time)

Migrations **aditivas e idempotentes**, seguindo o padrão já usado em `db.ts` (`CREATE TABLE IF NOT EXISTS`, `try { ALTER TABLE ... ADD COLUMN } catch {}`).

```
-- Identidade de login (credencial acima de users)
CREATE TABLE IF NOT EXISTS account_identities (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  mfa_secret    TEXT,
  status        TEXT DEFAULT 'active',
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Vínculo humano ↔ linha de users por org
ALTER TABLE users ADD COLUMN identity_id TEXT;  -- via try/catch idempotente
CREATE INDEX IF NOT EXISTS idx_users_identity ON users (identity_id);

-- Grupo (holding) e seus membros
CREATE TABLE IF NOT EXISTS org_groups (
  id                TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  owner_identity_id TEXT NOT NULL,
  created_at        DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS org_group_members (
  id              TEXT PRIMARY KEY,
  group_id        TEXT NOT NULL,
  organization_id TEXT NOT NULL,
  added_by        TEXT,
  added_at        DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(group_id, organization_id)
);
```

### 5.1 O ponto mais perigoso da migração: relaxar `users.email UNIQUE`
Para o mesmo email ter linha de `users` em duas orgs, a constraint `UNIQUE(email)` precisa virar `UNIQUE(organization_id, email)`. Em **SQLite** (better-sqlite3) **não se remove uma constraint de coluna com `ALTER`** — exige o procedimento de rebuild de tabela (criar nova, copiar, trocar). Isso é a operação de maior risco do projeto. Procedimento obrigatório em §7.4.

---

## 6. Fases

### Fase 0 — Fundação: identidade + grupo + switch
**É o único ponto que toca autenticação.** Dark-launch atrás de flag `FEATURE_ORG_GROUPS`.

**Escopo**
- Tabelas de §5; rebuild da constraint de email (§7.4).
- Login autentica por identidade; backfill: para cada `users` existente, criar/ligar uma `account_identity` (1:1) — migração de dados idempotente, reversível.
- `POST /api/auth/switch-org`.
- Front: seletor de org **só aparece quando a identidade tem >1 membership**; caso contrário, UI idêntica à atual.
- MFA (`src/server/routes/mfa.ts`) passa a recomparar senha contra a identidade, não contra `users` (ver §8).

**Critérios de aceite**
- Usuário single-org loga **exatamente** como antes (mesmos claims, mesmo comportamento). Provado por teste de regressão.
- Identidade com 2 memberships loga, vê seletor, alterna e cada org carrega seus próprios dados.
- `switch-org` **rejeita** org sem membership (403) e registra tentativa no audit log.
- Revogar um membership + bump de `security_version` invalida a sessão ativa naquela org.

**Riscos e rollback**: ver §7. Rollback = desligar `FEATURE_ORG_GROUPS` (login volta ao caminho legado) + snapshot de banco pré-rebuild.

---

### Fase 1 — Provisionamento "Adicionar operação ao grupo"
**Escopo**
- Wizard que, para uma nova marca: cria a org + `organization_settings`; **seeda o plano idêntico** reutilizando `PlanService` / `EntitlementService` / `ModuleService` / `VerticalBlueprintService.assignToOrganization` / `BlueprintSeeder`; conecta o **WhatsApp** da marca (nova instância/canal); conecta o **ERP/fiscal** daquele CNPJ (perfil Alterdata/fiscal próprio).
- Vincula a org ao `org_group` e cria a linha de `users` do dono ligada à mesma identidade.

**Critérios de aceite**
- Onboardar Toulon e Democrata do cliente como 2 orgs no grupo dele, cada uma com o mesmo conjunto de features do plano.
- Catálogo, contatos, fiscal e estoque **não** cruzam entre as orgs (teste de isolamento, §9.4).
- Provisionar é idempotente: reexecutar não duplica org nem canal.

**Cliente resolvido ao fim desta fase.**

---

### Fase 2 — Visão consolidada do grupo
**Escopo**
- `GroupConsolidationService` (fan-out) + endpoints read-only de grupo.
- Dashboard de grupo com totais e **filtro por marca/operação**, reusando os snapshots existentes por org.
- Cache por org (padrão `RetailAnalyticsCache`) + timeout por chamada + **resultados parciais** quando uma org falha (degradação graciosa, nunca erro global).

**Critérios de aceite**
- Consolidado = soma verificável das orgs individuais (reconciliação numérica em teste).
- Nenhuma query da consolidação lê mais de uma org por instrução (auditado pelo lint de §9.1).
- Uma org lenta/indisponível não derruba o dashboard; ela aparece como "parcial".

**É o diferencial vendável para redes (3+ franquias).**

---

### Fase 3 — Billing de grupo
**Bloqueada** até o gateway de pagamento processar assinatura real (ver §11). Até lá, contrato multi-operação cobrado manualmente. Escopo desta fase será detalhado quando o bloqueio for resolvido.

---

## 7. Cuidados de engenharia sênior (produção, zero-quebra)

### 7.1 Tudo aditivo e atrás de flag
Nenhuma coluna removida, nenhum contrato de API quebrado. `FEATURE_ORG_GROUPS` controla identidade+switch; o caminho legado permanece intacto e é o default até a promoção.

### 7.2 Zero-regressão como critério bloqueante
Seguir o padrão que o próprio código já adota (ex.: rollout do cookie httpOnly em `sessionCookie.ts`, descrito como "aditivo e 0-regressão"). O caminho single-org **não pode** mudar de comportamento. Isso é validado por suíte de regressão de auth antes de qualquer merge.

### 7.3 Backup obrigatório antes de migração de schema
Rodar `BackupService` (ou `VACUUM INTO` para snapshot físico) **imediatamente antes** do rebuild de tabela. Guardar o snapshot com verificação de integridade (`PRAGMA integrity_check`).

### 7.4 Procedimento do rebuild de `users` (constraint de email)
1. Backup + `PRAGMA integrity_check` (abortar se não `ok`).
2. Em transação única: `CREATE TABLE users_new (...)` com `UNIQUE(organization_id, email)` e demais colunas idênticas (incluindo `identity_id`).
3. `INSERT INTO users_new SELECT ... FROM users`.
4. Validar `COUNT(*)` origem == destino e conferir FKs lógicas dependentes.
5. `DROP TABLE users` → `ALTER TABLE users_new RENAME TO users` → recriar índices/triggers.
6. `PRAGMA foreign_key_check` + `integrity_check`.
7. Só então habilitar a flag. Se qualquer passo falhar, rollback da transação + restore do snapshot.

Executar primeiro em staging com cópia real de produção; medir tempo de rebuild pelo tamanho atual da tabela; se exigir janela de manutenção, agendar.

### 7.5 Canary na própria conta do cliente
Promover a flag primeiro para a conta do franqueado piloto (Toulon), observar, depois ampliar. Nunca ligar globalmente de uma vez.

### 7.6 Migração de dados reversível
O backfill identidade↔users deve ser idempotente e ter script de reversão (desvincular `identity_id`, manter `users` como estava). Testar o rollback, não só o roll-forward.

### 7.7 Observabilidade e auditoria
Registrar via `logAuthEvent` (já existente): `SWITCH_ORG`, `ORG_GROUP_MEMBER_ADDED/REMOVED`, `IDENTITY_CREATED`, provisionamento de operação. Métricas: latência do fan-out por org, taxa de resultado parcial, tentativas de switch negadas.

---

## 8. Segurança

- **Raio de explosão = auth.** Qualquer PR que toque login/identidade/switch exige revisão de 2 pessoas e passagem obrigatória na suíte de isolamento e de regressão de auth.
- **MFA:** `mfa.ts` recompara `password_hash`. Ao mover a credencial para `account_identities`, apontar essa recomparação para a identidade. Não deixar caminho órfão validando contra `users`.
- **CSRF/cookie:** o `switch-org` muda estado de sessão; herda as defesas já existentes (`SameSite=Strict` + verificação de mesma origem em `sessionCookie.ts`). Confirmar que o endpoint está sob o mesmo guard.
- **Autorização do switch:** membership é a **única** fonte de verdade. Nunca confiar em `orgId` vindo do cliente sem checar `org_group_members`/`users.identity_id`.
- **Invalidação:** revogar acesso a uma org = remover a linha de `users`/membership + bump de `security_version` para derrubar sessões vivas.
- **Isolamento no switch:** ao re-emitir o JWT, **descartar** qualquer cache/estado de request anterior atrelado à org antiga.

---

## 9. Como GARANTIR o invariante de isolamento (§3) — enforcement em camadas

Não basta documentar. Camadas independentes, cada uma capaz de barrar a violação:

### 9.1 Gate de CI (lint) — barra o merge
Regra automatizada (ESLint custom ou check por script) que **falha o build** se qualquer arquivo em `src/server/**Service.ts`, **exceto** a whitelist `GroupConsolidationService`, referenciar `groupId`, `group_id`, `org_group` ou `organization_id IN (`. A whitelist é explícita e revisada. Nenhum service org-scoped pode conhecer o conceito de grupo.

### 9.2 Tipos "branded"
`OrgId` e `GroupId` como tipos distintos (branded). Services org-scoped aceitam **`OrgId` (singular)**, nunca `OrgId[]` nem `GroupId`. `GroupId` só existe na camada de consolidação. O compilador impede passar um grupo onde se espera uma org.

### 9.3 Choke point único
`GroupConsolidationService` é o **único** módulo autorizado a iterar orgs. Ele não tem acesso a SQL próprio de negócio — só orquestra chamadas aos services existentes, uma org por vez. Documentado em ADR e no cabeçalho do arquivo.

### 9.4 Teste de isolamento (obrigatório, roda em CI)
Semeia 2 orgs (A e B) com dados distintos e afirma:
- Todo endpoint org-scoped acessado no contexto de A **nunca** retorna linha de B.
- O consolidado de grupo é **exatamente** a soma de A + B (reconciliação).
- `switch-org` para org sem membership → 403.
- Após switch de A para B, nenhum dado de A vaza na resposta de B.
Este teste é bloqueante: falhou, não mergeia.

### 9.5 Assert em modo dev
Wrapper opcional de `db.prepare` para tabelas tenant que, em desenvolvimento/teste, afirma que todo statement de leitura tenant tem `organization_id` no `WHERE` e um único valor ligado. Não vai para o hot path de produção.

### 9.6 Revisão de código
Checklist de PR com item explícito: "Nenhum service passou a receber grupo/lista de orgs? Consolidação é fan-out?". ADR referenciado no template de PR.

---

## 10. Estratégia de testes

- **Regressão de auth (single-org):** prova comportamento idêntico ao atual com a flag ligada e desligada.
- **Isolamento (§9.4):** bloqueante.
- **Migração:** testar rebuild de `users` em cópia real de produção; validar contagem, FKs, integridade; testar rollback.
- **Provisionamento:** idempotência (reexecução não duplica), paridade de plano (features iguais às do plano de referência).
- **Consolidação:** reconciliação numérica + degradação parcial (org indisponível).
- **Segurança:** switch não autorizado, invalidação por `security_version`, MFA apontando para identidade.
- **Carga:** fan-out com N orgs (medir p95 do dashboard de grupo; validar cache e timeout).

---

## 11. Dependência/bloqueio comercial: gateway de pagamento

Achado prévio a **confirmar no estado atual**: o gateway ASAAS existe apenas de forma **mockada**, sem processar assinatura real em produção (`AsaasService`). Antes, 1 cliente = 1 org = 1 assinatura. Com grupo, **1 cliente = N orgs**, e o billing precisa **medir N operações**. Enquanto o gateway não for real:
- **Não** vender o tier de grupo de forma automatizada.
- Cobrar contrato multi-operação manualmente.
- Fase 3 permanece bloqueada.

Risco a evitar: "um login para N orgs" virar "N orgs rodando sem cobrança". Métrica de proteção: contagem de orgs ativas por grupo vs. operações contratadas.

---

## 12. Custo operacional (escala linear)

Cada org = 1 instância/canal de WhatsApp (Evolution) + 1 conexão de ERP + 1 perfil fiscal próprio. N orgs escalam infra e onboarding **linearmente**. O wizard da Fase 1 precisa automatizar o provisionamento; sem isso, um franqueado de 5 marcas vira pesadelo de suporte. Monitorar custo de instâncias por grupo.

---

## 13. Definition of Done (global)
1. Flag `FEATURE_ORG_GROUPS` promovível e reversível sem downtime perceptível.
2. Suítes de regressão de auth, isolamento e migração **verdes** e bloqueantes no CI.
3. Gate de lint do invariante (§9.1) ativo no CI.
4. Cliente piloto operando Toulon + Democrata em um login, dados isolados, consolidado batendo com as orgs individuais.
5. Runbook de rollback por fase documentado e **testado** em staging.
6. Auditoria (`logAuthEvent`) cobrindo switch, membership e provisionamento.

---

## 14. Riscos e questões em aberto
- **Rebuild de `users` em produção** (§7.4) — maior risco; exige janela e ensaio em staging.
- **Estado real do ASAAS** — confirmar antes de planejar Fase 3.
- **Wiring por-org de ERP/fiscal** na Fase 1 — mapear exatamente como Alterdata/perfil fiscal se conectam por org antes de automatizar.
- **Modelo de permissão de grupo** — MVP: dono do grupo enxerga todas as orgs; papéis por org seguem em `users.role`/`user_stores`. Federação mais fina fica para depois.
- **Limites de instâncias Evolution** por infra — validar teto antes de onboardar redes grandes.

---

## 15. Referências de código (para a equipe)
- Auth/claims: `src/server/routes/auth.ts`, `src/server/middleware/auth.ts`, `src/server/sessionCookie.ts`
- MFA: `src/server/routes/mfa.ts`
- Tenant/usuários: `users`, `organization_settings`, `users.security_version` em `src/server/db.ts`
- Multi-loja (referência de escopo server-side): `RetailStoreService`, `RetailStoreScopeService`, `user_stores`
- Canais WhatsApp: tabela `channels` (`UNIQUE(organization_id, channel_id, identifier)`)
- Provisionamento/plano: `PlanService`, `EntitlementService`, `ModuleService`, `VerticalBlueprintService`, `BlueprintSeeder`
- Snapshots para consolidação: `ExecutiveBusinessSnapshotService`, `BusinessSnapshotV2Service`, `RetailDashboardService`, cache: `RetailAnalyticsCache`
- Auditoria: `logAuthEvent` (`src/server/auditLog.ts`)
- Backup: `BackupService`
