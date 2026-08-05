# ADR-153 — Matriz de Cobertura do PRD

Cada linha rastreia um item concreto do PRD (`docs/prd/PRD-VERTICAL-ENTITLEMENTS-ASSINATURAS.md`). Estados:

- `[ ]` — não implementado.
- `[~]` — parcialmente implementado ou existe mas precisa refactor.
- `[x]` — implementado + testado + doc atualizado (conforme critério em `STATUS-DE-EXECUCAO.md § Como marcar item como concluído`).
- `[!]` — bloqueado em decisão do dono.

Cada item aponta a fatia do `PLANO-DE-IMPLEMENTACAO.md` que o entrega.

---

## §1–3 — Instruções de processo (Fase 0)

- [x] PRD lido integralmente pela IA Dev — evidência: `STATUS-DE-EXECUCAO.md` sessão 2026-08-04.
- [x] Codebase mapeado — 4 agentes Explore, relatórios consolidados em `ANALISE-ARQUITETURAL.md §1`.
- [x] Componentes existentes mapeados: `verticals.ts`, `ModuleService`, `PlanService`, `plansGrade.ts`, `AddonService`, `PermissionService`, `AsaasService`, `BusinessSignalService`, `OnboardingTemplateService`, `Scheduler` — todos catalogados com file:line em `ANALISE-ARQUITETURAL.md`.
- [x] Divergências entre PRD e código identificadas — tabela em `ANALISE-ARQUITETURAL.md §2` (21 linhas).
- [x] Ponderações registradas — `ANALISE-ARQUITETURAL.md §3` (9 seções).
- [x] Arquitetura mínima proposta — 4 primitivas novas + 3 correções em `ADR-153.md § Decisão`.
- [x] PRD salvo em `docs/prd/`.
- [x] Plano de implementação salvo em `docs/vertical-entitlements/PLANO-DE-IMPLEMENTACAO.md`.
- [x] Matriz de cobertura criada (este arquivo).
- [ ] Desenvolvimento (Fase 1+) — aguardando decisões pendentes.

---

## §4–6 — Contexto e problema (informativo, não gera item)

## §7 — Objetivos

