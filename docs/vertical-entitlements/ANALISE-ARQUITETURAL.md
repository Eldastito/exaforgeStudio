# ADR-153 — Análise Arquitetural (Fase 0)

**Autor:** Claude (IA Dev).
**Data:** 2026-08-04.
**Método:** 4 agentes Explore em paralelo mapearam (i) entitlement/plan/module, (ii) subscription/checkout/Asaas, (iii) signals/recomendação/usage, (iv) onboarding/blueprint/quickstart. Este documento consolida os achados, aponta as divergências entre o PRD e o código atual, e registra ponderações técnicas.

## §1 — Sumário do que já existe

### §1.1 Verticals + módulos (o "produto operacional atual")

- **`src/server/verticals.ts`** (148 linhas) — 8 verticais (`varejo | moda | food | servicos | saude | educacao | hospitalidade | outro`). Cada uma lista módulos OPCIONAIS pré-selecionados; módulos CORE (`atendimento, contatos, relatorios, configuracoes`) são implícitos e sempre ligados.
- **`OPTIONAL_MODULES`** (L35–40): 28 módulos opcionais conhecidos.
- **`ADDON_MODULES`** (L78): `["vms","radar","prospect","clinica","retail","escola","retail_floor"]` — nunca ligados por vertical automaticamente; preservados via grandfather em `applyVertical`.
- **`PLAN_FREE_ADDONS`** (L86): `["retail","retail_floor"]` — o dono pode ligar mesmo fora do teto do plano (contra-teto explícito).
- **Atribuição da vertical** — só acontece no onboarding via `POST /api/analytics/settings/onboarding` (`routes/analytics.ts:512-531`) que chama `ModuleService.applyVertical(orgId, vertical || 'outro')`. Não há UI de "mudar a vertical" no Master Admin (única via = SQL direto).

### §1.2 Planos e limites

- **`src/server/plansGrade.ts`** (69 linhas) — 5 tiers com listas literais (não herdam via spread), cada plano com `{ai_monthly_limit, contacts_limit, channels_limit, users_limit, trial_days:30, price_annual_month, modules[]}`.
  - `AUTONOMO`: `["catalogo","agenda","vendas","pagamentos","integracoes","loja","copiloto"]` — **único que tem `copiloto`**.
  - `START`: sobrepõe totalmente, sem `copiloto`, adiciona `["campanhas","areas","diretor"]`.
  - `GROWTH`: START + `["cadencias","assinaturas","orcamentos","reservas","estudio"]`.
  - `SCALE`: GROWTH + `["compras","eventos","rie","execucao","radar","retail","valor"]`.
  - `ENTERPRISE`: SCALE + `["vms","clinica","prospect"]`.
- **Plano `cortesia`** (`db.ts:960`): todos os limites em 0, sem `modules` (⇒ `modulesForPlan` retorna `null` = "sem teto"). Usado pra convites.
- **`PlanService`** (`PlanService.ts:33-274`) é o gatekeeper único. Métodos-chave: `listPlans`, `getCurrentPlan`, `getBillingSnapshot`, `selectPlan` (1ª escolha inicia trial 30d), `setPlan` (Master Admin, sem trial/billing), `setBillingStatus` (única porta auditada para status `trialing|active|past_due|suspended|blocked|cancelled`), `aiAllowed`, `studioAllowed`, `modulesForPlan` (`plans.features.modules ∪ addons.activeModules`).

### §1.3 Módulos habilitados por org (o "3-4 camadas" real)

`ModuleService.isEnabled(orgId, moduleKey)` (`ModuleService.ts:116-129`) é a porta única. Camadas efetivas:

1. **Preset da vertical** (`verticals.ts` — wishlist inicial).
2. **Teto do plano** (`plans.features.modules ∪ org_addons.addon_key`).
3. **`organization_settings.enabled_modules`** (JSON — o que o dono ativou; interseccionado com o teto no runtime).
4. **RBAC do usuário** (`role_permissions.level`), ortogonal — checa em `enforceModulePermission` no `server.ts:446`.

Detalhe crítico da migração recente: `enabled_modules == null` mudou de "todos ligados" para "nada ligado" (comentário `ModuleService.ts:119`). Isso é por design pra forçar o onboarding a explicitar a lista — mas frontend segue (`useStore.isModuleEnabled` retorna `null → false`).

