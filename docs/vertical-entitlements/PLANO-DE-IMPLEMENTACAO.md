# ADR-153 — Plano de Implementação (fatias)

**Autor:** Claude (IA Dev). **Data:** 2026-08-04.

Segue o padrão de fatias do repo: **1 fatia = 1 PR draft = CI verde = merge = próxima fatia**. Cada fatia tem escopo pequeno, aditivo, testável isoladamente. Fases seguem numeração do §32 do PRD.

## Fase 0 — Auditoria + PRD + análise + plano *(esta sessão)*

- ✅ 4 agentes Explore mapearam entitlement/subscription/signals/onboarding em paralelo.
- ✅ PRD salvo em `docs/prd/PRD-VERTICAL-ENTITLEMENTS-ASSINATURAS.md`.
- ✅ ADR-153 em `docs/adr/ADR-153-...md`.
- ✅ 5 docs operacionais em `docs/vertical-entitlements/`.
- ✅ Matriz de cobertura preenchida com estado atual.

**Sem código nesta fase.** Aprovação do dono nas 8 decisões pendentes (`DECISOES-E-PENDENCIAS.md`) é pré-condição pra iniciar F1.

## Fase 1 — EntitlementService (fonte única)

### Fatia 1.1 — Serviço + rotas /api/entitlements (aditivo puro)

- **Novo:** `src/server/EntitlementService.ts` — `check(orgId, userId, resource, action) → EntitlementDecision`. Compõe internamente `ModuleService.isEnabled` + `PermissionService.can` + `AddonService.isActive` + `PlanService.modulesForPlan`.
- **Novo:** `src/server/routes/entitlements.ts` — `GET /api/entitlements/me` (retorna map completo do usuário), `GET /api/entitlements/modules` (idem por módulo), `GET /api/entitlements/resource/:key`.
- **Novo:** `scripts/test-entitlement-service.ts` — cobre os 7 estados (`active/available_to_enable/available_to_buy/hidden/suspended/deprecated/pilot_only`) + fallback (usuário legado sem `role_profile_id`) + isolamento multi-tenant.
- **Sem** mudança em nenhum consumer atual — call sites continuam usando `ModuleService.isEnabled` e `useStore`. Isso vem em fatias subsequentes.

**Guardrail:** frontend NÃO consome ainda — só backend disponibiliza.

### Fatia 1.2 — Consumer principal: middleware de rota

- Modifica `server.ts:435-441` pra usar `EntitlementService.checkRoute(orgId, user, segment, method)` em vez do encanamento atual.
- **Compat:** `ModuleService.isEnabled` continua funcional (delega internamente).
- Adiciona `test-entitlement-middleware.ts` — verifica que 403 volta com `reason` explícito (`module_off | plan_ceiling | rbac_gate`).

### Fatia 1.3 — Consumer 2: Sidebar + Configurações Módulos

- Frontend passa a consumir `GET /api/entitlements/me` (uma chamada) em vez de `GET /api/analytics/settings` + `GET /api/permissions/me`.
- `useStore.isModuleEnabled` + `canAccessModule` viram computed properties sobre a resposta única.
- **Split visual:** `ModulesPanel` (SettingsView) passa a mostrar SÓ estados `active` + `available_to_enable`. Estados `available_to_buy` + `hidden` somem daqui.
- Cria placeholder da nova aba `Configurações › Plano e Expansões` — vazia por enquanto.

### Fatia 1.4 — Estado `hidden` implementado

- Blueprint (F3) ainda não existe, então `hidden` vem de mapeamento estático `HIDDEN_BY_VERTICAL` (definido em `EntitlementService.ts`) — ex.: vertical `saude` esconde `retail_floor`; vertical `servicos` esconde `clinica`. Depois da F3, esse mapa é substituído pelo `blueprint.hiddenModules`.
- Test cobre: chaveiro (`servicos`) NÃO vê Clínica; peixaria (`varejo`) NÃO vê Escola.

## Fase 2 — Correção da grade

### Fatia 2.1 — Comigo persistente em todos os planos