- [~] Empresas verem apenas o que contrataram — hoje `ModuleService.overview` mostra `upgrade` como locked card (vaza catálogo global). Fatia 4.1 corrige.
- [~] Impedir habilitação manual fora do plano — backend já impede uso, mas UI mostra a opção. Fatia 4.1.
- [x] Coerência plano/vertical/add-on/módulo — F1.2 migrou o middleware, F1.3 migrou o frontend. Sidebar + ModulesPanel + útiles derivam de `useStore.entitlements` alimentado por `GET /api/entitlements/me`. Fonte única no backend + frontend.
- [x] Upgrades sem perda de funcionalidades — bug fechado em F2.1 (Decisão #1 aprovada: `copiloto` agora em todos os 5 tiers). Matriz completa `origem × destino × módulos` no `test:upgrade-matrix` (93/93 OK) garante que nenhum upgrade remove módulo pré-existente.
- [ ] Automatizar venda + pagamento + ativação — não existe fluxo real. Fase 5.
- [ ] IA recomenda plano certo no momento certo — motor não existe. Fase 7.
- [ ] Consentimento explícito pra qualquer alteração contratual — nenhum aceite gravado. Fatia 5.1 (**Decisão #2**).
- [ ] Verticais → produtos replicáveis (Blueprints versionados) — conceito não existe. Fase 3.
- [ ] Backend/menu/configurações/automações usam mesma fonte de verdade — 3-4 camadas hoje independentes. Fase 1 unifica via `EntitlementService`.

## §9 — Conceito de trabalho pronto (padrão de aceite)

- Todo item marcado `[x]` obedece o checklist do `STATUS-DE-EXECUCAO.md § Como marcar item como concluído`.

## §11 — Componentes obrigatórios

### §11.1 EntitlementService (novo)

- [x] Serviço `EntitlementService` com `check()` retornando `{allowed, visibility, reason, state, source, upgradeEligible, upgradeTargetPlan, addonEligible, addonPrice}`. Fatia 1.1 — `src/server/EntitlementService.ts`.
- [x] Rotas `/api/entitlements/{me,modules,resource/:key}`. Fatia 1.1 — `src/server/routes/entitlements.ts` (`GET` only).
- [x] Estados: `active | available_to_enable | available_to_buy | hidden | suspended` implementados. F1.4 endureceu `hidden` via `blueprint.config.hiddenModules` (fonte estruturada + fallback estático pra orgs em transição). `deprecated | pilot_only` continuam reservados como enum sem detector (fatia futura só se surgir demanda concreta).

### §11.2 VerticalBlueprintService (novo)

- [x] Tabelas `vertical_blueprints`, `organization_blueprints`. F3.1 — schema em `db.ts` com `UNIQUE(key, version)` + índices status/base_vertical/org_key.
- [x] Métodos: `createBlueprint, publishVersion, getBlueprint, getBlueprintByKeyVersion, getLatestPublished, listBlueprints, assignToOrganization, getForOrganization, cloneToOrganization, previewEntitlements` (10 métodos). F3.1 entregou. F3.3 vai adicionar `upgradeBlueprintVersion`, `compareVersions`, `rollbackVersion`.
- [x] Imutabilidade após publish. F3.1 — enforced no service (rejeita `assignToOrganization` de draft; publish idempotente; deprecate one-way). Test cobre.
- [x] Override por org em `organization_blueprints.overrides_json`. F3.1 — coluna criada + `assignToOrganization` grava + `cloneToOrganization` copia.

### §11.3 SubscriptionOrchestratorService (novo)

- [~] Tabelas `subscription_change_requests`, `upgrade_recommendations`, `terms_versions`. F7.3 entregou `upgrade_recommendations` (ledger + cooldown). `subscription_change_requests` fica pra F5.2; `terms_versions` pra F5.1 (bloqueada Decisão #2).
- [ ] Métodos: `preview, confirm, cancel`. Fatia 5.2.
- [ ] Rotas `/api/billing/{plans,current,checkout,upgrade/preview,upgrade/confirm,downgrade}`. Fatias 5.3 + 6.1 + 6.2.
- [ ] Proporcionalidade upgrade imediato. Fatia 6.1.
- [ ] Downgrade agendado no próximo ciclo. Fatia 6.2.
- [ ] Idempotência via `subscription_change_requests.provider_reference`. Fatia 5.2.

### §11.4 UpgradeRecommendationEngine (novo)

- [x] `PlanFitDetectorService` (scanner puro). F7.1 — 4 métricas (ai/contacts/channels/users), severity determinística [80/90/100], targetPlanId, guardas cortesia/blocked/past_due/soft-deleted.
- [x] `PlanFitSignalPublisher` (publish + resolve por dedupe_key). F7.1 — pattern ClinicRenewalTaskService, dedupe mensal por métrica, runAll best-effort.
- [~] Novos sinais `domain='plan'` — F7.1+F7.2 entregou 5 signal_types (`plan_near_limit_ai/contacts/channels/users` + `plan_module_gap`). `plan_capacity_bottleneck` fica pra fatia futura (agregador de múltiplas near_limit no mesmo mês).
- [x] `Scheduler.planFitPass()` no slow pass. F7.1 — best-effort, tick após clinicRetention + schoolCoordination + antes de billingDunning.
- [x] Score 0–100 baseado em 6 dimensões (§14 do PRD). F7.2 — `computeNearLimitScore`+`computeModuleGapScore` determinísticos, threshold DURO `MIN_PUBLISH_SCORE = 60` filtra antes de publicar.
- [x] `evidence_json` com breakdown por dimensão. F7.2 — `evidence.scoreBreakdown` com 6 chaves nomeadas + `total`; `premises.scoreThreshold` + `premises.scoreTotal` em cada sinal.
- [x] Explicabilidade em linguagem natural. F7.2+F7.4 — card mostra título humanizado, badge `score X/100`, "Ganho estimado: R$ X/mês" (uplift 3× diff de preço), botão expandível revela grid das 6 dimensões nomeadas em PT-BR.
- [x] `impact_amount` em BRL/mês (uplift estimado). F7.2 — `estimateUpliftBrl(current, target) = 3× (target.price − current.price)` (payback conservador); `impactUnit='BRL'`.
- [x] Frequency control (§15 do PRD). F7.3 — cooldown determinístico 30d → 90d → 180d por (org, target_plan_id, target_module_key); TETO em 180 na 4ª+ rejeição; `hasActiveCooldown` filtra ANTES do publisher publicar.
- [x] LGPD: rejeição pausa nova oferta. F7.3 — `POST /api/signals/:id/dismiss` propaga cooldown via hook (`dismissBySignalId`), UI existente (F7.4) continua funcionando com zero mudança. RN-153-F7.3-003: severity=critical bypassa cooldown (uso ≥100% precisa saber).
- [x] Rotas `/api/billing/recommendation/{dismiss,accept}`. F7.3 — `POST /api/billing/recommendations/:id/dismiss` (idem hook, mas explícito), `POST /api/billing/recommendations/:id/accept` (marca aceita + retorna `redirectTo` pra Cobrança; G-153-3: nada cobrado aqui). Também `GET /api/billing/recommendations` (lista com filtro status).
- [x] Tabela `upgrade_recommendations`. F7.3 — ledger dedicado; campos incluem `signal_id, target_plan_id, target_module_key, score, impact_amount, evidence_json, status, rejection_count, cooldown_until, accepted_at, dismissed_at`.

## §5 — Princípios obrigatórios

- [ ] G-153-1 — Nenhuma tela define permissão. Fatia 1.3 (frontend consume único `/api/entitlements/me`).
- [ ] G-153-2 — Upgrade nunca remove capacidade. Fatia 2.1 + matriz de upgrades (`test-upgrade-matrix.ts`).
- [ ] G-153-3 — IA nunca contrata sem clique. Fatia 7.5 (test cobre).
- [ ] G-153-4 — Preços calculados no backend, HMAC webhook. Fatia 5.2 + 5.3 (**Decisão #3**).
- [ ] G-153-5 — Blueprint publicado é imutável. Fatia 3.1 (test cobre).
- [~] G-153-6 — Recomendação ≥60 + sem rejeição 30d + org não em incidente. F7.2 fez o threshold ≥60 (MIN_PUBLISH_SCORE). F7.3 fez o cooldown por rejeição (30/90/180d). "Org não em incidente" continua dependendo de detecção de incidente (fatia futura); billing_status blocked/cancelled/past_due já skipa desde F7.1.
- [ ] G-153-7 — Downgrade preserva dados via `read_only`. Fatia 4.3 + 6.2 (**Decisão #9**).

## §7 — Modelo de entitlement

- [ ] Resolução `blueprint ∩ plano + add-ons + concessões ∩ enabled_modules ∩ RBAC ∩ flags`. Fatia 1.1 (composição inicial) + 3.2 (blueprint substitui `HIDDEN_BY_VERTICAL` estático).
- [ ] Estado `hidden` diferente de `available_to_buy`. Fatia 1.4 + 3.2.

## §8 — Correção da grade

- [x] Comigo persistente (Decisão #1 = Opção A, aprovada). Implementado em F2.1: `plansGrade.ts` — `START = [...AUTONOMO, ...]` propaga copiloto via cascade. Descrição em `ModuleService.MODULE_META.copiloto` atualizada.
- [x] Matriz `origem × destino × módulos` testada. F2.1 — `scripts/test-upgrade-matrix.ts` (93/93 OK). Vertical não entra na matriz (ADR-153 §7 diz "blueprint ∩ plano" — vertical é preset independente).

## §9 — Vertical Blueprint

- [ ] Estrutura JSON `{key, version, baseVertical, allowedPlans, defaultPlan, minimumPlan, requiredModules, optionalModules, commercialUpgrades, hiddenModules, quickStartPack, runtimePlaybooks}`. Fatia 3.1.

## §10 — Blueprints iniciais

- [x] `moda_loja_unica_v1`. F3.2 — seedado + publicado; migração automática pra orgs `vertical=moda + plan!=scale/enterprise`.
- [x] `moda_rede_lojas_v1`. F3.2 — seedado + publicado; migração automática pra orgs `vertical=moda + plan=scale/enterprise` (TOULON).
- [x] `clinica_multiespecialidades_v1`. F2.2 + F3.2 — bundle Growth+Clínica + blueprint com `defaultBundleKey='growth_clinica'`; migração automática pra `vertical=saude`.
- [x] `chaveiro_autonomo_v1`. F3.2 — seedado + publicado; migração automática pra `vertical=servicos + plan=autonomo`.
- [x] `peixaria_balcao_peso_v1`. F3.2 — seedado + publicado; migração automática pra `vertical=varejo + plan=autonomo`.

## §11 — Regra de visibilidade

- [x] Menu principal só mostra `visible + active + RBAC != none`. F1.3 — Sidebar consome `useStore.isModuleEnabled` + `canAccessModule`, ambos derivados de `entitlements[k].state === 'active'` e `entitlements[k].visibility === 'visible'`.
- [x] Configurações › Módulos com 3 áreas (`Seus recursos + Disponíveis no plano + Expansões`). F1.3 (ModulesPanel migrado; `available_to_buy` vira link colapsado pra `Plano e Expansões`).
- [x] `Configurações › Plano e Expansões` tela separada. F4.2 preenche com 7 blocos: plano atual + blueprint + status; uso × limites; bundles verticais recomendados; próximos níveis (comparação PLAN_GRADE); add-ons compatíveis (filtrados por blueprint); add-ons ativos; slot IA (F7 popula). CTA leva pra Cobrança (checkout real vem em F5.3).

## §12–14 — Motor de recomendação

- [ ] Sinais permitidos (§12.1) — 15 dimensões documentadas. Fatia 7.1 implementa as principais (`ai_this_month`, `channels`, `contacts`, `users`, signal_density).
- [ ] Sinais proibidos isoladamente (§12.2) — só rechaça pattern não-informativo (visita repetida da tela = não-signal). Fatia 7.1 (test cobre).
- [~] Condições pra recomendar (§13) — 7 pré-condições. F7.1+F7.2+F7.3 cobrem: (1) uso alto (near_limit ≥80%) — F7.1; (2) score ≥60 — F7.2; (3) upgrade tem valor (uplift BRL positivo) — F7.2; (4) blueprint alinhado — F7.2 `plan_module_gap`; (5) sem cooldown ativo — F7.3; (6) org não bloqueada — F7.1 (billing_status skip). (7) "sem incidente ativo" fica pra fatia futura.
- [x] Score 0-100 com breakdown (§14). F7.2 — 6 dimensões determinísticas, threshold DURO ≥60, breakdown exposto em `evidence.scoreBreakdown`.

## §15 — Frequência

- [x] Cooldown 30 dias por `target_plan_id`. F7.3 — escala 30/90/180 (RN-153-F7.3-001/002). Decisão #7 resolvida no código (documentada em `COOLDOWN_LADDER_DAYS`).
- [~] Rejeição/inadimplência/incidente pausam. F7.3 — rejeição pausa via `dismiss` (30/90/180d). Inadimplência já pausa desde F7.1 (`billing_status IN blocked/cancelled/past_due` skipa detector). Incidente pausa fica pra fatia futura (requer sinal de incidente detectado).

## §16 — Explicabilidade

- [~] Recomendação explica motivo + dados + funcionalidade + problema + preço + impacto + limitações. F7.4+F7.2 entregou motivo (severity+título humanizado por signal_type, incluindo "módulo do seu Blueprint" pra `plan_module_gap`) + dados (used/limit/pct + `evidence.scoreBreakdown` 6-dim) + funcionalidade (upgradeTargetPlan + moduleKey quando aplica) + problema (severity) + impacto em BRL (`estimatedUpliftMonthly` 3× diff de preço). Preço final do plano + checkout ficam pra F5.3 (Asaas + aceite explícito).

## §17 — Automação venda

- [ ] Fluxo `escolha → resumo → aceite → checkout → cobrança → confirmação → ativação → onboarding → comprovante`. Fatia 5.2 + 5.3.
- [ ] Checkout coleta CPF/CNPJ + responsável + método + aceite. Fatia 5.3.
- [ ] Métodos PIX/cartão/boleto (via Asaas `billingType='UNDEFINED'`). Já existe (Fatia 5.3 usa mesmo).
- [ ] Persistência `{provider, customer_id, subscription_id, payment_id, plan_id, billing_cycle, price, start, end, status, terms_accepted, terms_version}`. Fatia 5.1 + 5.2.

## §18 — Fluxo de upgrade

- [ ] Preview + comparação + valor proporcional + aceite → checkout → webhook → entitlement. Fatia 6.1.
- [ ] IA nunca contrata sem clique explícito. Fatia 7.5 (test cobre).

## §19 — Proporcionalidade

- [ ] Upgrade imediato: ativa agora, cobra diferença proporcional, mantém data renovação. Fatia 6.1.
- [ ] Downgrade: próximo ciclo, avisa perdas, impede se dependência ativa não resolvida. Fatia 6.2.

## §20 — Add-ons

- [~] Add-ons existem (`AddonService`, mock). Precisa integração Asaas real. Fatia 6.3.
- [ ] Cada add-on tem `{preço, ciclo, módulos, limites, dependências, compatibilidade_blueprint, regras_cancelamento}`. Fatia 6.3.

## §21 — Aplicação de entitlements

- [ ] Ativação SÓ após webhook confirmado + assinatura válida + entitlement calculado + módulos aplicados. Fatia 5.2 (inverte fluxo atual que aplica antes da confirmação).

## §22 — Falha no pagamento

- [ ] Falha mantém plano anterior; não libera recursos; registra tentativa; informa usuário; permite retry. Fatia 5.2 + 6.1.

## §23 — Cancelamento e downgrade

- [ ] Políticas: solicitação, retenção, data efetiva, exportação, recursos perdidos, dados preservados, reativação, carência. Fatia 6.2 + **Decisão #9**.
- [ ] Módulos removidos viram `read_only` (não delete). Fatia 4.3 + 6.2.

## §24 — VerticalBlueprintService detalhado

Já mapeado em §11.2. Ver Fatia 3.1 + 3.3 + 3.4.

## §25 — Tabelas conceituais

- [x] `vertical_blueprints`. F3.1 — `db.ts` (id, key, name, base_vertical, version, status, minimum_plan_id, default_plan_id, default_bundle_key, config_json, created_at, published_at, UNIQUE(key, version)).
- [x] `organization_blueprints`. F3.1 — `db.ts` (organization_id PK, blueprint_id, blueprint_key, blueprint_version, assigned_at, assigned_by, overrides_json, status).
- [ ] `plan_entitlements`. Fatia 1.1 (opcional — hoje derivamos de `plans.features.modules`; se performance exigir, materializa depois).
- [ ] `organization_entitlements`. Fatia 4.3 (necessário pra estado `read_only` + concessões explícitas).
- [x] `upgrade_recommendations`. F7.3 — tabela criada em `db.ts` com 3 índices (org+status, target composto, signal).
- [ ] `subscription_change_requests`. Fatia 5.2.
- [ ] `terms_versions`. Fatia 5.1.

## §26 — APIs

Entitlements: [ ] `/me`, [ ] `/modules`, [ ] `/resource/:key` — Fatia 1.1.
Blueprints: [x] `GET /api/admin/blueprints` + `GET /:id`, [x] `POST /api/admin/blueprints`, [x] `POST /:id/publish` + `POST /:id/deprecate`, [x] `POST /api/admin/organizations/:id/blueprint` + `GET /api/admin/organizations/:id/blueprint` + `GET /.../blueprint/preview`. F3.1 entregou todas.
Planos: [ ] `GET /billing/plans`, [ ] `GET /billing/current`, [ ] `POST /billing/checkout`, [ ] `POST /billing/upgrade/preview`, [ ] `POST /billing/upgrade/confirm`, [ ] `POST /billing/downgrade` — Fatias 5.3 + 6.1 + 6.2.
Recomendação: [x] `GET /api/billing/recommendations`, [x] `POST .../:id/dismiss`, [x] `POST .../:id/accept` (não executa upgrade — G-153-3) — F7.3. Adicionalmente `GET /api/billing/recommendations/:id` (detalhe).

## §27 — Segurança

- [~] Isolamento multi-tenant — já existe (todo query filtra `organization_id`). Manter em todos os novos services (Fatias 1, 3, 5, 6, 7).
- [~] RBAC — `PermissionService` existe. Fatia 1.2 unifica com EntitlementService.
- [!] Webhook autenticado — hoje token estático. **Decisão #3** (HMAC). Fatia 5.2.
- [~] Idempotência webhook — hoje existe (`asaas_webhook_events`). Fatia 5.2 estende com `provider_reference` na `subscription_change_requests`.
- [!] Consentimento — não existe pra SaaS. **Decisão #2.** Fatia 5.1.
- [~] Auditoria — `logAuthEvent` existe. Fatias 5.2 + 6.1 + 7.3 adicionam eventos novos.
- [~] Replay/duplicação — dedup por `subscription_change_requests.provider_reference`. Fatia 5.2.
- [ ] Valores calculados no backend — checkout preview envia proporção calculada; frontend só exibe. Fatia 6.1.
- [~] LGPD — parcial (contact-level existe). Falta contrato org-level. Fatia 5.1.
- [!] Contrato versionado — **Decisão #2**. Fatia 5.1.
- [ ] Trilha de aceite — `terms_accepted_at + terms_version + terms_accepted_ip`. Fatia 5.1.

## §28 — Aceite visibilidade

- [x] Chaveiro não vê Clínica. F1.4 + F3.2 — blueprint `chaveiro_autonomo_v1.hiddenModules` inclui `clinica` (fonte de verdade); `EntitlementService.check` respeita.
- [x] Peixaria não vê Escola. F1.4 + F3.2 — blueprint `peixaria_balcao_peso_v1.hiddenModules` inclui `escola`.
- [x] Clínica não vê Retail Ops sem entitlement. F1.4 + F3.2 — blueprint `clinica_multiespecialidades_v1.hiddenModules` inclui `retail` + `retail_floor`.
- [ ] Admin não consegue ativar módulo fora do plano. Fatia 1.2 (middleware) + 4.1.
- [ ] Payload frontend modificado não fura backend. Fatia 1.1 (backend re-valida).
- [ ] Menu e API dão mesma resposta. Fatia 1.3.
- [ ] Configurações mostra só relevantes. Fatia 4.1.
- [ ] Upgrade aparece só em Plano e Expansões. Fatia 4.1 + 4.2.
- [ ] Usuário sem RBAC não vê módulo ativo. Fatia 1.2 + 1.3.
- [ ] Add-on cancelado é removido do entitlement. Fatia 3.1 + 4.3.

## §29 — Aceite upgrade

- [x] Upgrade não remove Comigo. F2.1 — validado em `test:comigo-preserved-on-upgrade` (peixaria autonomo → start/growth/scale/enterprise mantém `copiloto.state='active'`).
- [ ] Preview mostra preço + proporcionalidade. Fatia 6.1.
- [!] Consentimento obrigatório. **Decisão #2.** Fatia 5.1 + 6.1.
- [ ] Cobrança confirmada ativa recursos. Fatia 6.1.
- [ ] Cobrança falha mantém plano anterior. Fatia 6.1 (test cobre).
- [ ] Webhook duplicado não duplica upgrade. Fatia 5.2 (dedup por `provider_reference`).
- [ ] Upgrade auditado. Fatia 5.2 + 6.1.
- [ ] Downgrade só no próximo ciclo. Fatia 6.2.
- [ ] Dados de módulos removidos preservados. Fatia 4.3 + 6.2 (**Decisão #9**).
- [ ] Add-ons continuam ativos se compatíveis. Fatia 6.3.

## §30 — Aceite recomendação

- [x] Usa dados reais. F7.1 (`PlanService.getUsage` + `PlanFitDetectorService` consulta SQL puro).
- [~] Score registrado. F7.2 grava `score` em `business_signals.premises.scoreTotal` + breakdown em `evidence.scoreBreakdown`; tabela dedicada `upgrade_recommendations` (com histórico + cooldown) fica pra F7.3.
- [x] Razões explicáveis. F7.2+F7.4 — breakdown por dimensão + uplift em BRL exposto no card + título humanizado por signal_type.
- [x] Respeita vertical (Blueprint). F7.2 — `plan_module_gap` só publica em orgs com blueprint assignado; `adequacao_vertical` dá +10 quando alinhado ao blueprint.
- [x] Não recomenda módulo oculto. F7.2 — `plan_module_gap` só varre `blueprint.config.requiredModules`+`optionalModules` (nunca `hiddenModules`); `EntitlementService` já esconde os hidden via F1.4.
- [ ] IA não altera plano sozinha. Fatia 7.5 (chat menciona sob demanda).
- [x] Rejeição pausa. F7.3 — cooldown 30/90/180d por (org, target_plan, module); `UpgradeRecommendationService.hasActiveCooldown` bloqueia publish. Decisão #7 resolvida no código (escala determinística documentada).
- [x] Benefício estimado rotulado como estimativa. F7.2 — `impact_amount` em BRL + card mostra "Ganho ESTIMADO" (label explícito); premise `basis='fact'` refere-se aos contadores; futura `expected_impact` no card evoluí em F5.3 (checkout mostra preço real).
- [ ] Preço vem do backend. Fatia 7.4 + 6.1.
- [ ] Aceite explícito obrigatório. Fatia 7.4 + 6.1 (fluxo `card → preview → confirm`).

## §31 — Testes obrigatórios

- [ ] Matriz `Blueprint × Plano × Add-on × Módulo × RBAC × Menu × Configurações × API`. Script pós-Fase 3 (`test-entitlement-matrix.ts`).
- [ ] Casos mínimos: peixaria Autônomo/Growth, chaveiro Autônomo/Start, clínica bundle/sem-add-on, moda loja única, TOULON rede, downgrade, upgrade, cobrança falha, webhook duplicado, add-on, usuário sem permissão, admin tentando alterar payload. Scripts por Fatia (referenciar cada em `STATUS-DE-EXECUCAO.md`).

## §32 — Roadmap

- [x] Fase 0 (Auditoria) — esta sessão.
- [ ] Fase 1 (EntitlementService) — Fatias 1.1–1.4.
- [ ] Fase 2 (Correção grade) — Fatias 2.1–2.2 (**Decisão #1, #5**).
- [ ] Fase 3 (Blueprints) — Fatias 3.1–3.4 (**Decisão #4, #5, #6**).
- [ ] Fase 4 (Interface) — Fatias 4.1–4.3 (**Decisão #9**).
- [ ] Fase 5 (Checkout e assinatura) — Fatias 5.1–5.3 (**Decisão #2, #3**).
- [ ] Fase 6 (Upgrade) — Fatias 6.1–6.3.
- [ ] Fase 7 (Recomendação IA) — Fatias 7.1–7.5 (**Decisão #7, #8**).
- [ ] Fase 8 (Rollout) — Fatias 8.1–8.4.

## §33 — Bloqueadores pra vender em escala

- [!] Corrigir perda do Comigo (**Decisão #1** + Fatia 2.1).
- [ ] EntitlementService (Fase 1).
- [ ] Impedir exposição de módulos indevidos (Fatia 3.2 + 4.1).
- [~] Definir produto Clínica — F2.2 fechou o **bundle comercial** (Growth+Clínica R$3500). F3.2 fecha a estrutura Blueprint amarrando vertical `saude` → bundle default.
- [ ] Upgrade financeiro Asaas (Fase 6).
- [ ] Checkout (Fase 5).
- [ ] Aceite (Fatia 5.1 — **Decisão #2**).
- [ ] Webhook + idempotência (Fatia 5.2).
- [ ] Downgrade (Fatia 6.2 — **Decisão #9**).
- [x] 4 blueprints — F3.2 entregou **5** (moda_loja_unica, moda_rede_lojas, clinica_multiespecialidades, chaveiro_autonomo, peixaria_balcao_peso) todos v1 published + seed automático no initDb.
- [ ] Testes autorização (matriz — pós-Fase 3).
- [ ] Contratos + LGPD (**Decisão #2**).

## §34 — Vendas controladas (bridge)

- [ ] Rollout supervisionado (TOULON, peixaria, chaveiro, clínica piloto) — Fase 8.1–8.3.

## §35 — Política comercial

- [~] Labels/preços dos planos — precisam ser revisitados. Bundle Clínica (Fatia 2.2) é o primeiro exemplo.

## §36 — Resultado esperado

- [ ] Sistema responde "esta empresa pertence ao nicho X, contratou Y, tem plano Z e add-ons W. Vê só isso." Cumprido quando Fase 3 + 4 fecharem.
- [ ] Sistema recomenda "próximo plano é Growth porque..." Cumprido quando Fase 7 fechar.
- [ ] Alteração só após consentimento + confirmação pagamento. Cumprido quando Fase 5 + 6 fecharem.

## Critérios globais de aceite (validado ao FIM do projeto)

- [ ] Nenhuma tela mostra módulo fora do contrato.
- [ ] Nenhum admin liberação módulo fora do plano.
- [ ] Nenhum upgrade remove capacidade.
- [ ] IA nunca contrata sem clique.
- [ ] Todo pagamento resulta em estado consistente.
- [ ] Frontend/backend sempre concordam.
- [ ] Blueprint imutável funcionando.
- [ ] 100% dos itens do PRD marcados `[x]` com evidência aqui.