`PLAN_FREE_ADDONS` (`retail`, `retail_floor`) fura o teto do plano — mesmo em plano Autônomo, se o dono ligar `retail_floor`, o `isEnabled` devolve `true`.

Add-ons contratados (`org_addons` table, `db.ts:530-540`) estendem `modulesForPlan` — hoje sem cobrança real via Asaas (`AddonService` header L4-15 marca como beta/mock).

### §1.4 Frontend visibility

- **Sidebar** (`src/features/Sidebar.tsx`) — `mod(key) = isModuleEnabled(key) && canAccessModule(key)`. Consulta `useStore` cujos dados vêm de `GET /api/analytics/settings` (`enabled_modules`) + `GET /api/permissions/me` (`permissions/isMasterAdmin/hasProfile`).
- **Configurações › Módulos** (`SettingsView.tsx` — `ModulesPanel` L645-763) — 3 buckets (`recommended | available | upgrade`) vindos de `ModuleService.overview()`. Bucket `upgrade` renderiza cadeado com CTA "Ver planos e fazer upgrade →" (L742-763) — **sem passar por checkout real**, só leva pra Configurações › Plano.
- **Quick-Start** (`SettingsView.tsx` L786-794 + `DashboardPanel.tsx` L127-137) — cartão que aplica o `Pack` da vertical via `POST /api/quickstart/apply`.

### §1.5 RBAC (PermissionService)

- **`RBAC_MODULES`** (`PermissionService.ts:30-49`) — 28 módulos gateados. Inclui financeiros sensíveis (`financeiro`, `saude_negocio`, `empresa_proprietario`).
- **`ROUTE_MODULE`** (L63-97) — mapa segmento HTTP → módulo RBAC. **Subset** do `ModuleService.MODULE_BY_ROUTE`: add-ons como `prospect/clinic/vision/radar/retailops` ficam FORA do enforcement RBAC global (essa decisão precisa ser revisitada pelo ADR-153).
- **6 perfis semente** (owner/gerente/vendedor/estoquista/financeiro/atendente, L120-143). Fallback legacy: usuário sem `role_profile_id` cai no template equivalente do `users.role` — parque legado intacto.
- **RBAC financeiro é opt-in** (`organization_settings.rbac_finance_enabled`). O enforcement do restante também é opt-in via `hasProfile` (usuário sem perfil passa livre — L278 backend, L312 frontend).

### §1.6 Trial + billing + Asaas

- **`AsaasService`** (`src/server/AsaasService.ts` — 216 linhas) — gateway ZappFlow → lojista (SaaS charging tenant). Não confundir com `SubscriptionService.ts` (tenant → cliente final). Config única global via env (`ASAAS_API_KEY`, `ASAAS_WEBHOOK_TOKEN`).
- **Webhook** (`server.ts:1087-1100` → `AsaasService.handleWebhook`) — auth por header estático `asaas-access-token` (constant-time `safeEqual`, **NÃO é HMAC assinado**). Idempotência via `INSERT OR IGNORE INTO asaas_webhook_events`. Money-critical guard: sempre re-fetch `getPayment(payment.id)` antes de agir.
- **Eventos mapeados** (`AsaasService.ts:157-168`):
  - `PAYMENT_CONFIRMED`/`PAYMENT_RECEIVED` → `setBillingStatus("active")`.
  - `PAYMENT_OVERDUE` → `"past_due"`.
  - `PAYMENT_REFUNDED` → `"suspended"`.
  - `SUBSCRIPTION_DELETED` → `"cancelled"`.
- **Dunning ladder** (`Scheduler.dunningStage`, `Scheduler.applyDunningStage`) — 8 estágios `D-5, D-1, D+1, D+3, D+5, D+7, D+10, D+30` com notificação + gate progressivo em IA/leitura/escrita.
- **Read-only middleware** (`server.ts:359-378`) — bloqueia POST/PUT/DELETE quando `status==='blocked'` OU `billing_status IN {blocked,suspended}`. GET fica aberto ("manter visibilidade, bloquear escrita").
- **Trial → paid** — NÃO auto-converte. `trial_ends_at` é exibido mas nenhum job flipa `trialing → past_due` no vencimento. O dono precisa clicar "Ativar assinatura" manualmente pra POST em `/api/plans/billing/subscribe`.

### §1.7 O que NÃO existe hoje

Estas ausências são o núcleo do que o ADR-153 precisa criar:

- **`EntitlementService`** — não existe. Cada consumidor (menu, middleware, Configurações) faz sua própria consulta a `ModuleService` + `PermissionService`.
- **`VerticalBlueprintService`** — não existe. Nem tabela `vertical_blueprints` nem coluna `blueprint_id` em `organization_settings`. Grep de `blueprint` no repo: **zero hits**.
- **`terms_accepted_at` / `terms_version` em `organization_settings`** — não existe. Nenhuma trilha de aceite contratual pro SaaS. (Só existe `contact_consents` pra LGPD **contact-level**, não org-level.)
- **Rota `/api/billing/upgrade/{preview,confirm}`** — não existe. Trocar plano é `POST /api/plans/select` que só faz `UPDATE plan_id` (sem Asaas, sem proporcionalidade, sem aceite).
- **Cálculo de proporcionalidade** — não existe pro SaaS. Existe pra tenant-facing em `SubscriptionService.changePlan:78-110`, mas não é aplicável.
- **Master Admin subscription tooling** — nenhum botão/CLI que chame `AsaasService.subscribe` em nome do cliente. Único caminho: dono do lojista clica na tela de Configurações.
- **Motor de recomendação de plano** — grep `recommendPlan|planRecommendation|suggestUpgrade|nextPlan` = zero backend matches. Só copy estático em `SettingsView.tsx:448` ("Limite atingido. Considere fazer upgrade.").
- **Coluna `sales_recovery`-style em `business_signals` pra plano** — não existe `domain='plan'`. O tipo `SIGNAL_TYPES` do `BusinessSignalService` é aberto (free-form), mas não há publisher que popule sinais de "org perto do limite".
- **Blueprint versionado** — `OnboardingTemplateService.PACKS` (`OnboardingTemplateService.ts:58-509`) é o mais próximo, mas é hard-coded, sem versionamento, sem imutabilidade, sem override, com só 4 packs (hospitalidade/varejo/servicos/saude — food e moda não têm).

## §2 — Divergências entre PRD e código

| PRD § | Requisito | Código atual | Divergência |
|---|---|---|---|
| §3.1 | "vertical não é o produto" | `verticals.ts` = presets amplos | **Alinhado** — PRD confirma o diagnóstico. Blueprint que virará o "produto". |
| §3.2 | "Comigo se perde no upgrade" | `plansGrade.ts:16-20`: `copiloto` só em `AUTONOMO` | **Confirmado. Bug crítico.** Decisão #1 abaixo. |
| §3.3 | "Configurações mostra prateleira global" | `ModulesPanel` renderiza upgrade como cadeado | **Confirmado.** ADR-153 substitui por 3 seções + tela `Plano e Expansões` separada. |
| §3.4 | "trocar `plan_id` não é upgrade" | `PlanService.selectPlan:108` só faz `UPDATE` | **Confirmado.** ADR-153 substitui por `SubscriptionOrchestratorService`. |
| §4 (obj 8) | "verticais são presets amplos, não produtos versionados" | Nenhum conceito de Blueprint | **Confirmado. Gap grande.** ADR-153 introduz `vertical_blueprints` imutáveis. |
| §5.1 | "nenhuma tela define permissão" | Frontend consulta backend mas cada tela faz cálculo próprio (Sidebar `mod()`, ModulesPanel `overview()`) | **Parcial.** Precisa unificar em `GET /api/entitlements/me` que devolve TUDO. |
| §5.2 | "uma única fonte de verdade" | 2 mapas duplicados: `ModuleService.MODULE_BY_ROUTE` (26 entradas) + `PermissionService.ROUTE_MODULE` (18 entradas). Divergem em add-ons. | **Confirmado.** Unificar. |
| §6 | `EntitlementService` | Não existe | **Precisa criar** (F1). |
| §7 | Estados: `active/available_to_enable/hidden/available_to_buy/…` | Só existe `recommended/available/upgrade` em `ModuleService.overview` | **Precisa expandir.** Estado `hidden` é novo (nunca aparece na UI). |
| §8 | Corrigir Comigo + grade | Grade sem herança do `copiloto` | **Precisa decidir opção 1 (persistente) vs opção 2 (add-on)** — Decisão #1. |
| §9 | Vertical Blueprint com structure JSON | Nada. Só `Pack` hard-coded em `OnboardingTemplateService`. | **Precisa criar completo.** |
| §10 | 5 Blueprints iniciais (moda_loja/moda_rede/clinica/chaveiro/peixaria) | 2 orgs de referência (`org_ref_peixaria`, `org_ref_chaveiro`) via `seed-reference-autonomos.ts`, mas sem SKU/versionamento | **Proto-blueprints existem em script — extrair formato.** |
| §11 | Menu só mostra o que está `visible + active + RBAC != none` | Sidebar faz `mod()` mas com regra menos rigorosa | **Precisa refactor Sidebar pra consumir Entitlement.** |
| §12–16 | Upgrade Recommendation Engine com sinais/score/frequência/explicabilidade | Nada. Só copy estático. | **Precisa criar completo (F7).** Reusa `BusinessSignalService`, `ImpactPrioritizationService`, `DecisionActionService`, `OutcomeMeasurementService` já existentes. |
| §17 | Fluxo completo checkout → webhook → ativação | `POST /api/plans/billing/subscribe` faz só a 1ª assinatura; upgrade não tem fluxo | **Precisa criar `SubscriptionOrchestratorService` + rotas (F5).** |
| §18 | Preview + confirm + webhook | Nenhum preview de upgrade; nenhum aceite explícito | **Precisa criar.** |
| §19 | Proporcionalidade upgrade imediato vs downgrade próximo ciclo | Nada | **Precisa criar.** Sem código de referência (SubscriptionService tenant-facing usa proração diferente e não serve). |
| §22 | Falha de pagamento mantém plano anterior | Estado atual: `selectPlan` já mudou o teto ANTES da cobrança | **Precisa inverter fluxo:** só aplicar entitlement após webhook confirmar. |
| §23 | Downgrade preserva dados (`read_only`) | Não existe conceito `read_only` — módulos desligados só somem | **Precisa criar estado `read_only` no `EntitlementService`.** |
| §24 | `VerticalBlueprintService` com 10 métodos | Nada | **Precisa criar completo (F3).** |
| §25 | 6 tabelas novas (`vertical_blueprints`, `organization_blueprints`, `plan_entitlements`, `organization_entitlements`, `upgrade_recommendations`, `subscription_change_requests`) | Nenhuma existe. | **Precisa criar.** Ordem: F1 (entitlements) → F3 (blueprints) → F5 (checkout) → F6 (upgrade) → F7 (recomendação). |
| §27 | Segurança: HMAC webhook, replay, contrato versionado, LGPD, `terms_accepted_at` | HMAC não — usa token estático. `terms_accepted_at` não existe. | **Precisa ADR paralelo com jurídico** — Decisão #2. |