- Modifica `plansGrade.ts:16-20` — adiciona `copiloto` em START/GROWTH/SCALE/ENTERPRISE. (Decisão #1 = opção A. Se dono escolher opção B, esta fatia vira "Comigo add-on").
- Adiciona `scripts/test-comigo-preserved-on-upgrade.ts` — cria peixaria em Autônomo com `copiloto` ligado → upgrade pra Start → verifica que `EntitlementService.check('copiloto', 'use')` continua allowed.
- Matriz de upgrades (§8.3 do PRD) — script adicional que loopa `plano_origem × plano_destino × módulos_ativos` e valida que nenhum módulo pré-existente sai do resultado.

### Fatia 2.2 — Bundle Clínica no catálogo de planos

- Adiciona `PLAN_BUNDLES` em `plansGrade.ts`: `[{ key: 'growth_clinica', basePlan: 'growth', addons: ['clinica'], priceMonthly: X }]`.
- Rota `GET /api/plans` passa a devolver `plans[]` + `bundles[]`.
- Frontend `SettingsView` (aba `plan-expansoes`) mostra bundles como opção separada com preço agregado.
- Ativa apenas pra vertical `saude` no default plan do blueprint (F3 fatia).

## Fase 3 — Blueprints

### Fatia 3.1 — Modelo + tabelas + service (aditivo puro)

- **Novo:** tabela `vertical_blueprints` (campos do §25 do PRD) + `organization_blueprints`.
- **Novo:** `src/server/VerticalBlueprintService.ts` com métodos do §24 — `createBlueprint`, `publishVersion`, `getBlueprint`, `listBlueprints`, `assignToOrganization`, `cloneToOrganization`, `previewEntitlements`.
- **Novo:** rotas `POST /api/admin/blueprints` (Master Admin only), `GET /api/admin/blueprints`, `POST /api/admin/blueprints/:id/publish`.
- Test: idempotência, versionamento imutável (não pode UPDATE após publish), assign a org existente.

### Fatia 3.2 — Seed dos 5 blueprints iniciais + migração das orgs vivas

- Seed `moda_loja_unica_v1`, `moda_rede_lojas_v1`, `clinica_multiespecialidades_v1`, `chaveiro_autonomo_v1`, `peixaria_balcao_peso_v1` a partir do `verticals.ts` + `PLAN_GRADE` + adaptações.
- Migração: cada org viva ganha `organization_blueprints` row inferindo blueprint pela `vertical + plan`. Ex.: `vertical='saude' + plan='enterprise' → clinica_multiespecialidades_v1`.
- `EntitlementService.check` passa a consultar Blueprint quando existir (fallback pra lógica atual quando não existir — compat com testes/orgs sem blueprint).
- `HIDDEN_BY_VERTICAL` estático da F1.4 é DEPRECATED — passa a vir do `blueprint.hiddenModules`.

### Fatia 3.3 — Master Admin: assign + preview + migração

- UI em `AdminMasterView`: cada org ganha coluna "Blueprint (v)" com botão "Trocar/Atualizar versão".
- `POST /api/admin/organizations/:id/blueprint` — assign inicial.
- `POST /api/admin/organizations/:id/blueprint/upgrade` — migra pra próxima versão com preview do diff.
- Test: migração v1 → v2 preserva `enabled_modules` do dono; novo optional module aparece como `available_to_enable`.

### Fatia 3.4 — Clone entre orgs

- `POST /api/admin/organizations/:id/blueprint/clone-from` — copia blueprint + overrides de uma org referência (útil pra escalar a rede TOULON pra franqueado novo).

## Fase 4 — Interface: novos painéis

### Fatia 4.1 — Configurações › Módulos (nova versão com 3 áreas)

- Reescreve `ModulesPanel` (SettingsView) com 3 seções:
  - "Seus recursos" (active)
  - "Recursos disponíveis no seu plano" (available_to_enable)
  - "Expansões recomendadas" (link pra `Plano e Expansões` — não renderiza cards aqui)
- Remove renderização de estados `hidden` e `available_to_buy` desta tela.

### Fatia 4.2 — Configurações › Plano e Expansões (nova aba)

- Nova sub-view em `SettingsView`. Mostra:
  - Plano atual + uso + limites (reusa `PlanService.getBillingSnapshot`).
  - Comparação com próximo nível (`PLAN_GRADE` diff).
  - Add-ons compatíveis (`AddonService.list(orgId)` filtrado por blueprint).
  - CTA "Fazer upgrade" (link pra F5 checkout).
  - Recomendação da IA (F7) — seção que aparece só quando há sinal `domain=plan` open.

### Fatia 4.3 — Sidebar consome entitlements com estado `read_only`

- Sidebar renderiza item `read_only` com badge visual + tooltip.
- Middleware bloqueia POST/PUT/DELETE das rotas do módulo `read_only`.
- Test: downgrade → módulo Clínica vira read_only → agendamentos podem ser LIDOS mas não editados/criados.

## Fase 5 — Checkout e assinatura Asaas real

### Fatia 5.1 — Terms of Service versionado

- Nova coluna `organization_settings.terms_version TEXT`, `terms_accepted_at DATETIME`, `terms_accepted_ip TEXT`.
- Tabela `terms_versions (version, effective_at, url, checksum)`.
- Rota `POST /api/terms/accept` — grava aceite.
- Middleware `requireTermsAccepted` — retorna 428 se `terms_version` da org ≠ current.
- **Bloqueio duro:** F5 não avança sem parecer jurídico (Decisão #2).

### Fatia 5.2 — SubscriptionOrchestratorService

- **Novo:** `src/server/SubscriptionOrchestratorService.ts` — `preview(orgId, targetPlanId)`, `confirm(orgId, targetPlanId, {termsAccepted, paymentMethod, cpfCnpj})`, `cancel(orgId, {reason})`.
- **Novo:** tabela `subscription_change_requests` (§25 do PRD) — grava toda mudança comercial.
- Trial → past_due automático via `Scheduler.trialExpiryPass()`.
- Test: primeiro checkout → webhook confirma → `EntitlementService.check` reflete novo estado.

### Fatia 5.3 — Rotas /api/billing/*

- `GET /api/billing/plans` (com bundles).
- `GET /api/billing/current`.
- `POST /api/billing/checkout` (primeira assinatura).
- Frontend `LoginView` + `SettingsView` migram pra usar essas rotas.
- Webhook Asaas ganha handling de `PAYMENT_CONFIRMED` no contexto de `subscription_change_requests` (idempotência por `provider_reference`).

## Fase 6 — Upgrade com proporcionalidade + downgrade

### Fatia 6.1 — Upgrade preview + proporcionalidade calculada

- `POST /api/billing/upgrade/preview` — devolve `{fromPlan, toPlan, prorationAmount, effectiveAt, breakdown}`. Cálculo no backend (§27 do PRD).
- `POST /api/billing/upgrade/confirm` — cria `subscription_change_requests` com `status='awaiting_payment'`.
- Executor: cria PAYMENT único no Asaas com `value=prorationAmount, dueDate=today+3` + atualiza subscription (novo `value` no próximo ciclo).
- Webhook `PAYMENT_CONFIRMED` cruza `provider_reference` → aplica entitlement + `status='applied'`.
- Falha: `status='payment_failed'`, plano anterior mantido.
- Test: upgrade Autônomo→Growth com 15 dias no ciclo cobra 50% da diferença.

### Fatia 6.2 — Downgrade agendado

- `POST /api/billing/downgrade` — cria `subscription_change_requests` com `status='scheduled', effective_at=current_period_end`.
- Scheduler job `subscriptionChangePass()` no início de cada ciclo aplica downgrades pendentes.
- Módulos que saem viram `read_only` (F4.3 já implementou).
- Test: downgrade Growth→Start marcado hoje → dia da renovação, cadências viram read_only.

### Fatia 6.3 — Add-ons pagos via Asaas

- Migra `AddonService.contract` pra chamar Asaas (não é mais mock).
- Add-on é `subscription_change_requests` com `change_type='addon_add'`.
- Test: contrata `retail` como add-on → Asaas cobra 1x → webhook confirma → módulo `retail` ativa via `EntitlementService`.

## Fase 7 — Upgrade Recommendation Engine

### Fatia 7.1 — Detector + publisher de sinais `domain=plan`

- **Novo:** `src/server/PlanFitDetectorService.ts` — scanner puro (analog `SalesStalledDealDetectorService`). Detecta:
  - `plan_near_limit_ai` (≥80% do teto mensal)
  - `plan_near_limit_channels/contacts/users`
  - `plan_module_gap_<key>` (org tem N sinais no domínio X mas plano não tem o módulo relacionado — ex.: 20 sinais `sales_recovery_proposed` mas plano sem `execucao`)
  - `plan_capacity_bottleneck` (fila de tarefas manuais >X)
- **Novo:** `src/server/PlanFitSignalPublisher.ts` — segue padrão `ClinicRenewalTaskService.run` (publish + sweep resolve por dedupe_key).
- Adiciona entradas em `ImpactPrioritizationService.ACTION_MAP` → `{actionType: 'propose_upgrade', label: 'Considerar plano X'}`.
- Adiciona `plan: 0.9` em `STRATEGIC` do ImpactPrioritizationService.
- Novo `Scheduler.planFitPass()` roda no slow pass (diário).
- Test: org com uso 95% de IA gera sinal `plan_near_limit_ai severity=critical` uma vez/mês.

### Fatia 7.2 — Score + evidence_json + explicabilidade

- `PlanFitDetectorService` calcula score 0-100 (§14 do PRD) e enche `evidence_json` com breakdown por dimensão.
- `DecisionAction` proposto tem `expected_impact = estimated_uplift_BRL` + `command_type='propose_upgrade'` + `command_payload_json = {targetPlanId, reasons, evidence}`.
- Test: score < 60 → sinal não publicado. Score 60-74 → severity=`info`. 75-89 → `attention`. 90+ → `risk`.

### Fatia 7.3 — Frequency control + LGPD

- Nova tabela `upgrade_recommendations` (§25 do PRD).
- Publisher checa: última recomendação pro MESMO `targetPlanId` foi rejeitada nos últimos 30d? Skip. Org em `billing_status IN (past_due, suspended, blocked)`? Skip. Org usando <30% do plano atual? Skip.
- Rotas `POST /api/billing/recommendation/{dismiss,accept}` gravam decisão.
- Test: recomendação Autônomo→Growth pra Bar do Zé → dono rejeita → 29 dias depois, mesma condição, nada é publicado.

### Fatia 7.4 — ExecutiveView tab "Plano e Expansões"

- Nova aba no `ExecutiveView` filtrada por `domain=plan`, alimentada por `GET /api/insights?domain=plan` + `GET /api/actions?domain=plan`.
- Cards com título, evidência resumida, CTA "Ver detalhes" (abre modal com breakdown do score + preço + comparação).
- CTA "Fazer upgrade" chama `POST /api/billing/upgrade/preview` → `.../confirm` (F6).
- Test: sinal `plan_near_limit_ai` open → aba mostra card → dono clica aceitar → cria `subscription_change_request` → checkout.

### Fatia 7.5 — IA no Executive Advisor pode citar (sem contratar)

- `ExecutiveAdvisorService` recebe contexto de recomendações pendentes.
- Quando dono pergunta "e aí?", pode citar "Identifiquei que você está em 92% do limite de IA. Deseja ver a recomendação de plano?"
- Só cita SE score ≥ 75.
- NUNCA contrata sem clique explícito (G-153-3).
- Test: prompt de dono com recomendação open → resposta cita → dono diz "pode ser" → resposta é "vou abrir a comparação" (nunca "vou contratar").

## Fase 8 — Rollout

### Fatia 8.1 — Shadow mode em orgs de referência

- Todos os detectores + recomendação rodam mas sinais são publicados com `severity='info'` sempre (não escala).
- `EntitlementService` roda em paralelo com `ModuleService.isEnabled` — grava divergências em audit log (`ENTITLEMENT_DIVERGENCE`).
- 2 semanas de observação em `org_ref_peixaria` + `org_ref_chaveiro` + TOULON.

### Fatia 8.2 — Piloto TOULON com blueprint `moda_rede_lojas_v1` completo

- Assigns `moda_rede_lojas_v1` na TOULON via Master Admin.
- Todos os módulos essenciais + opcionais do blueprint ficam disponíveis.
- Monitora 30 dias em produção.

### Fatia 8.3 — Piloto Clínica

- Uma clínica real recebe `clinica_multiespecialidades_v1` + bundle Growth+Clínica.
- Primeira venda com checkout completo (F5) + upgrade (F6) validados.

### Fatia 8.4 — Abertura de vendas em escala

- Site institucional passa a listar Blueprints (produtos).
- Autoserve completo: cliente escolhe Blueprint → checkout → onboarding automático.
- Marketing habilitado.

## Estimativa (grosseira, sem promessa)

- **Fase 1:** 4 fatias.
- **Fase 2:** 2 fatias.
- **Fase 3:** 4 fatias.
- **Fase 4:** 3 fatias.
- **Fase 5:** 3 fatias.
- **Fase 6:** 3 fatias.
- **Fase 7:** 5 fatias.
- **Fase 8:** 4 fatias.
- **Total:** ~28 fatias.

Cada fatia = 1 PR draft, ciclo curto (padrão do repo). Fases 1-3 são pré-requisito pra tudo; Fases 4-6 são pré-requisito pras vendas em escala.

## Dependências externas / bloqueios

- **F5.1 (Terms):** depende de parecer jurídico (Decisão #2).
- **F5.3 (Rotas billing):** depende de HMAC assinado no webhook Asaas (Decisão #3) — ou aceitar token estático como aceitável.
- **F8.4 (Vendas em escala):** depende de todos os itens do §33 do PRD (Bloqueadores).
