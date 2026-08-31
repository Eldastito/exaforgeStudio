# ADR-199 — ZapFlow Grupo: identidade multi-org, troca de operação e consolidação por fan-out

**Estado:** proposto — decisão de arquitetura para o PRD "ZapFlow Grupo (Multi-Org / Multi-Marca)". Ainda sem código de produção; este ADR fixa arquitetura, invariante de isolamento, RN e o plano de fatias antes de qualquer migração de schema.
**Data:** 2026-08-31.
**Natureza:** aditiva, atrás de feature flag `FEATURE_ORG_GROUPS`, zero-regressão obrigatória para o parque single-org. Toca o único ponto sensível do monolito — autenticação/identidade — então herda revisão reforçada (§8).
**PRD de origem:** `docs/prd/PRD-ZapFlow-Grupo-Multi-Org.md` (Emerson / TesseractAuto).

---

## 1. Contexto e problema

Um cliente é franqueado de **duas franqueadoras** (Toulon e Democrata), **CNPJs separados**, e quer operar as duas a partir de **um login** no ZapFlow, com **paridade total** de serviços por marca. Há prospects com **3+ franquias** de marcas diferentes na mesma situação.

### Realidade da arquitetura (verificada no código)

- `organization_id` é a fronteira de tenant, carimbada em praticamente toda tabela; todo service filtra `WHERE organization_id = ?`.
- **Um humano = uma linha em `users` = uma org.** `users.organization_id TEXT NOT NULL` (`db.ts:380`), `users.email TEXT UNIQUE` (nullable, `db.ts:382`). Não há tabela de membership/grupo/holding.
- Login (`routes/auth.ts:202`) resolve `SELECT * FROM users WHERE email = ?` — **depende da unicidade global de email** — e assina um JWT com `{ userId, organizationId, role, role_profile_id, email, name, platform_role, sv }` (`auth.ts:259`).
- Middleware (`middleware/auth.ts:32`) faz `req.organizationId = decoded.organizationId`. **Todo o app deriva o tenant desse único claim.**
- Precedentes reusáveis já validados: `channels UNIQUE(organization_id, channel_id, identifier)` (multi-WhatsApp por org); `user_stores` + `RetailStoreScopeService` (escopo por-usuário imposto no servidor); separação física camada-global × bridge-por-org (`vertical_intelligence` vs `organization_contextualization`, ADR-156).

### Consequência de projeto (a espinha dorsal)

Como a org da sessão é **apenas um campo do token verificado**, "trocar de operação" é **reassinar o JWT com outro `organizationId`**. O restante do sistema, todo org-scoped, continua funcionando **sem alteração**. Nenhum service precisa "entender grupo".

---

## 2. Objetivos e não-objetivos

**Objetivos**
1. Um login (identidade) pode pertencer a **N organizações** e alternar entre elas.
2. Cada marca permanece uma **org completa e isolada** (dados, catálogo, fiscal, ERP, WhatsApp, plano próprios).
3. Provisionar uma nova operação no grupo com **paridade de plano**, de forma repetível e idempotente.
4. Visão **consolidada** (read-only) do grupo, por agregação, com filtro por marca.
5. **Zero regressão** para o parque single-org.

**Não-objetivos (fora de escopo)**
- Compartilhar catálogo/contatos/fiscal/estoque entre orgs — **proibido** (CNPJs separados exigem isolamento).
- Reescrever qualquer service org-scoped para "entender grupo".
- Billing automatizado de grupo em produção (bloqueado pelo gateway — §9).
- Federação fina de permissões entre orgs além do MVP.

---

## 3. Invariante de isolamento (regra sagrada — RN-GRP-01)

> **A consolidação de várias orgs é feita SOMENTE por _fan-out_: chamar o mesmo service org-scoped, uma vez por org, cada chamada com um único `organization_id`, e mesclar os resultados na camada de consolidação. É PROIBIDO adicionar `groupId`/`group_id` a qualquer service org-scoped, e PROIBIDO qualquer instrução SQL que leia mais de uma org de uma vez.**