## §3 — Ponderações técnicas

### §3.1 EntitlementService — porta única sem quebrar 200+ call sites

O PRD diz "unificar em uma única decisão de entitlement" (§4/§5.2/§6). Grep de `isEnabled(` no repo dá >100 hits em backend + frontend. **Reescrever tudo de uma vez é ruptura enorme.** Estratégia proposta:

- Fase 1: cria `EntitlementService.check(orgId, userId, resource, action)` como **wrapper composto** por dentro chamando `ModuleService.isEnabled` + `PermissionService.can` + `AddonService.isActive` + (futuro) `Blueprint.hides`.
- Novos consumidores usam `EntitlementService` direto.
- Call sites antigos continuam chamando `ModuleService.isEnabled` — este passa a **delegar** internamente pro `EntitlementService.check` (encapsulamento reverso).
- Migração gradual: cada fatia futura substitui um bloco de call sites por consulta única a `/api/entitlements/me`.

Isso permite que a Fase 1 seja aditivo puro, sem regressão.

### §3.2 Comigo persistente vs add-on (Decisão #1)

Duas opções analisadas:

**Opção A — Comigo persistente em todos os planos.**
- Prós: menos código, sem UI de contratação; dono nunca perde por upgrade. Padrão "produto base."
- Contras: nada perde comercialmente (é R$0 no add-on hoje).

**Opção B — Comigo vira add-on obrigatório (grandfathering).**
- Prós: comercialmente flexível; se um dia quiser cobrar, o modelo já está no lugar; separa "quem usa balcão" de "quem não usa".
- Contras: mais complexidade; upgrade precisa checar add-on ativo E migrar.

**Recomendação:** Opção A. Menor regressão, resolve o risco identificado, e o modelo add-on já existe pra outras coisas. Se um dia cobrar por Copiloto virar necessidade comercial, é mudança futura.

### §3.3 Blueprint imutável — como mudar preset da Clínica sem quebrar orgs vivas