Violar isso vaza dado de uma marca na tela da outra e fere o isolamento contratual/fiscal. É invariante **enforced** (§7), não recomendação. Toda dúvida se resolve a favor do isolamento.

---

## 4. Decisões (D1–D8)

### D1 — Camada de identidade acima de `users` (não reescrever `users`)

Introduz-se `account_identities` como **credencial de login** (email + `password_hash` + MFA). Cada org **mantém sua própria linha em `users`** (role, permissões, escopo de loja, avatar — intactos, por-org). `users.identity_id` (FK nullable) liga as linhas que são o mesmo humano em orgs diferentes.

O login autentica a **identidade**, resolve as orgs em que ela tem linha de `users`, e emite o JWT para a org ativa **com os mesmos claims de hoje**, derivados da linha de `users` daquela org. **Nada a jusante muda.**

### D2 — Grupo (holding) como duas tabelas mínimas

`org_groups (id, name, owner_identity_id, ...)` + `org_group_members (group_id, organization_id, UNIQUE(group_id, organization_id))`. O grupo é metadado de agregação/UI; **não** é um tenant nem entra em nenhum service de negócio.

### D3 — Troca de org é reassinatura de JWT sob membership provado

`POST /api/auth/switch-org { orgId }`: valida que a identidade da sessão tem linha de `users` (membership) naquela org e **reassina o JWT** com o novo `organizationId` — reemitindo **coerentemente header token e cookie httpOnly** (§8, RN-GRP-07). Registra no audit (`SWITCH_ORG`). `orgId` do cliente **nunca** é autoridade sem checar membership.

### D4 — Consolidação é um choke point único, sem SQL de negócio próprio

`GroupConsolidationService` é o **único** módulo autorizado a iterar orgs. Para cada org do grupo chama os snapshots existentes (`ExecutiveBusinessSnapshotService`, `BusinessSnapshotV2Service`, `RetailDashboardService`), um `organization_id` por chamada, e agrega. Read-only, filtro por marca, **nunca** SQL cross-org. Cache por org (padrão `RetailAnalyticsCache`), timeout por chamada e **resultados parciais** quando uma org falha (degradação graciosa, nunca erro global).

### D5 — Migração de schema em três fatias, o rebuild por último

O ponto de maior risco é relaxar `users.email UNIQUE` → `UNIQUE(organization_id, email)`, que em SQLite exige **rebuild de tabela** (criar nova, copiar, trocar). Esse passo só acontece **depois** que todo caminho que lê `users` por email já foi migrado para a identidade (RN-GRP-02). Ver plano de fatias (§6) F0a → F0b → F0c.

### D6 — Provisionamento reusa o pipeline de plano existente

O wizard "Adicionar operação ao grupo" reusa `PlanService` / `EntitlementService` / `ModuleService` / `VerticalBlueprintService.assignToOrganization` / `BlueprintSeeder` para seedar o plano idêntico; conecta o WhatsApp da marca (nova instância/canal) e o ERP/fiscal daquele CNPJ. Idempotente: reexecutar não duplica org nem canal.

### D7 — Billing de grupo fica bloqueado até o gateway ser real

ASAAS segue mockado (ADR-177, confirmado). Enquanto isso: não vender o tier de grupo automatizado; cobrar contrato multi-operação manualmente; a fase de billing permanece bloqueada. Métrica de proteção: orgs ativas por grupo vs. operações contratadas.

### D8 — Rollback é desligar a flag + snapshot pré-rebuild

`FEATURE_ORG_GROUPS` controla identidade+switch; o caminho legado permanece o default e intacto até a promoção. Backup obrigatório (`BackupService`/`VACUUM INTO` + `PRAGMA integrity_check`) imediatamente antes do rebuild. Backfill identidade↔users é idempotente e reversível (desvincular `identity_id`, `users` volta ao estado anterior).

---

## 5. Guardrails / RN (endereçam as 5 lacunas achadas na auditoria do código)

Além do invariante RN-GRP-01 (§3):

### RN-GRP-02 — Todo caminho `WHERE email` em `users` migra ANTES do rebuild
Relaxar o UNIQUE de email quebra **muito mais que login+MFA**: com N linhas por email, todo `SELECT ... FROM users WHERE email = ?` passa a retornar linha arbitrária. O código tem hoje pelo menos estes pontos, todos a inventariar e migrar (para resolver por `account_identities` ou por `(organization_id, email)`) **antes** de F0c:
- `routes/auth.ts:202` (login), `:81` (registro), `:282` e `:319` (password reset)
- `routes/users.ts:49` (convite), `FalatuCheckoutService.ts:96`, `routes/onboardingSolo.ts:68`
- `VerticalIntelligenceReminderService.ts:43` e `FalaTuBriefingTaskService.ts:43` (resolvem **master admin** por email)

Enforcement: gate de lint que barra `FROM users WHERE email` fora da whitelist migrada (§7.1).

### RN-GRP-03 — Troca de senha da identidade revoga TODAS as sessões do humano
`security_version` (`sv`) é **por linha de `users`** (`middleware/auth.ts:82,126`). Como a credencial passa a ser compartilhada (identidade), **trocar/resetar a senha (ou MFA) da identidade deve dar bump de `sv` em TODAS as linhas de `users` ligadas** por `identity_id`. Bump em uma só linha revogaria só uma marca e deixaria as outras vivas — falha de segurança. Revogar um único membership continua sendo bump só naquela linha.

### RN-GRP-04 — Email nulo não gera identidade
`users.email` é NULLABLE, mas `account_identities.email` é `NOT NULL UNIQUE`. O backfill 1:1 **pula** linhas de `users` com email nulo (usuários de sistema/bot): permanecem sem `identity_id`, single-org, caminho legado — nunca sintetizar email. Documentado e coberto por teste.

### RN-GRP-05 — O gate de lint mira o conceito de GRUPO, não qualquer iteração de org
Já existe fan-out/cross-org **legítimo** hoje (`Scheduler.ts`, `LgpdService.ts`, `AlterdataSyncRunner.ts`, camadas GLOBAL de plataforma ADR-164 e inteligência ADR-156). A regra de §7.1 barra especificamente `group_id`/`org_group`/`groupId` em services org-scoped (exceto `GroupConsolidationService`) — **não** proíbe iterar orgs em geral, senão daria falso-positivo no código legítimo. Nenhum service org-scoped pode conhecer o conceito de grupo.

### RN-GRP-06 — Master admin sob identidade resolve por linha, não por email ambíguo
Com identidade, `MASTER_ADMIN_EMAIL` pode ter N linhas de `users`. `isPlatformMaster` (`middleware/auth.ts:102`) já revalida por `userId` no DB (autoridade é a linha, não o claim) — manter essa propriedade. Os lookups que hoje fazem `WHERE email = MASTER_ADMIN_EMAIL LIMIT 1` (RN-GRP-02) passam a resolver de forma determinística (identidade → linha da org corrente), não `LIMIT 1` arbitrário.

### RN-GRP-07 — Switch reemite header token e cookie coerentes e descarta estado da org antiga
O front usa `Authorization` header **e** cookie httpOnly em paralelo (`auth.ts:269`, `sessionCookie.ts`). O `switch-org` reemite **os dois** apontando para a nova org (senão header e cookie divergem de tenant) e herda as defesas CSRF (`SameSite=Strict` + same-origin). Qualquer cache/estado de request atrelado à org antiga é descartado na reemissão.

### RN-GRP-08 — Aditivo, idempotente, reversível, atrás de flag
Nenhuma coluna removida; nenhum contrato de API quebrado; migrations `CREATE TABLE IF NOT EXISTS` + `try { ALTER ... ADD COLUMN } catch {}`. Caminho single-org não muda de comportamento — validado por suíte de regressão de auth antes de qualquer merge.

---

## 6. Plano de fatias