Blueprint publicado é imutável (§24.1 do PRD). Correção = nova versão + assign explícito.

Cenário: `clinica_multiespecialidades_v1` é lançado com `optionalModules=[campanhas,execucao]`. 3 meses depois surge o pedido de incluir `vms`. Solução:

- Cria `clinica_multiespecialidades_v2` com `optionalModules=[campanhas,execucao,vms]`.
- Orgs existentes ficam em v1 até serem migradas explicitamente.
- Master Admin ganha rota `POST /api/admin/organizations/:id/blueprint/upgrade` que faz preview do diff (novo módulo `vms` fica `available_to_enable`; nenhuma remoção; nada muda em `enabled_modules`).
- Dono do lojista aprova via clique único ou o Master Admin força.

### §3.4 Assinatura Asaas — recriar vs update

Asaas permite `POST /subscriptions/{id}` (PUT-like) pra alterar valor. Mas trocar plano frequentemente = mudar `value` + `nextDueDate` no meio do ciclo. **Estratégia proposta:**

- Upgrade imediato: cancela subscription atual + cria nova com valor cheio novo, cobrança proporcional é PAGAMENTO ÚNICO à parte (POST `/payments` com `value=diff`, `dueDate=today+3`).
- Isso deixa o audit trail explícito (2 registros ao invés de 1 mutado).
- Downgrade: agenda `PUT /subscriptions/{id}` com o novo `value` + `nextDueDate=periodEnd`. Aplica no fim do ciclo.

Alternativa: aproveitar `SubscriptionService` (tenant-facing) como modelo — mas ele opera em outro domínio (lojista → cliente final). Manter separado.

### §3.5 Recomendação usando o pipeline ADR-136 (BusinessSignal + Impact + DecisionAction)

Todo o encanamento existe. Só precisa novo `domain='plan'` + novo publisher:

- `PlanFitDetectorService` (puro) — scanner idempotente por org, análogo ao `SalesStalledDealDetectorService`, roda no `Scheduler.slowPass`.
- `PlanFitSignalPublisher.run(orgId)` — segue padrão do `ClinicRenewalTaskService.run` (publish + sweep resolve por dedupe_key).
- Sinais: `plan_near_limit_ai`, `plan_near_limit_channels`, `plan_near_limit_contacts`, `plan_near_limit_users`, `plan_module_gap_<key>`, `plan_capacity_bottleneck`. `dedupe_key = plan:near_limit:${key}:${YYYY-MM}` (uma vez por mês).
- Adiciona entradas em `ImpactPrioritizationService.ACTION_MAP` → `{actionType: 'propose_upgrade', label: 'Considerar plano X'}`.
- Adiciona `plan: 0.9` em `STRATEGIC` (senão signals de plano rankeiam abaixo de tudo).

Isso reusa `/api/insights` + `/api/business/priorities` + `/api/actions` sem duplicação. A nova aba **"Plano e Expansões"** no ExecutiveView filtra `domain=plan`.

### §3.6 Trial → past_due automático

Gap identificado: nenhum job flipa `billing_status` no vencimento do trial. Solução: novo `Scheduler.trialExpiryPass()` que roda diariamente e, pra cada org com `billing_status='trialing' AND trial_ends_at < now()`, faz `setBillingStatus(orgId, 'past_due', {reason: 'trial_expired_no_conversion'})`. Isso desativa IA (via `aiAllowed`) mas mantém leitura. Após 30d em past_due entra na dunning ladder normal.

### §3.7 `MODULE_BY_ROUTE` × `ROUTE_MODULE` — unificação sem regressão

Os dois mapas divergem propositalmente hoje: `PermissionService.ROUTE_MODULE` omite add-ons (`prospect/clinic/vision/radar/retailops`) porque o RBAC granular pra esses módulos só é aplicado dentro do próprio módulo, não no roteamento global. **A unificação precisa preservar essa distinção** — proposta:

```ts
// EntitlementService.checkRoute(orgId, user, segment, method)
// Retorna:
// - {allowed: true, source: 'module_off'} se o módulo do segmento não está ligado
// - {allowed: true, source: 'rbac_gate_module'} se o módulo está no RBAC granular
// - {allowed: false, ...} caso contrário
```

O consumidor (middleware `enforceModulePermission`) fica trivial e a divergência atual é modelada explicitamente em vez de implicitamente.

### §3.8 Bundle Clínica — como vender Growth+Clínica sem confundir com Growth puro