O fatiamento do PRD é mantido, com a **Fase 0 desmembrada em três** para tirar o rebuild (passo perigoso) do caminho crítico até que tudo que lê email esteja migrado.

### F0a — Identidade + grupo + backfill, SEM relaxar o UNIQUE (zero-risco)
`account_identities`, `users.identity_id` (+ índice), `org_groups`, `org_group_members`. Backfill idempotente/reversível: para cada `users` com email não-nulo, cria/liga uma `account_identity` 1:1 (RN-GRP-04). Login **continua legado** (email ainda globalmente único). Nenhum comportamento observável muda.
**Aceite:** backfill roda 2× sem duplicar; script de reversão testado; regressão de auth verde; email nulo pulado.

### F0b — Migrar todos os caminhos `WHERE email` para a identidade + gate de lint
Login e `mfa.ts` passam a autenticar/recomparar contra `account_identities`. Todos os pontos de RN-GRP-02 migrados. Gate de lint (§7.1) ativo. Bump de `sv` cross-linha na troca de senha/MFA (RN-GRP-03).
**Aceite:** todo lookup de email inventariado e migrado; troca de senha revoga todas as sessões do humano; suíte de isolamento e regressão verdes.

### F0c — Rebuild `UNIQUE(organization_id, email)` + `switch-org` (atrás da flag)
Procedimento §7.4 do PRD: backup + `integrity_check`; em transação única `users_new` com `UNIQUE(organization_id, email)`; copiar; validar `COUNT(*)` e FKs; trocar; `foreign_key_check` + `integrity_check`. `POST /api/auth/switch-org` (RN-GRP-03/06/07). Ensaio primeiro em staging com cópia real; medir tempo de rebuild; janela de manutenção se necessário. Canary na conta do franqueado piloto (Toulon) antes de ampliar.
**Aceite:** single-org loga idêntico; identidade com 2 memberships alterna e cada org carrega seus dados; `switch-org` sem membership → 403 + audit; revogar membership + bump `sv` derruba a sessão.

### F1 — Provisionamento "Adicionar operação ao grupo" (D6) — **cliente resolvido ao fim desta fase**
Wizard que cria a org + settings, seeda o plano idêntico, conecta WhatsApp e ERP/fiscal por CNPJ, vincula ao grupo e cria a linha de `users` do dono ligada à identidade.
**Aceite:** Toulon e Democrata como 2 orgs no grupo, mesmo conjunto de features; catálogo/contatos/fiscal/estoque não cruzam (teste de isolamento §7.4); provisionar idempotente.

### F2 — Visão consolidada do grupo (D4)
`GroupConsolidationService` (fan-out) + endpoints read-only + dashboard com totais e filtro por marca.
**Aceite:** consolidado = soma verificável das orgs (reconciliação numérica); nenhuma query lê >1 org; org lenta/indisponível vira "parcial", não derruba o dashboard.

### F3 — Billing de grupo — **bloqueada** (D7) até o gateway processar assinatura real.

---

## 7. Enforcement do invariante (camadas independentes)

### 7.1 Gate de CI (lint) — barra o merge
Check por script/ESLint que **falha o build** se qualquer `src/server/**Service.ts` (exceto whitelist `GroupConsolidationService`) referenciar `groupId`, `group_id` ou `org_group` (RN-GRP-05 — mira o conceito de grupo, não iteração de org). E um segundo check que barra `FROM users WHERE email` fora da whitelist migrada (RN-GRP-02). Whitelists explícitas e revisadas.

### 7.2 Tipos "branded"
`OrgId` e `GroupId` como tipos distintos. Services org-scoped aceitam `OrgId` (singular), nunca `OrgId[]` nem `GroupId`. `GroupId` só existe na camada de consolidação — o compilador impede passar grupo onde se espera org.

### 7.3 Choke point único
`GroupConsolidationService` é o único a iterar orgs; não tem SQL de negócio próprio, só orquestra services existentes, uma org por vez. Documentado no cabeçalho do arquivo e aqui.

### 7.4 Teste de isolamento (bloqueante, roda em CI)
Semeia orgs A e B com dados distintos e afirma: endpoint org-scoped no contexto de A nunca retorna linha de B; consolidado = A + B (reconciliação); `switch-org` sem membership → 403; após switch A→B nenhum dado de A vaza. Falhou, não mergeia.

### 7.5 Revisão reforçada
PR que toca login/identidade/switch exige revisão de 2 pessoas e passagem obrigatória nas suítes de isolamento e regressão de auth. Checklist de PR com o item: "Nenhum service passou a receber grupo/lista de orgs? Consolidação é fan-out?".

---

## 8. Segurança

- **Raio de explosão = auth.** Ver §7.5.
- **MFA/senha:** `mfa.ts` e login recomparam contra a **identidade**, sem caminho órfão validando contra `users` (RN-GRP-02). Troca de credencial revoga todas as sessões do humano (RN-GRP-03).
- **CSRF/cookie:** `switch-org` muda estado de sessão; herda `SameSite=Strict` + same-origin de `sessionCookie.ts`; reemite header e cookie coerentes (RN-GRP-07).
- **Autorização do switch:** membership (`org_group_members` / `users.identity_id`) é a única fonte de verdade; `orgId` do cliente nunca é confiado sem checagem.
- **Invalidação:** revogar acesso a uma org = remover a linha de `users`/membership + bump de `sv` daquela linha.

---

## 9. Riscos e questões em aberto

- **Rebuild de `users` em produção** (F0c) — maior risco; exige ensaio em staging com cópia real e possível janela.
- **Estado do ASAAS** — mockado (ADR-177); confirma o bloqueio de billing de grupo.
- **Wiring por-org de ERP/fiscal** na F1 — mapear como Alterdata/perfil fiscal se conectam por org antes de automatizar (`AlterdataSyncRunner` já itera orgs).
- **Custo operacional linear** — cada org = 1 instância/canal WhatsApp (Evolution) + 1 conexão ERP + 1 perfil fiscal. Validar teto de instâncias Evolution antes de onboardar redes grandes; o wizard da F1 é o que evita virar pesadelo de suporte.
- **Permissão de grupo** — MVP: dono do grupo enxerga todas as orgs; papéis por org seguem em `users.role`/`user_stores`. Federação fina fica para depois.

---

## 10. Definition of Done (global)
1. `FEATURE_ORG_GROUPS` promovível e reversível sem downtime perceptível.
2. Suítes de regressão de auth, isolamento e migração verdes e bloqueantes no CI.
3. Gates de lint (§7.1: grupo em service org-scoped + `WHERE email` não migrado) ativos.
4. Cliente piloto operando Toulon + Democrata em um login, dados isolados, consolidado batendo com as orgs individuais.
5. Runbook de rollback por fatia documentado e testado em staging.
6. Auditoria (`logAuthEvent`) cobrindo `SWITCH_ORG`, membership add/remove, `IDENTITY_CREATED`, provisionamento.

---

## 11. Referências de código
- Auth/claims: `src/server/routes/auth.ts`, `src/server/middleware/auth.ts`, `src/server/sessionCookie.ts`
- MFA: `src/server/routes/mfa.ts`
- Tenant/usuários: `users`, `organization_settings`, `security_version`, `bumpSecurityVersion` em `src/server/db.ts` / `middleware/auth.ts`
- Multi-loja (escopo server-side): `RetailStoreService`, `RetailStoreScopeService`, `user_stores`
- Canais WhatsApp: `channels` (`UNIQUE(organization_id, channel_id, identifier)`)
- Provisionamento/plano: `PlanService`, `EntitlementService`, `ModuleService`, `VerticalBlueprintService`, `BlueprintSeeder`
- Snapshots p/ consolidação: `ExecutiveBusinessSnapshotService`, `BusinessSnapshotV2Service`, `RetailDashboardService`; cache: `RetailAnalyticsCache`
- Auditoria: `logAuthEvent` (`src/server/auditLog.ts`); Backup: `BackupService`