Duas apresentações no checkout:

- "Growth" (R$X/mês, sem Clínica) — plano genérico.
- "Growth + Clínica Bundle" (R$X + R$Y/mês, com Clínica incluída) — o SKU comercial da vertical `saude`.

Implementação: bundle = `{planId: 'growth', addons: ['clinica']}` no `SubscriptionOrchestratorService`. Blueprint `clinica_multiespecialidades_v1` já traz esse bundle como default (`defaultPlan: 'growth'`, `requiredModules: [...,'clinica']`).

### §3.9 Read-only por downgrade

PRD §23: "Módulos removidos não deverão apagar dados. Devem ficar `read_only`."

Implementação sugerida: novo `organization_entitlements` row com `resource_key='clinica'`, `source_type='downgrade_freeze'`, `status='read_only'`, `starts_at=downgrade_effective_at`. `EntitlementService.check(orgId, user, 'clinica', 'read')` devolve `allowed: true, visibility: 'visible', reason: 'downgrade_read_only'`; qualquer `action != 'read'` devolve `allowed: false`.

Sidebar renderiza item com badge "Somente leitura — reative o plano X para editar". Middleware bloqueia POST/PUT/DELETE das rotas do módulo.

## §4 — Convergência com o resto do repo

- **Reusa 100% do padrão ADR-136 (signals + actions + outcomes)** pra recomendação de plano. Nada de motor paralelo.
- **Reusa `AsaasService`** pra checkout (não recria PSP).
- **Reusa `OnboardingTemplateService.PACKS`** como base semântica de `quickStartPack` dos Blueprints (empacota `areas + cadences + automations + faq` — vira o "config_json" do blueprint).
- **Reusa `ImpactPrioritizationService.ACTION_MAP`** — só adiciona entradas.
- **Reusa `ComigoArchetypeService`** pra `archetype` como campo do Blueprint.
- **Reusa padrão TOULON** (`pilot-retail-floor.cli.ts`, `pilot-runtime.cli.ts`) pra CLI de rollout de Blueprint quando F3 estiver pronto.

## §5 — Riscos técnicos identificados

| Risco | Severidade | Mitigação |
|---|---|---|
| `enabled_modules == null` mudou semântica; orgs pré-onboarding ficam sem módulos | Alto (já materializado) | `applyVertical('outro')` no signup — mas `signup` (`auth.ts:139-142`) NÃO chama. Precisa validar se onboarding-pending já ficam com menu vazio (visualmente pode assustar). |
| Webhook Asaas usa token estático, não HMAC | Médio | Aceitável pra beta, mas ADR-153 F5 deve migrar pra HMAC assinado + adicionar `terms_accepted_at`. |
| Nenhum job flipa trial → past_due | Alto | F5 adiciona `trialExpiryPass`. |
| `ModuleService.enableModule` já expande `enabled_modules` a partir do preset da vertical se `null` — pode surpreender o dono | Baixo | Documentar em `/api/analytics/settings` response que o resultado depende do onboarding aplicado. |
| Divergência `ROUTE_MODULE` vs `MODULE_BY_ROUTE` | Médio | §3.7 acima. |
| Blueprint imutável exige disciplina — cada mudança = nova versão + migração | Médio | Master Admin ganha rota de migração de versão com preview de diff. |
| Recomendação IA pode virar spam se `frequency_control` falhar | Alto (LGPD/UX) | G-153-6 duro: score ≥60 + sem rejeição 30d + org não em incidente. Auditoria de cada exibição. |
| Terms of Service versionado exige jurídico | Alto (compliance) | Decisão #2 — externa ao código. |
| Migração de add-ons hoje (mock) pra add-ons pagos via Asaas | Médio | Fatia dedicada em F5. |
| Downgrade não pode apagar dados de módulos removidos | Alto (compliance + confiança) | `EntitlementService` gerencia estado `read_only`; middleware bloqueia writes; frontend renderiza badge. |

## §6 — O que NÃO está no escopo desta ADR

- Migração de PSP (Stripe/Chargebee) — fora.
- Faturamento internacional / múltiplas moedas — fora.
- Marketplace de módulos de terceiros — fora.
- Split de receita (parceiros vendem por dentro do ZappFlow) — fora.
- Portal do cliente Asaas embutido — fora (fica com Asaas UI mesmo).
- Cobrança por consumo real de IA (metered pricing) — fora; mantém teto mensal por plano.
