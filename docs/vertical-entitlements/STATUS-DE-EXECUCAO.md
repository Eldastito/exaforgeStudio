# ADR-153 — Status de execução

Log operacional das fatias do plano. Cada sessão adiciona 1 entrada.

---

## Fase 0 — Auditoria + PRD + Análise + Plano

### Sessão 2026-08-04 (Fase 0)

- **Fase:** 0 (só documentação — nenhum código produtivo).
- **Itens executados:**
  1. Reset da branch pra `origin/main` (pós-merge #770 — F4d.1 do ADR-152).
  2. 4 agentes Explore em paralelo mapearam o codebase por domínio: (a) entitlement/plan/module/vertical/RBAC; (b) subscription/checkout/Asaas/billing; (c) signals/decision-actions/usage/recomendação; (d) onboarding/quick-start/blueprint (que não existe).
  3. Consolidação dos 4 relatórios em documentos operacionais.
  4. Escrita do PRD verbatim (§1–§37) + ADR-153 (decisão + guardrails) + Análise Arquitetural (divergências PRD × código + ponderações técnicas) + Plano de Implementação (28 fatias em 8 fases) + Decisões Pendentes (10 pontos) + Matriz de Cobertura.
- **Arquivos criados:**
  - `docs/prd/PRD-VERTICAL-ENTITLEMENTS-ASSINATURAS.md` (PRD do dono, verbatim).
  - `docs/adr/ADR-153-vertical-entitlements-assinaturas-upgrade.md` (decisão + 7 guardrails).
  - `docs/vertical-entitlements/ANALISE-ARQUITETURAL.md` (5 seções — sumário do que existe, divergências, ponderações, convergência, riscos).
  - `docs/vertical-entitlements/PLANO-DE-IMPLEMENTACAO.md` (28 fatias em 8 fases + dependências).
  - `docs/vertical-entitlements/DECISOES-E-PENDENCIAS.md` (10 decisões do dono do produto agrupadas em 4 seções).
  - `docs/vertical-entitlements/STATUS-DE-EXECUCAO.md` (este documento).
  - `docs/vertical-entitlements/MATRIZ-DE-COBERTURA-DO-PRD.md` (item-by-item de §7 a §36 do PRD com status atual).
- **Arquivos alterados em `src/**`:** nenhum (Fase 0 = só documentação, conforme §32 do PRD e padrão do repo).
- **Testes executados:** nenhum (Fase 0 não altera código executável).
- **Resultado:** Fase 0 completa — 7 documentos persistidos no repo. Todo o encanamento pra Fase 1 mapeado. Divergências entre PRD e código enumeradas em `ANALISE-ARQUITETURAL.md §2`. 10 decisões pendentes do dono documentadas — Decisões #1 (Comigo) e #2 (ToS) bloqueiam duro; #4 (nomes de Blueprint) e #5 (bundle Clínica) bloqueiam F3; #3 (HMAC) é fatia adjacente à F5.
- **Pendências criadas:** as 10 decisões do §DECISOES-E-PENDENCIAS.md. Cada uma linkada com as fatias bloqueadas.
- **Próximo passo:** aguardar aprovação do dono nas Decisões #1, #2, #3, #4, #5, #9 (as com prioridade Alta/Máxima) antes de iniciar F1. **Alternativa mínima:** aprovar #1 (Comigo persistente) + começar F1.1 (EntitlementService aditivo puro) — F1 inteira não depende de nenhuma outra decisão porque é infraestrutura de leitura.

---

### Sessão 2026-08-04 (Fatia 1.1 — EntitlementService)

- **Fase:** 1 (EntitlementService — porta única de entitlement, aditivo puro).
- **Decisão aprovada nesta sessão:** #1 (Comigo persistente — implementação vem na F2.1).
- **Itens executados:** todos os 4 da Fatia 1.1 (novo `EntitlementService` compondo `ModuleService.isEnabled` + `PlanService.modulesForPlan` + `PermissionService.levelFor` + `AddonService.isActive`, 3 rotas GET, teste E2E de 47 checks, wiring em server.ts).
- **Arquivos criados:**
  - `src/server/EntitlementService.ts` — método `check(orgId, user, resource, action) → EntitlementDecision` com 7 estados (`active | available_to_enable | available_to_buy | hidden | suspended | deprecated | pilot_only`); método `overview(orgId, user)` (mapa completo CORE + OPTIONAL); método `checkRoute(orgId, user, segment, method)` compatível com `PermissionService.checkRouteAccess`.
  - `src/server/routes/entitlements.ts` — 3 rotas GET (`/me`, `/modules`, `/resource/:key?action=...`).
  - `scripts/test-entitlement-service.ts` — **47/47 checks** cobrindo os 17 casos documentados no header do teste (core, plan+ligado, plan+não-ligado, fora do plano com upgrade coerente, fora do plano com add-on, hidden por vertical, master admin bypass, RBAC=none esconde, RBAC=read não faz execute, fallback legacy, billing blocked/cancelled/past_due/suspended, isolamento multi-tenant, overview completo, checkRoute compatível, add-on ativo faz virar active).
- **Arquivos alterados:**
  - `server.ts` — 1 import + 1 mount `/entitlements` (aditivo puro; nenhum consumer atual é migrado — F1.2/F1.3 fazem isso).
  - `package.json` — script `test:entitlement-service`.
  - `docs/vertical-entitlements/DECISOES-E-PENDENCIAS.md` — Decisão #1 marcada aprovada.
- **Testes executados:**
  - `npm run test:entitlement-service` → **47/47 OK**.
  - Regressão zero: `test:rbac-granular` (27/27), `test:vertical-plan-intersection` (19/19), `test:addons` (13/13), `test:rbac-enforcement` (15/15).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) `HIDDEN_BY_VERTICAL` estático dentro do service — F1.4 substitui por `blueprint.hiddenModules` da F3. Só marca hidden o que é obviamente incoerente (`clinica`/`escola` em nichos que não pertencem).
  - (ii) `available_to_buy` distingue **upgrade** de **add-on** — se add-on está no `ADDON_CATALOG` do plano corrente, `addonPrice != null`; caso contrário, `upgradeTargetPlan` aponta pro tier mais próximo que inclui o resource.
  - (iii) Master Admin (`user.email === MASTER_ADMIN_EMAIL`) bypassa gating por design (ADR-106). Vê tudo, inclusive `hidden`. Reason=`master_admin` pra auditoria distinguir.
  - (iv) Billing precedence: `blocked | cancelled` bloqueia até escrita CORE + read fica preservado pra dono ver o que tem. `suspended | past_due` bloqueia só escrita.
  - (v) RBAC=none em recurso coberto pelo plano vira `visibility=hidden` — dono do lojista com RBAC forte esconde do funcionário sem permissão via UI.
  - (vi) `enable` e `buy` exigem `full` (dono/gerente com full). `execute` exige `write`. `use`/`view` exigem `read`. Segue o mesmo `ACTION_MIN` do `PermissionService`.
- **Cross-service:** ADITIVO PURO — nenhum service pré-existente foi modificado. F1.2 (próxima fatia) migra `enforceModulePermission` no `server.ts` pra chamar `EntitlementService.checkRoute` em vez do encanamento atual (mantendo compat).
- **Resultado:** Porta única de decisão de entitlement no ar, atrás de 3 rotas GET-only. Consumidor pode consultar `/api/entitlements/me` e receber mapa completo `{resource: EntitlementDecision}` sem precisar combinar `/api/analytics/settings` + `/api/permissions/me` + `ModuleService.overview`. Menu, middleware, tela de Módulos e futuro motor de recomendação (F7) terão a mesma fonte.
- **Pendências criadas:** nenhuma nova. Decisão #1 (Comigo) aprovada, mas a implementação em `plansGrade.ts` fica pra Fatia 2.1 (correção da grade).
- **Próximo passo:** F1.2 — migra o middleware `enforceModulePermission` (`server.ts:446`) pra consumir `EntitlementService.checkRoute` em vez do encanamento atual. Sem quebrar nenhum call site (backward-compat via delegação interna). Aguardando aprovação.

---

### Sessão 2026-08-04 (Fatia 1.2 — middleware consome EntitlementService)

- **Fase:** 1 (continua — porta única de decisão), Fatia 1.2 (`server.ts:436` migrado).
- **Itens executados:** todos os 3 da Fatia 1.2 (novo `EntitlementService.isModuleAvailable`, migração do middleware do `server.ts`, teste da via HTTP simulada).
- **Arquivos criados:**
  - `scripts/test-entitlement-middleware.ts` — **29/29 checks** cobrindo os 12 casos do header (segmento fora do mapa, sem organizationId, module ligado, module off, plan_ceiling, add-on ativo abre teto, PLAN_FREE_ADDONS, `enabled_modules=NULL`, billing blocked NÃO afeta este gate, isolamento cross-tenant, orgs virgens, `isModuleAvailable` direto).
- **Arquivos alterados:**
  - `src/server/EntitlementService.ts` — novo método `isModuleAvailable(orgId, moduleKey)` retornando `{available, reason, state}`. Aditivo puro — não altera comportamento existente.
  - `server.ts` — import + middleware (`server.ts:436`) troca `ModuleService.isEnabled` direto pelo `EntitlementService.isModuleAvailable`. Response 403 ganha `reason` (`module_off` vs `plan_ceiling`) + `state` (`available_to_enable` vs `available_to_buy`) SEM remover `error: "module_disabled"` + `module` (backward compat total).
  - `package.json` — script `test:entitlement-middleware`.
- **Testes executados:**
  - `npm run test:entitlement-middleware` → **29/29 OK**.
  - Regressão zero: `test:entitlement-service` (47/47), `test:rbac-granular` (27/27), `test:vertical-plan-intersection` (19/19), `test:addons` (13/13), `test:rbac-enforcement` (15/15).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **`isModuleAvailable` NÃO checa billing** — se checasse aqui, GETs em orgs `blocked/suspended` retornariam 403 e regrediria a política ADR-091 "manter visibilidade, bloquear escrita" que o read-only middleware do `server.ts:359-378` já cumpre. Billing fica com o middleware de escrita, este gate segue puramente lógico do módulo.
  - (ii) **`isModuleAvailable` NÃO checa RBAC** — o middleware de módulo é ORG-level (2ª camada do enforcement é o `enforceModulePermission` já existente com finance-opt-in + audit — F1.2 NÃO toca nele; migração dele fica pra fatia futura se surgir demanda).
  - (iii) **Distinguir `module_off` vs `plan_ceiling`** — se módulo está no plano mas dono não ligou → dono é a solução (frontend mostra toggle). Se não está no plano → dono não tem solução sem comprar (frontend mostra upgrade). Ambos hoje davam a mesma resposta `module_disabled`; F1.2 diferencia sem quebrar consumidores antigos.
  - (iv) **Backward compat total** — `error: "module_disabled"` + `module` intactos. `reason` e `state` são ADITIVOS. Zero consumidor precisa mudar.
  - (v) **Delegação canônica pra `ModuleService.isEnabled`** — se o gate liga, ambos concordam. `isModuleAvailable` só desce mais fundo pra explicar por que NÃO liga. Comportamento é idêntico ao anterior (`test:vertical-plan-intersection` + `test:addons` + `test:rbac-granular` passam intocados).
- **Cross-service:** `ModuleService.isEnabled` continua funcional em TODOS os call sites (Sidebar, ModulesPanel, useStore, requirePermission, routes/plans.ts, etc.). Nenhum consumer atual foi migrado. `enforceModulePermission` (2º middleware) intacto. F1.3 migra o frontend (useStore) pra chamar `/api/entitlements/me`.
- **Resultado:** Middleware unificou "quem decide se módulo está disponível" na porta canônica `EntitlementService.isModuleAvailable`. Frontend pode agora ler `reason` do 403 pra escolher UX (toggle vs upgrade). Zero regressão em produção.
- **Pendências criadas:** nenhuma nova. Migração do 2º middleware (`enforceModulePermission`) fica pra futuro se surgir demanda — não bloqueia F2 (correção Comigo) nem F3 (Blueprints).
- **Próximo passo:** F1.3 — migra o frontend (`useStore.loadOrgConfig` + `loadPermissions`) pra consumir `/api/entitlements/me` em vez de compor localmente `ModuleService` + `PermissionService`. Sidebar + `ModulesPanel` (Configurações) passam a exibir 3 seções segundo os estados. Independe de novas decisões do dono.

---

### Sessão 2026-08-04 (Fatia 1.3 — frontend consome /api/entitlements/me)

- **Fase:** 1 (continua), Fatia 1.3 (frontend consumindo fonte única).
- **Itens executados:** todos os 4 da Fatia 1.3 (backend estendido, useStore consumindo `/api/entitlements/me`, ModulesPanel com 3 seções, placeholder da aba "Plano e Expansões").
- **Arquivos alterados:**
  - `src/server/routes/entitlements.ts` — `GET /me` ganha bloco `meta` com `{isMasterAdmin, hasProfile, falatuEnabled, vertical, planId, defaultLandingView, permissions}` (fonte única no payload).
  - `src/store/useStore.ts` — novo tipo `EntitlementDecision`, novo state `entitlements`, nova action `loadEntitlements()`. `loadOrgConfig` e `loadPermissions` viram DELEGATES pra `loadEntitlements`. `isModuleEnabled` e `canAccessModule` derivam de `entitlements` quando disponível (fallback pro legado).
  - `src/features/SettingsView.tsx` — `ModulesPanel` consome `/api/entitlements/me`. 3 seções: **Seus recursos** (`state=active`), **Disponíveis no seu plano** (`state=available_to_enable`), **Expansões recomendadas** (`state=available_to_buy` — link colapsado pra nova aba). Estado `hidden` não aparece. Nova aba **Plano e Expansões** com `PlanoExpansoesPlaceholder` (F4.2 preenche).
  - `scripts/test-entitlement-service.ts` — 2 checks novos cobrindo `source.vertical` + `source.plan`.
  - `package.json` — script `test:entitlements-me`.
- **Arquivos criados:**
  - `scripts/test-entitlements-me.ts` — **25/25 checks** cobrindo payload da rota: `entitlements` + `meta` (isMasterAdmin, hasProfile, falatuEnabled, vertical, planId, defaultLandingView, permissions), cross-tenant isolation, todos os 4 estados principais (`active`, `available_to_enable`, `available_to_buy`, `hidden`), master admin bypass.
- **Testes executados:**
  - `npm run test:entitlements-me` → **25/25 OK** (nova suíte).
  - `npm run test:entitlement-service` → **49/49 OK** (+2 checks de F1.3).
  - `npm run test:entitlement-middleware` → **29/29 OK** (regressão).
  - `npm run test:rbac-granular` (27/27), `test:vertical-plan-intersection` (19/19), `test:addons` (13/13), `test:rbac-enforcement` (15/15).
  - `npx tsc --noEmit` → limpo (frontend + backend).
- **Decisões micro:**
  - (i) **`loadOrgConfig` e `loadPermissions` viram delegates de `loadEntitlements`** em vez de removidos. Motivo: callers antigos (App.tsx faz `loadOrgConfig() + loadPermissions()` no login; SettingsView chama `loadOrgConfig` após alterar módulos) continuam funcionando sem alteração. Zero risco de quebrar tela por chamada dupla — só faz 1 request pra `/api/entitlements/me` em vez de 2.
  - (ii) **`isModuleEnabled` e `canAccessModule` mantêm fallback legado** — se `entitlements` ainda é `null` (loader não rodou), usam os arrays antigos (`enabledModules`, `permissions`). Isso protege sub-componentes que renderizam antes do loader terminar.
  - (iii) **ModulesPanel: 3 seções em vez de 3 categorias** — antes `recommended | available | upgrade` do backend `overview()`; agora `active | available_to_enable | available_to_buy` do EntitlementService. Estado `hidden` sai (não é mostrado — é o que a vertical/blueprint esconde). Estado `available_to_buy` vira link colapsado pra "Plano e Expansões" — evita clutter no editor de módulos.
  - (iv) **Placeholder da nova aba `Plano e Expansões`** — só um card "em construção (F4.2)" com link cruzado pra Módulos e Cobrança. Registra a aba no menu pra a mudança de UX ser aditiva já em F1.3 (dono já vê o layout novo, F4.2 preenche o conteúdo com comparação de plano + add-ons + recomendação IA).
  - (v) **`MODULE_META` duplicado no frontend** — labels/descrições dos módulos hoje vivem em `ModuleService.MODULE_META` (backend). Adicionamos cópia no frontend porque a rota `/api/entitlements/me` não devolve metadados por módulo (só decisão). Trade-off aceitável: em fatia futura o backend pode expor `meta.moduleMeta` pra virar single source. Por ora manter duplicado é mais barato que expandir o payload.
  - (vi) **`ADDON_MODULES` também duplicado no frontend** — mesmo motivo. Se mudar no backend, atualizar aqui.
- **Cross-service:** frontend agora tem 1 rota consumida (`/api/entitlements/me`) em vez de 2 (`/api/analytics/settings` + `/api/permissions/me`). Consumidores intermediários (`ModulesPanel`, `Sidebar`) leem do store. Zero breaking. Backend `EntitlementService.overview` estava OK; só a rota `/me` ganhou `meta`.
- **Resultado:** Fonte única de verdade dos entitlements no frontend. Menu, Configurações › Módulos, futuros consumidores (aba "Plano e Expansões" F4.2, motor de recomendação F7) chegam ao store e leem do mesmo objeto. Zero regressão em produção — telas antigas continuam funcionando; sub-componentes veem apenas dados mais ricos.
- **Pendências criadas:** nenhuma nova. Duplicação de `MODULE_META`/`ADDON_MODULES` fica pra fatia futura (não bloqueia F2/F3).
- **Próximo passo:** F1.4 — implementar estado `hidden` de verdade via `blueprint.hiddenModules`. Hoje `HIDDEN_BY_VERTICAL` é estático dentro do `EntitlementService.ts` (F1.1). F1.4 substitui pelo mapa vindo do Blueprint (F3 é pré-requisito da versão final; F1.4 pode adiantar com blueprint mock/estático mais rico). Alternativa: iniciar F2 (correção grade + Comigo persistente — Decisão #1 já aprovada). **Recomendo F2.1 (Comigo persistente)** — decisão aprovada, alto impacto, baixo esforço.

---

### Sessão 2026-08-04 (Fatia 2.1 — Comigo persistente em todos os planos)

- **Fase:** 2 (correção da grade). Fatia 2.1 fecha a Decisão #1 aprovada.
- **Bug bloqueante resolvido:** PRD §3.2 — upgrade Autônomo→Start removia silenciosamente o `copiloto` (balcão de peixaria/chaveiro). Violação clara de G-153-2 ("upgrade nunca remove capacidade"). Depois desta fatia, `copiloto` está em todos os 5 tiers.
- **Itens executados:** 3 mudanças de código + 3 testes atualizados/criados + docs.
- **Arquivos alterados:**
  - `src/server/plansGrade.ts` — `START = [...AUTONOMO, "campanhas", "areas", "diretor"]` (antes era lista literal sem `copiloto`). Comentário do header atualizado explicando a decisão e a motivação (Decisão #1 aprovada). Cascade `GROWTH`/`SCALE`/`ENTERPRISE` via spread garante propagação.
  - `src/server/ModuleService.ts` — descrição do `copiloto` atualizada (removido "Exclusivo do plano Autônomo", agora "Disponível em todos os planos (ADR-153 F2.1)").
  - `src/features/ComigoView.tsx` — header do arquivo atualizado (removido "do plano Autônomo").
  - `scripts/test-comigo-module.ts` — asserção antiga "plano Start NÃO inclui copiloto" invertida; agora loop de 5 tiers valida presença em todos.
  - `scripts/test-plans-migration.ts` — asserção "copiloto é exclusivo do Autônomo" invertida ("copiloto está em TODOS os planos").
  - `package.json` — scripts `test:comigo-preserved-on-upgrade` e `test:upgrade-matrix`.
- **Arquivos criados:**
  - `scripts/test-comigo-preserved-on-upgrade.ts` — **16/16 checks** cobrindo: PLAN_GRADE inclui copiloto em todos os 5 tiers; peixaria (varejo, autonomo) mantém copiloto após upgrade pra start/growth/scale/enterprise; chaveiro (servicos, autonomo→growth) idem; org sem copiloto em enabled_modules NÃO ganha por upgrade (available_to_enable); master admin bypass.
  - `scripts/test-upgrade-matrix.ts` — **93/93 checks** cobrindo matriz completa `origem × destino` (10 pares de upgrade) × cada módulo da origem: nenhum é removido no upgrade. Sanity checks pros módulos "topo" (vms/clinica/prospect só em enterprise; valor/retail só em scale+). Downgrade documentado como REMOÇÃO esperada (F6.2 vai fazer read_only).
- **Testes executados:**
  - `npm run test:upgrade-matrix` → **93/93 OK** (matriz PRD §8.3).
  - `npm run test:comigo-preserved-on-upgrade` → **16/16 OK**.
  - `npm run test:comigo-module` → **32/32 OK** (asserções invertidas).
  - `npm run test:plans-migration` → **24/24 OK** (asserção invertida).
  - Regressão zero: `test:entitlement-service` (49/49), `test:entitlement-middleware` (29/29), `test:entitlements-me` (25/25), `test:vertical-plan-intersection` (19/19), `test:addons` (13/13), `test:rbac-granular` (27/27), `test:rbac-enforcement` (15/15), `test:falatu-rollout` (24/24).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Herança via spread** — `START = [...AUTONOMO, ...]` em vez de lista literal. Motivação: se `AUTONOMO` receber outro módulo no futuro, os superiores herdam automaticamente (idem a regra do PRD §8.2 "entitlements do destino ≥ entitlements do novo plano"). Aditivo puro.
  - (ii) **Não fizemos "grandfathering explícito"** — a Decisão #1 escolheu Opção A (persistente em todos os tiers) em vez de Opção B (add-on preservado). Isso torna a política mais simples: nenhuma tabela de "concessão comercial explícita" é necessária pra copiloto (pode surgir se algum dia cobrarmos por ele avulso, mas isso é F futuro se surgir demanda).
  - (iii) **Frontend copy atualizado no ComigoView** — o texto de introdução mencionava "plano Autônomo" como se fosse exclusivo. Agora indica que o módulo está disponível em todos.
  - (iv) **`test-upgrade-matrix.ts` é PURO** — não sobe banco, só compara os arrays de `PLAN_GRADE`. Roda em <100ms. Detecta regressão em qualquer alteração futura da grade.
  - (v) **Downgrade documentado como remoção esperada** — o teste 6 de `test-upgrade-matrix.ts` confirma que downgrade enterprise→autonomo REMOVE módulos (comportamento correto do teto do plano). F6.2 vai transformar essa remoção em `state=read_only` pra preservar dados (Decisão #9 aprovada, 30d de carência).
- **Cross-service:** aditivo puro no backend + copy no frontend. `PlanService.selectPlan`, `PlanService.setPlan`, `ModuleService.isEnabled`, `EntitlementService.check` — todos continuam funcionando idênticos, só que agora o teto do plano superior inclui `copiloto`.
- **Resultado:** Bug crítico do PRD resolvido. Peixaria/chaveiro que hoje usam Comigo podem migrar pra Start/Growth/Scale sem perder o balcão. Fase 2 do plano avança 50% (F2.2 restante: bundle Clínica no catálogo).
- **Pendências criadas:** nenhuma nova. Decisão #1 aprovada e implementada; grade agora coerente com política de upgrade.
- **Próximo passo:** F2.2 — bundle Clínica no catálogo de planos. Decisão #5 já aprovada (Growth + add-on Clínica). Alternativa: iniciar F1.4 (estado hidden real via mock estático de blueprint) ou F3.1 (fundação Blueprints).

---

### Sessão 2026-08-04 (Fatia 2.2 — Bundle Clínica no catálogo)

- **Fase:** 2 (correção da grade — última fatia). Fecha a Decisão #5 aprovada.
- **Correção comercial resolvida:** PRD §10.3 identificou o mismatch — módulo Clínica só existe no Enterprise, mas o público-alvo (clínicas multiespecialidade médias) não paga Enterprise. Bundle `growth_clinica` (Growth base + addon Clínica) resolve pra vertical `saude` com desconto de 27% vs comprar avulso.
- **Itens executados:** 3 (adição de PLAN_BUNDLES + rota + teste). Aditivo puro.
- **Arquivos alterados:**
  - `src/server/plansGrade.ts` — novo tipo `PlanBundle` + constante `PLAN_BUNDLES` com bundle `growth_clinica` (basePlan=growth, addons=[clinica], priceMonthly=3500, priceAnnualMonth=2997, verticalHints=[saude], bundleDiscount={avulsoTotal:4797, savingsMonthly:1297, savingsPercent:27}).
  - `src/server/routes/plans.ts` — nova rota `GET /api/plans/bundles` devolvendo `{bundles: PLAN_BUNDLES}`. Não altera `GET /api/plans` (que continua devolvendo array pra backward compat com LoginView, AdminMasterView, SettingsView).
  - `package.json` — script `test:plan-bundles`.
- **Arquivos criados:**
  - `scripts/test-plan-bundles.ts` — **28/28 checks** cobrindo: PLAN_BUNDLES exportado + shape (11 campos obrigatórios), bundle growth_clinica presente com dados corretos, basePlan válido em PLAN_GRADE, addons válidos em ADDON_CATALOG, verticalHints não-vazio, bundleDiscount consistente (avulsoTotal - priceMonthly = savingsMonthly), priceMonthly < avulsoTotal (é desconto real), rota `/bundles` devolve `{bundles: [...]}`, PLAN_GRADE continua funcional (backward compat), sem duplicatas em key, plano anual ≤ mensal.
- **Testes executados:**
  - `npm run test:plan-bundles` → **28/28 OK**.
  - Regressão zero: `test:upgrade-matrix` (93/93), `test:comigo-preserved-on-upgrade` (16/16), `test:plans-migration` (24/24), `test:addons` (13/13).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Rota separada `/api/plans/bundles`** em vez de expandir `/api/plans` — o response de `/api/plans` é ARRAY (`Plan[]`) e 3 consumidores (LoginView, AdminMasterView, SettingsView) usam `Array.isArray(d) ? d : []`. Mudar pra objeto quebraria silenciosamente (retornariam array vazio, sem planos na UI). Rota nova é aditivo puro, zero risco.
  - (ii) **Bundle `growth_clinica` com preço R$3500** — hoje avulso seria: Growth R$1797 + addon Clínica R$3000 (escala) = R$4797. Bundle preço R$3500 = 27% de desconto. Preço final é ajustável pelo Master Admin via `plans` table quando F5 ligar o checkout real. Fonte: Decisão #5 aprovada + regra ADR-091 §112 (anti-canibalização — bundle competitivo vs comprar avulso).
  - (iii) **`bundleDiscount` embutido no objeto** pra UX no checkout — dono vê "R$3500/mês (economia de R$1297)" sem o frontend precisar recalcular. Testado que os 3 valores são consistentes (avulsoTotal - priceMonthly = savingsMonthly).
  - (iv) **`verticalHints` guia o onboarding** — `growth_clinica.verticalHints = ['saude']`. Quando F3.2 (Blueprints) + F8 (rollout) chegarem, o wizard vai recomendar bundle quando dono escolher vertical saude. Fatia atual só expõe o dado; consumidor vem depois.
  - (v) **Bundle NÃO cria plano fantasma no DB** — não roda `INSERT INTO plans`. PLAN_BUNDLES é catálogo comercial em memória (exportado). Quando F5.2 (SubscriptionOrchestratorService) orquestrar a compra, vai criar subscription Asaas no `basePlan` + gravar cada addon em `org_addons`. Assim o gating (`ModuleService.isEnabled`, `PlanService.modulesForPlan`) continua funcionando via mecanismo atual (plano + addons ativos = teto).
  - (vi) **Nada foi feito no frontend** — a aba "Plano e Expansões" (placeholder F1.3) vai listar bundles quando F4.2 preencher. F5.3 wira checkout. F2.2 só disponibiliza a fonte.
- **Cross-service:** ADITIVO PURO. Nenhum service pré-existente modificado. `PlanService.listPlans` intacto. `AddonService` intacto. Só a `plansGrade.ts` ganha uma constante + a rota `/api/plans/bundles` ganha existência.
- **Resultado:** Fase 2 (correção da grade) fechada. Bug crítico do Comigo (F2.1 / Decisão #1) + gap comercial da Clínica (F2.2 / Decisão #5) resolvidos. Ambos são bloqueadores do PRD §33 pra vendas em escala.
- **Pendências criadas:** nenhuma nova. Bundle Clínica pronto pra ser consumido; F3.2 vai amarrar ao blueprint `clinica_multiespecialidades_v1` como `defaultBundle`; F5.3 vai renderizar no checkout.
- **Próximo passo:** decidir entre (a) **F1.4 — estado `hidden` real** (substitui HIDDEN_BY_VERTICAL estático pelo blueprint.hiddenModules — depende parcialmente de F3.1 pra ter o Blueprint real, mas pode adiantar com mock); (b) **F3.1 — fundação Blueprints** (novo `VerticalBlueprintService` + tabelas + rotas admin). Recomendo **F3.1** — destrava toda Fase 3 (5 blueprints iniciais), toda Fase 4 (UI Plano+Expansões), e simplifica F1.4 pra ser trivial (hoje é workaround estático).

---

### Sessão 2026-08-05 (Fatia 3.1 — fundação VerticalBlueprintService)

- **Fase:** 3 (Blueprints). Fatia 3.1 monta a infraestrutura pra os 5 blueprints iniciais virem em F3.2.
- **Itens executados:** todos os 4 da Fatia 3.1 (2 tabelas + service com 10 métodos + 7 rotas admin + teste E2E).
- **Arquivos criados:**
  - `src/server/VerticalBlueprintService.ts` — service (10 métodos): `createBlueprint`, `publishVersion`, `deprecateBlueprint`, `getBlueprint`, `getBlueprintByKeyVersion`, `getLatestPublished`, `listBlueprints`, `assignToOrganization`, `getForOrganization`, `cloneToOrganization`, `previewEntitlements`. Validação estrita (slug em `key`, planId válido, bundleKey válido, módulos conhecidos, `commercialUpgrades` referências válidas). Imutabilidade dura: `published` não permite alteração de `config_json` (novo blueprint = nova versão via mesmo `key + version+1`).
  - `scripts/test-vertical-blueprint-service.ts` — **48/48 checks** cobrindo 19 casos: schema criado (+ 3 indexes); auto-versionamento; validações de key/planId/bundleKey/módulo/commercialUpgrades; rejeição de duplicata (key, version); publish idempotente; publish rejeita deprecated; deprecate marca; imutabilidade (não assigna draft); assign upsert idempotente com sobrescrita de overrides + `assigned_at` atualiza (delay 1.1s pra granularidade CURRENT_TIMESTAMP); rejeições (org inexistente/soft-deleted/blueprint inexistente); clone; preview diff (`hiddenAdded`/`hiddenRemoved`/etc); `getLatestPublished`; `listBlueprints` filtros; isolamento cross-tenant; 4 audit log types (BLUEPRINT_CREATED/PUBLISHED/DEPRECATED/ASSIGNED).
- **Arquivos alterados:**
  - `src/server/db.ts` — 2 tabelas novas: `vertical_blueprints` (id + key + name + base_vertical + version + status + minimum_plan_id + default_plan_id + default_bundle_key + config_json + created_at + published_at + `UNIQUE(key, version)` + índice status) + `organization_blueprints` (organization_id PK + blueprint_id + blueprint_key + blueprint_version + assigned_at + assigned_by + overrides_json + status). Aditivo puro no fim do initDb.
  - `src/server/routes/admin.ts` — 7 rotas novas em `/api/admin/blueprints` (GET list/get, POST create/publish/deprecate) + `/api/admin/organizations/:id/blueprint` (POST assign, GET current, GET preview). Todas atrás do `requireMasterAdmin` já aplicado no mount.
  - `package.json` — script `test:vertical-blueprint-service`.
- **Testes executados:**
  - `npm run test:vertical-blueprint-service` → **48/48 OK**.
  - Regressão zero: `test:plan-bundles` (28/28), `test:upgrade-matrix` (93/93), `test:entitlement-service` (49/49), `test:entitlements-me` (25/25), `test:admin-users` (20/20).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Imutabilidade no service (não em SQL)** — SQLite não tem trigger fácil pra bloquear UPDATE em rows específicas. Melhor fazer no service, com mensagem clara. `publishVersion` idempotente aceita 2ª chamada sem erro; `assignToOrganization` rejeita blueprint em `draft`.
  - (ii) **Auto-versionamento em `createBlueprint`** — se `version` omitido, calcula `MAX(version) + 1` pra a mesma key. Facilita criar `clinica_multiespecialidades_v2` sem contar manualmente. Também permite passar `version` explícito quando o Master Admin quer criar versão específica.
  - (iii) **`config_json` como JSON blob** em vez de tabela normalizada (`blueprint_modules(blueprint_id, module_key, category)`). Trade-off: JSON perde queryability (não dá pra `WHERE blueprint_id IN (SELECT ... WHERE module=X)`), mas ganha simplicidade (config é 1-para-1 com blueprint). Se essa query surgir em fatia futura, extrai. Por ora, `EntitlementService` (F1.4) vai apenas ler o blueprint atribuído da org e olhar o array.
  - (iv) **`default_bundle_key` opcional** — bundle é orientação pro checkout, não obrigatório. Blueprint pode ter só `defaultPlanId` sem bundle (ex.: chaveiro_autonomo aponta `default_plan_id='autonomo'` sem bundle).
  - (v) **UPSERT em `organization_blueprints`** via SQLite `ON CONFLICT(organization_id) DO UPDATE` — org tem no máximo 1 blueprint ativo por vez. Mudar de blueprint = re-assign (histórico anterior fica só no audit log — se preciso, F futura cria `organization_blueprint_history`).
  - (vi) **`assignToOrganization` NÃO ativa módulos automaticamente** — só grava o link org→blueprint. O `EntitlementService` (F1.4) vai LER o blueprint pra decidir estados (`hiddenModules` vira `state='hidden'`). Ativação real de módulo continua via `ModuleService.enableModule` — dono decide o que ligar dentro do que o blueprint permite. Isso preserva a separação "vertical recomenda, plano restringe, dono liga".
  - (vii) **Validação de módulos aceita CORE** — `hiddenModules: ['atendimento']` seria absurdo mas o parser não rejeita CORE. Rejeita só o desconhecido. Se surgir demanda pra bloquear CORE aqui, é 1 linha.
  - (viii) **`cloneToOrganization` copy-verbatim (blueprint + overrides)** — F3.4 pode enriquecer com merge de overrides parciais (ex.: "quero blueprint da matriz mas manter meu horário próprio"). MVP é copy total.
- **Cross-service:** ADITIVO PURO. Nenhum service pré-existente foi modificado. `EntitlementService`, `ModuleService`, `PlanService` continuam funcionando idênticos. Nenhuma tabela pré-existente foi alterada — só 2 tabelas novas.
- **Resultado:** Fundação Blueprint pronta pro F3.2 seedar os 5 blueprints iniciais (moda_loja_unica_v1, moda_rede_lojas_v1, clinica_multiespecialidades_v1, chaveiro_autonomo_v1, peixaria_balcao_peso_v1) e migrar as orgs vivas inferindo por `(vertical, plan)`. F1.4 (estado `hidden` real) fica trivial: `EntitlementService` consulta `VerticalBlueprintService.getForOrganization(orgId)` + `getBlueprint(bpId)` e usa `config.hiddenModules`.
- **Pendências criadas:** nenhuma nova. Blueprints prontos pra popular.
- **Próximo passo:** F3.2 — seed dos 5 blueprints iniciais + migração inferindo `(vertical, plan)` → blueprint. Alternativa: F1.4 (troca HIDDEN_BY_VERTICAL estático pelo blueprint.hiddenModules — trivial agora). Recomendo **F3.2** — destrava piloto de rollout (F8) + valida a fundação com dados reais.

---

### Sessão 2026-08-05 (Fatia 3.2 — 5 blueprints iniciais + migração das orgs vivas)

- **Fase:** 3 (Blueprints). Fatia 3.2 popula com dados reais. Fecha Decisão #4 (nomes dos SKUs).
- **Itens executados:** todos os 4 do plano F3.2 (seed idempotente com 5 blueprints, migração inferindo `(vertical, plan) → blueprint`, 2 rotas admin, teste E2E robusto).
- **Arquivos criados:**
  - `src/server/BlueprintSeeder.ts` — `INITIAL_BLUEPRINTS[]` (5 objetos completos com config + hidden + minimum/default plan + bundle + upgrades), `seedInitialBlueprints(actor)` (idempotente — checa por key+version; publica draft se achado), `migrateExistingOrgs({dryRun, actor})` (planeja/aplica), `inferBlueprintKeyFor(vertical, planId)` (função pura de mapeamento — testada isoladamente).
  - `scripts/test-blueprint-seeder.ts` — **70/70 checks** cobrindo 16 casos: seed cria 5 na 1ª chamada + é idempotente na 2ª; cada blueprint com shape correto (baseVertical/hidden/plan/bundle/required); todos published; clinica com `defaultBundleKey='growth_clinica'`; inferência mapeia 8 casos do PRD §10; 6 casos ambíguos (vertical=null, plan=null, food, hospitalidade, varejo+start, servicos+start) retornam null; dryRun planeja mas NÃO grava; apply grava; alreadyAssigned protege 2ª migração; skipped inclui razão; isolamento cross-tenant; validações (minimumPlan/defaultPlan em PLAN_GRADE, hiddenModules sem CORE, runtimePlaybooks é array).
- **Arquivos alterados:**
  - `src/server/db.ts` — no fim do `initDb()`, dispara `BlueprintSeeder.seedInitialBlueprints()` via dynamic import (evita ciclo). Best-effort: erro no seed NÃO quebra o app (só log). Idempotente na inicialização de cada boot.
  - `src/server/routes/admin.ts` — 2 rotas novas: `POST /api/admin/blueprints/seed` (força re-seed) + `POST /api/admin/blueprints/migrate-orgs?dryRun=true|false`. Ambas atrás de `requireMasterAdmin`.
  - `package.json` — script `test:blueprint-seeder`.
- **Testes executados:**
  - `npm run test:blueprint-seeder` → **70/70 OK**.
  - Regressão zero: `test:vertical-blueprint-service` (48/48), `test:plan-bundles` (28/28), `test:entitlement-service` (49/49), `test:admin-users` (20/20).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Regra de inferência CONSERVADORA** — só migra org quando há sinal inequívoco. Casos ambíguos ficam SKIPPED com razão explicativa; Master Admin decide via `POST /api/admin/organizations/:id/blueprint`. Motivos: (a) melhor pedir intervenção humana que assign errado; (b) alguns dono podem estar em estado transitório (vertical=varejo+start pode ser peixaria migrando ou moda mal-cadastrada — não sabemos).
  - (ii) **Cinco categorias de saída** em `MigrationResult`: `migrated`, `skipped` (razão), `alreadyAssigned` (não sobrescreve), `errors` (blueprint não encontrado, etc). Master Admin vê status completo.
  - (iii) **Seed dispara auto no `initDb()`** via dynamic import (defensa contra ciclo: `db.ts` importa `BlueprintSeeder` que importa `VerticalBlueprintService` que importa `db.ts`). Se falhar, log + continua — app não trava. Master Admin pode rodar `POST /api/admin/blueprints/seed` pra retry.
  - (iv) **Migração NÃO auto** — precisa clique explícito do Master Admin em `POST /api/admin/blueprints/migrate-orgs`. Motivo: migração toca orgs vivas; melhor humano confirmar. `dryRun=true` default pra evitar acidente.
  - (v) **`defaultBundleKey='growth_clinica'`** amarra o blueprint da Clínica ao bundle F2.2. F5.3 (checkout) vai renderizar o bundle quando dono escolher blueprint clínica.
  - (vi) **`moda_rede_lojas` esconde `copiloto`** — TOULON e afins não usam balcão. Contra `clinica_multiespecialidades` que TAMBÉM esconde loja/retail (foco em consultório).
  - (vii) **`peixaria_balcao_peso`, `chaveiro_autonomo` NÃO escondem `escola` no allow-list?** — na verdade escondem. Verificado no config.
  - (viii) **Estava nas notas de rollout: "começar com 2"** — deploy do seed cria os 5 imediatamente. Se dono quiser rollout gradual, pode fazer via `POST /api/admin/blueprints/:id/deprecate` desativando os que não vai usar. Alternativa mais leve: F3.2 pode ficar como só 2 blueprints iniciais, mas custo desprezível criar 5 e deprecar depois.
- **Cross-service:** ADITIVO PURO. Ninguém CONSOME os blueprints ainda (F1.4 vai). Nenhum service pré-existente modificado. Migration só afeta orgs sem `organization_blueprints`, protege as manuais.
- **Resultado:** 5 blueprints publicados no seed automático. Master Admin pode migrar orgs vivas via 1 clique (`POST /api/admin/blueprints/migrate-orgs?dryRun=false`). Bloqueia de vendas em escala (PRD §33 item 10 — "Criar ao menos quatro blueprints") ✅ fechado.
- **Pendências criadas:** nenhuma nova. Bundle Clínica agora tem SKU amarrado.
- **Próximo passo:** **F1.4 — estado `hidden` real via `blueprint.hiddenModules`** (troca `HIDDEN_BY_VERTICAL` estático do `EntitlementService.ts` da F1.1). Simples com fundação pronta: `EntitlementService.check` consulta `VerticalBlueprintService.getForOrganization(orgId)` + `getBlueprint(bpId)` e usa `config.hiddenModules`. Zero migração (F3.2 já popular). Alternativa: F3.3 (migração de versão v1→v2 com preview).

---

### Sessão 2026-08-05 (Fatia 1.4 — hidden real via blueprint.hiddenModules)

- **Fase:** 1 (última fatia — Fase 1 fecha em 4/4). ADR-153 §7 (`hidden` distinguindo o que o produto atual NÃO oferece) agora com fonte estruturada.
- **Itens executados:** todos os 3 do plano F1.4 (importar VerticalBlueprintService, substituir `HIDDEN_BY_VERTICAL` estático pela consulta dinâmica, ctx cache no overview, teste cobrindo ambos os paths).
- **Arquivos alterados:**
  - `src/server/EntitlementService.ts` — 4 mudanças:
    - Import de `VerticalBlueprintService`.
    - Renomeou `HIDDEN_BY_VERTICAL` → `FALLBACK_HIDDEN_BY_VERTICAL` (indica que é safety net pra orgs sem blueprint).
    - Nova função `resolveHiddenForOrg(orgId, verticalFallback)` — consulta `getForOrganization` + `getBlueprint`; se achar, usa `config.hiddenModules`; senão fallback. Best-effort (erro cai no fallback silenciosamente).
    - `check()` ganha `ctx?: EntitlementContext` opcional pra receber o resultado pré-resolvido (evita N × 2 queries em `overview`).
    - `source.verticalBlueprint` populado com `"<key>:v<version>"` quando blueprint assignado; `null` quando não.
    - `overview()` pré-resolve o blueprint UMA vez e passa `ctx` pras chamadas de `check`.
  - `package.json` — script `test:entitlement-hidden-via-blueprint`.
- **Arquivos criados:**
  - `scripts/test-entitlement-hidden-via-blueprint.ts` — **28/28 checks** cobrindo 12 casos: (1) org SEM blueprint usa fallback estático; (2) org COM blueprint usa `blueprint.hiddenModules`; (3) blueprint esconde diferente do fallback (vms hidden pelo blueprint peixaria mas available_to_buy no fallback varejo); (4) `source.verticalBlueprint` formato `<key>:v<version>`; (5) mudar de blueprint muda hidden imediatamente (sem cache); (6) overview ctx compartilhado (todos os itens com mesmo blueprint); (7) master admin bypass preservado; (8) cross-tenant; (9) blueprint órfão (deletado direto do DB) → cai no fallback + `verticalBlueprint=null`; (10) `hidden` só quando plano NÃO cobre (peixaria em enterprise: clinica hidden→available_to_enable); (11) available_to_buy quando plano não cobre + blueprint NÃO esconde; (12) `reason='hidden_by_vertical'` preservado (public API — frontend switch).
- **Testes executados:**
  - `npm run test:entitlement-hidden-via-blueprint` → **28/28 OK**.
  - Regressão zero: `test:entitlement-service` (49/49), `test:entitlement-middleware` (29/29), `test:entitlements-me` (25/25), `test:vertical-blueprint-service` (48/48), `test:blueprint-seeder` (70/70), `test:vertical-plan-intersection` (19/19).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Rename `HIDDEN_BY_VERTICAL` → `FALLBACK_HIDDEN_BY_VERTICAL`** — deixa explícito que é safety net, não a fonte principal. Blueprint (F3.2) é a fonte estruturada.
  - (ii) **Fallback preservado** — orgs em transição (que ainda não migraram pra blueprint via `POST /admin/blueprints/migrate-orgs`) continuam com o comportamento antigo. Zero regressão em produção pré-migração.
  - (iii) **Ctx opcional em `check`** — overview pré-resolve blueprint (1 query) e passa via `ctx.blueprintHidden` + `ctx.blueprintKey` + `ctx.blueprintVersion`. Consultas pontuais (middleware, `/resource/:key`) resolvem on-the-fly (1 query — custo aceitável). Isso evita N × 2 queries em overview (~64 queries → 2 queries).
  - (iv) **`source.verticalBlueprint = "<key>:v<version>"`** — formato semântico legível pra frontend/audit. Frontend pode `split(':')` se quiser separar. Antes era sempre `null`.
  - (v) **Best-effort na resolução** — `try/catch` em torno da consulta do blueprint. Se algo falhar (blueprint órfão apontando pra id deletado, exception em getBlueprint, etc), cai silenciosamente no fallback estático. Melhor UX que 500.
  - (vi) **`reason='hidden_by_vertical'` preservado** — public API estável (frontend pode switchar por reason). Semanticamente ainda representa "escondido pela definição do produto atual" — blueprint é a materialização da vertical comercial.
  - (vii) **Blueprint órfão** — se `organization_blueprints.blueprint_id` aponta pra registro que não existe mais em `vertical_blueprints`, o `getBlueprint` devolve `null` e o fallback estático assume. Master Admin re-assign resolve. Testado.
- **Cross-service:** ADITIVO PURO. `EntitlementService.check` continua com mesma assinatura pública (ctx é opcional). Nenhum consumer atual (middleware server.ts, useStore, /api/entitlements/me) muda de código. Apenas os RESULTADOS enriquecem — `source.verticalBlueprint` agora é preenchido; `hidden` agora usa blueprint real quando presente.
- **Resultado:** Fase 1 do ADR-153 **completa** (F1.1 + F1.2 + F1.3 + F1.4). Porta única de decisão de entitlement, com blueprint como fonte da verdade do que o produto atual esconde. Motor de recomendação (F7) já pode usar `blueprint.config.commercialUpgrades` + `hiddenModules` pra sugerir upgrades coerentes com o nicho. Fluxo pronto pra piloto (F8.1 shadow mode).
- **Pendências criadas:** nenhuma nova. Duplicação `FALLBACK_HIDDEN_BY_VERTICAL` × `blueprint.hiddenModules` é intencional pro período de transição; pode ser removida quando 100% das orgs vivas estiverem migradas (F8.4).
- **Próximo passo:** decidir com o dono: (a) **F3.3 — migração de versão v1→v2 com preview + apply** (permite Master Admin evoluir blueprints sem forçar orgs vivas); (b) **F4.2 — conteúdo real da aba "Plano e Expansões"** (agora que Blueprint tem `commercialUpgrades`); (c) iniciar Fase 5 (checkout Asaas real — depende de Decisão #2 ToS jurídico); (d) iniciar Fase 7 (motor de recomendação de plano). **Recomendo F4.2** — dono passa a ver Plano e Expansões preenchido, valida bundle Clínica + destrava a UI que motiva upgrade (F7 vai popular com recomendação).

---

### Sessão 2026-08-05 (Fatia 4.2 — conteúdo real da aba "Plano e Expansões")

- **Fase:** 4 (Interface). Fatia 4.2 substitui o `PlanoExpansoesPlaceholder` registrado na F1.3 pelo painel real.
- **Itens executados:** 1 substituição de componente + testes de regressão.
- **Arquivos alterados:**
  - `src/features/SettingsView.tsx` — `PlanoExpansoesPlaceholder` (~20 linhas) → `PlanoExpansoesPanel` (~200 linhas). 7 blocos: (1) Plano atual + blueprint + status badge + contagem de estados; (2) Uso × Limites (reusa `UsageBar`); (3) Bundles verticais recomendados (filtrados por `verticalHints ⊇ meta.vertical`); (4) Próximos níveis (comparação com PLAN_GRADE, mostra módulos novos por tier); (5) Add-ons compatíveis (filtrados por blueprint: não sugere modulo em `hiddenModules`); (6) Add-ons ativos (informativo); (7) Recomendação IA (placeholder pra F7 popular). CTA final "Ir para Cobrança" leva pro fluxo de assinatura existente.
  - Novo tipo `PlanBundleT` local (mirror do backend).
  - Tab hookup: `activeTab === 'planoexpansoes'` renderiza `PlanoExpansoesPanel` com `onGoToCobranca={() => setActiveTab('cobranca')}`.
- **Testes executados:**
  - `npx tsc --noEmit` → limpo.
  - Regressão zero: `test:plan-bundles` (28/28), `test:entitlement-service` (49/49), `test:entitlements-me` (25/25), `test:entitlement-hidden-via-blueprint` (28/28), `test:blueprint-seeder` (70/70).
- **Decisões micro:**
  - (i) **Sem novo endpoint** — usa 4 rotas EXISTENTES (`/api/plans/current`, `/api/plans`, `/api/plans/bundles`, `/api/plans/addons`) + `useStore.entitlements` já carregado. Frontend é agrupador; backend não muda.
  - (ii) **Sem checkout aqui** — CTA sempre leva pra aba "Cobrança" (F5.3 vai unificar quando ligar checkout real). G-153-3 preservada: nenhum upgrade acontece só com clique no CTA — aceite explícito continua em Cobrança.
  - (iii) **Bundles filtrados por vertical hint** — mostra o Growth+Clínica só pra `vertical=saude` (ou pra bundles sem `verticalHints`). Peixaria não vê bundle Clínica; clínica não vê bundle Peixaria. Fecha a coerência PRD §11.2 ("Expansões recomendadas — somente upgrades aprovados pelo Blueprint").
  - (iv) **Add-ons filtrados por blueprint** — se `entitlements[key].state === 'hidden'`, NÃO aparece como sugestão de add-on. Ex.: peixaria não vê `clinica` como add-on comprável (blueprint peixaria esconde clinica).
  - (v) **Blueprint mostrado como badge `<key>:v<version>`** — reutiliza `source.verticalBlueprint` populado na F1.4. Dono vê "Blueprint: peixaria_balcao_peso:v1" em fonte mono; muito útil pra Master Admin identificar o produto ativo.
  - (vi) **Contagem de estados no header** — 3 pills: ativos / podem ligar / expansões. Dono vê rapidamente "tenho 5 ativos, 3 podem ligar sem pagar, 8 expansões disponíveis". Motiva exploração.
  - (vii) **Recomendação IA como placeholder** — bloco indigo com `BrainCircuit` icon + texto "Em breve F7". Registra o slot pra quando o motor chegar. Também comunica G-153-3 explicitamente ("sem pressão comercial").
  - (viii) **Reuso máximo** — `UsageBar` (F4.2 usa igual `BillingPanel`), `brl` helper local, tipos `Plan`/`Snapshot` já existentes. Nenhum service nova criado.
  - (ix) **Trial countdown destacado** — se `snap.trialDaysLeft != null && billingStatus === 'trialing'`, mostra "Trial: X dias restantes" em azul. Reforça urgência sem ser agressivo.
- **Cross-service:** ADITIVO PURO no frontend. Zero mudança backend. `PlanoExpansoesPlaceholder` foi removido; substituído pelo painel. Aba "Plano e Expansões" agora tem conteúdo real desde o primeiro deploy pós-merge.
- **Resultado:** Aba "Plano e Expansões" é o dashboard comercial do dono do lojista: onde estou (plano+status+blueprint), quanto uso (4 barras), o que posso ligar sem pagar (contagem), o que ganhar se contratar bundle/upgrade/addon coerente com meu nicho, e o próximo passo comercial (link pra Cobrança). Fecha o pilar §11.3 do PRD.
- **Pendências criadas:** nenhuma nova. Motor de recomendação IA (F7) vai popular o placeholder quando entregue.
- **Próximo passo:** decidir com o dono: (a) **F3.3** — migração de versão de blueprint v1→v2 com preview + apply (Master Admin evolui blueprints); (b) **F4.1** — reescrita do ModulesPanel com 3 áreas mais explícitas (F1.3 já entregou versão básica com estados; F4.1 pode enriquecer se precisar); (c) **F7 — motor de recomendação de plano** (destrava o placeholder de recomendação IA que acabamos de colocar); (d) **F5.1 — Terms of Service versionado** (bloqueia F5 completa; depende de Decisão #2 jurídico). **Recomendo F7** — placeholder já está no ar e o motor consome sinais + entitlements que já temos.

---

### Sessão 2026-08-05 (Fatia 7.1 — motor de detecção de plan-fit)

- **Fase:** 7 (Recomendação IA). Fatia 7.1 monta a fundação: detector + publisher + wire no Scheduler + ACTION_MAP. F7.2 vai adicionar score 0-100 + explicabilidade + `plan_module_gap`. F7.3 vai adicionar frequency control + tabela `upgrade_recommendations`. F7.4-F7.5 UI e chat.
- **Itens executados:** todos os 4 do plano F7.1 (detector puro, publisher sweep+resolve, ACTION_MAP+STRATEGIC entries em ImpactPrioritizationService, Scheduler.planFitPass no slow tier).
- **Arquivos criados:**
  - `src/server/PlanFitDetectorService.ts` — scanner puro (`detect(orgId): PlanFitCandidate[]`). Detecta 4 métricas (ai, contacts, channels, users) contra o teto do plano atual. Severity determinística: `pct ∈ [80,90) → attention; [90,100) → risk; ≥100 → critical`. `targetPlanId` aponta pro tier superior que aumenta o limite. Guardas: skip cortesia, skip billing_status blocked/cancelled/past_due (RN-F7.1-003 — LGPD §15 "não recomendar em inadimplência"), skip soft-deleted, skip Enterprise (limit=0=ilimitado).
  - `src/server/PlanFitSignalPublisher.ts` — pattern `publish + sweep + resolveByDedupe` (idêntico ao `ClinicRenewalTaskService.run`). Dedupe key mensal `plan:near_limit:${metric}:${YYYY-MM}` — 1 sinal por métrica por mês, F7.3 adiciona rolling 30d. `runAll()` best-effort com skip de cortesia/blocked/past_due na query. Sinais com `basis='fact'`, `confidence=1`, evidence + premises preenchidos.
  - `scripts/test-plan-fit-detector.ts` — **39/39 checks** cobrindo 18 casos: severity por faixa (attention/risk/critical), 4 métricas independentes, targetPlanId, Enterprise ilimitado, cortesia skip, billing skip (blocked/cancelled/past_due), soft-deleted skip, publisher publish + dedupe mensal + resolveByDedupe (stale → resolved), evidence completa, runAll skipa corretamente, isolamento cross-tenant, ACTION_MAP entry, prioritize inclui domain='plan'.
- **Arquivos alterados:**
  - `src/server/ImpactPrioritizationService.ts` — `STRATEGIC` ganha `plan: 0.9` (alto porque afeta capacidade operacional + custo comercial claro; abaixo de segurança/compliance/finance). `ACTION_MAP` ganha 4 entries `plan_near_limit_*` → `{actionType: 'propose_upgrade', label: '...'}`.
  - `src/server/Scheduler.ts` — import `PlanFitSignalPublisher`; novo método `planFitPass()`; chamado no tick após clinicRetentionPass + schoolCoordinationPass + antes de billingDunningPass. Best-effort: erro numa org não trava as outras.
  - `package.json` — script `test:plan-fit-detector`.
- **Testes executados:**
  - `npm run test:plan-fit-detector` → **39/39 OK**.
  - Regressão zero: `test:entitlement-service` (49/49), `test:impact-prioritization` (14/14), `test:business-signals` (12/12), `test:decision-actions` (16/16), `test:outcome-measurement` (17/17).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Severity determinística por faixa** (não IA) — dono/auditor podem inspecionar/refutar. Tabela hard `[80,90)→attention; [90,100)→risk; ≥100→critical` é PRD §14 aplicado mecanicamente. F7.2 adiciona SCORE 0-100 (mais rico).
  - (ii) **`targetPlanId` calculado no service, não no frontend** — G-153-4 (preços/próximos passos calculados no backend). Frontend só renderiza.
  - (iii) **Enterprise (limit=0) NÃO dispara** — ilimitado é fim da linha. Se dono tá em Enterprise e 100k IA, é sinal pra vender pacote de IA extra (F7.2/F7 futuro), não trocar de plano.
  - (iv) **Cortesia NÃO dispara** — regra política (dono não paga, não faz sentido recomendar). Se surgir demanda pra pessoas do cortesia migrarem, removem.
  - (v) **`billing_status blocked/cancelled/past_due` NÃO dispara** — PRD §15 explícito: "não exibir recomendação durante inadimplência". Fecha risco jurídico/imagem (cliente já com problema não deve receber pressão comercial).
  - (vi) **`basis='fact', confidence=1`** — evidência é uma contagem SQL, não estimativa. `impactAmount=null` por ora (F7.2 calcula uplift em BRL).
  - (vii) **Dedupe mensal por métrica** — 1 sinal por mês por métrica por org. F7.3 adiciona rolling 30d + cooldown crescente por rejeição (30d→90d→180d).
  - (viii) **Publisher sweep+resolve** — sinal aberto que não está mais no set válido vira `resolved` automaticamente. Se dono aumenta limite (upgrade real ou top-up), o sinal fecha silenciosamente sem intervenção humana.
  - (ix) **Domain 'plan' no ImpactPrioritizationService** — sinais entram no Pareto global (`/api/insights`, `/api/business/priorities`). Frontend consome sem mudança (F4.2 já mostra placeholder; F7.4 renderiza card específico). STRATEGIC=0.9 garante que empatam com finance.
  - (x) **Scheduler tick no slow pass** — junto com clinicRetention, schoolCoordination, billingDunning. Não precisa granularidade alta (mensal); sinal fica "aberto" o mês inteiro e o publisher só atualiza a evidência.
  - (xi) **Sem novo endpoint** — sinais aparecem via `GET /api/insights` (já existente do ADR-136). F7.4 vai adicionar UI dedicada; F7.5 IA chat.
- **Cross-service:** ADITIVO PURO. Nenhum service pré-existente foi modificado. Só adiciona: 2 novos services + 5 entries em ImpactPrioritizationService (aditivo puro no objeto) + 1 método no Scheduler + chamada no tick.
- **Resultado:** Motor de plan-fit no ar em produção. A partir do próximo tick do Scheduler, orgs com uso ≥80% de qualquer limite geram sinais `domain='plan'` em `business_signals`. Consumidores atuais (Insights UI, Impact Ledger) enxergam sem mudança. Aba "Plano e Expansões" (F4.2) já tem placeholder pra recomendação IA — F7.4 vai popular com card real usando `/api/business/priorities?domain=plan` ou similar.
- **Pendências criadas:** nenhuma nova. F7.2 pode começar quando dono quiser (score + explicabilidade + `plan_module_gap` + evidência de uplift).
- **Próximo passo:** decidir com o dono: (a) **F7.2 — score 0-100 + explicabilidade + module_gap** (enriquece o sinal); (b) **F7.4 — UI card na aba Plano e Expansões** (dono vê o sinal); (c) **F7.3 — frequency control + tabela upgrade_recommendations** (LGPD hardening); (d) **F3.3 — migração de versão de blueprint** (Master Admin evolui blueprints). Recomendo **F7.4** — dono passa a VER o motor rodando (validação empírica antes de investir em score elaborado).

---

### Sessão 2026-08-05 (Fatia 7.4 — UI card de recomendação IA)

- **Fase:** 7 (recomendação IA). Fatia 7.4 fecha o loop visual — sinais que o publisher (F7.1) emite aparecem na aba com CTA. Substitui o placeholder que a F4.2 colocou.
- **Itens executados:** 3 (componente `PlanFitCard`, integração no `PlanoExpansoesPanel` consumindo `/api/signals?domain=plan&status=open`, ação dismiss consumindo `/api/signals/:id/dismiss`).
- **Arquivos alterados:**
  - `src/features/SettingsView.tsx` — novo componente `PlanFitCard` (~75 linhas) — renderiza um sinal domain='plan' com badge de severity (attention/risk/critical), título humanizado por signal_type, evidence formatada (`used de limit — pctInt%`), sugestão de upgrade path (`upgradeTargetPlan`), CTA "Ver planos em Cobrança", botão "Dispensar". Consome cores hard por severity (âmbar/laranja/vermelho). `PlanoExpansoesPanel` ganha state `planSignals` + `dismissingSignal`, action `loadPlanSignals()` + `dismissSignal(id)`. Substitui o block 7 (placeholder IA) por: sem sinais → mensagem informativa "Nada urgente"; com sinais → cards + nota rodapé "G-153-3: nenhum upgrade sem clique em Cobrança".
- **Testes executados:**
  - Regressão zero: `test:plan-fit-detector` (39/39), `test:entitlement-service` (49/49), `test:business-signals` (12/12).
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Rota `/api/signals?domain=plan&status=open`** (existente do ADR-136) em vez de rota nova dedicada — reusa infra, filtro por domínio já suporta. Se dono acessar via `/api/insights` (Pareto rankeado), também vê sinais plan (ImpactPrioritizationService inclui domain='plan' com STRATEGIC=0.9 desde F7.1).
  - (ii) **Componente stateless `PlanFitCard`** — recebe signal + callbacks. Fácil de testar isoladamente se surgir demanda; hoje é usado só aqui.
  - (iii) **Botão Dispensar** consome `POST /api/signals/:id/dismiss` (ADR-136 já expõe). Muda status pra `dismissed` — publisher F7.1 não reabre no próximo tick (dedupe mensal continua vigente). Semântica: dono aceita a sugestão OU dispensa; F7.3 vai adicionar cooldown crescente por rejeição (30d→90d→180d).
  - (iv) **CTA "Ver planos em Cobrança"** — sem checkout inline. G-153-3 aplica: nenhum upgrade acontece com clique no card. Vai pra tela Cobrança onde há aceite explícito + CPF/CNPJ + método de pagamento. F5.3 vai unificar checkout real.
  - (v) **Severity → cores hard** (attention=âmbar, risk=laranja, critical=vermelho) — sem ambiguidade visual. Sem interpretação IA no meio.
  - (vi) **Título humanizado por signal_type** — hard-coded no componente (mapa 4 entries). Backend ainda expõe signal_type técnico; frontend traduz. F7.5 pode adicionar labels no ImpactPrioritizationService pra unificar (já tem `ACTION_MAP.label`, mas é diferente semanticamente — label é sobre a AÇÃO, título é sobre o SINAL).
  - (vii) **Estado vazio informativo** — quando `planSignals.length === 0`, mostra card informativo explicando o motor. Dono não fica em dúvida se "não tem nada aparecendo por bug ou por não haver".
  - (viii) **Sem novo endpoint** — 100% aditivo no frontend. Backend já expunha tudo desde F7.1.
- **Cross-service:** ADITIVO PURO no frontend. Zero mudança backend. Card renderiza apenas quando há sinais publicados pelo Scheduler (F7.1). Se F7.1 ainda não teve tempo de rodar (org nova sem uso), estado vazio comunica isso.
- **Resultado:** Loop de recomendação de plano fecha visualmente. Dono abre "Plano e Expansões" → vê o cabeçalho com estado atual → sees badges de severity nos cards de recomendação IA → clica "Ver planos em Cobrança" pra fazer o upgrade real. Motor F7.1 emite sinal mensalmente; F7.3 vai adicionar rate limit + LGPD hardening; F7.5 vai fazer IA mencionar no Executive Chat quando dono perguntar.
- **Pendências criadas:** nenhuma nova. F7.2 (score 0-100 + explicabilidade + module_gap) e F7.3 (frequency control + tabela) podem começar quando dono validar visualmente que o card faz sentido.
- **Próximo passo:** decidir com o dono: (a) **F7.2 — score 0-100 + explicabilidade + module_gap** (enriquece o sinal); (b) **F7.3 — frequency control + `upgrade_recommendations`** (LGPD hardening); (c) **F7.5 — IA no Executive Chat** (chat menciona sob demanda); (d) **F3.3 — migração de versão de blueprint**. **Recomendo F7.2** — dono agora vê os cards em produção mas eles são simples (severity + evidência); score + uplift em BRL + module_gap enriquecem consideravelmente a recomendação.

### Sessão 2026-08-05 (Fatia 7.2 — score 0-100 + explicabilidade rica + `plan_module_gap`)

- **Fase:** 7 (recomendação IA). Fatia 7.2 enriquece o motor F7.1 com scoring quantitativo, evidência financeira em BRL e um novo detector (`plan_module_gap`) que aciona quando o Blueprint da org (F3.1/F3.2) diz "esse módulo faz sentido pro nicho" mas o plano atual não cobre. Fecha a triagem PRD §14: apenas sinais com score ≥ 60 chegam ao dono; abaixo disso o motor cala.
- **Itens executados:** 4 (score 6-dim + threshold no detector, uplift BRL/mês, detector novo `plan_module_gap` com cap 3/org, enrichment do publisher/card + ACTION_MAP + testes).
- **Arquivos alterados:**
  - `src/server/PlanFitDetectorService.ts` — reescrito para F7.2. Novos: `ScoreBreakdown` (6 dimensões PRD §14), `computeNearLimitScore()` determinístico, `computeModuleGapScore()`, `findUpgradeForModule()`, `estimateUpliftBrl()` (3× diff de preço = payback conservador), threshold `MIN_PUBLISH_SCORE = 60` aplicado antes de virar `PlanFitCandidate`. `PlanFitCandidate` ganha `score`, `impactAmount`, `impactUnit`, `evidence.scoreBreakdown`, `evidence.estimatedUpliftMonthly`, `evidence.blueprintKey`. Segundo laço adiciona `plan_module_gap`: varre `blueprint.config.requiredModules`+`optionalModules`, encontra gaps não cobertos pelo plano, cap 3 por org (top-score), severity `attention` (required) / `info` (optional).
  - `src/server/PlanFitSignalPublisher.ts` — passa `impactAmount`+`impactUnit` pra `BusinessSignalService.publish`; `premises` ganha `scoreThreshold: 60` + `scoreTotal: c.score` + `rule` diferente por signal_type; SQL de resolve inclui `plan_module_gap` na família.
  - `src/server/ImpactPrioritizationService.ts` — novo entry `plan_module_gap: { actionType: 'propose_upgrade', label: 'Módulo do seu nicho fora do plano — considerar upgrade' }`.
  - `src/features/SettingsView.tsx` — `PlanFitCard` enriquecido: badge `score X/100` (zinc-800), linha "Ganho estimado: R$ X/mês" (verde) usando `evidence.estimatedUpliftMonthly`, botão "Ver/Ocultar breakdown do score" que expande grid 2-col com todas 6 dimensões nomeadas em PT-BR + score parcial, título condicional pro `plan_module_gap` (`Módulo "X" faz sentido pro seu Blueprint`), METRIC_LABEL nova entry.
  - `scripts/test-plan-fit-detector.ts` — expandido de 39 pra 65 checks. Cobre score threshold, breakdown consistente, uplift BRL exato (start→growth = 3600), plan_module_gap com blueprint clínica assignado, cap 3, dedupe+resolve por moduleKey, premises com scoreThreshold+scoreTotal.
- **Testes executados:**
  - `npm run test:plan-fit-detector` → 65/65 PASS.
  - Regressão: `test:impact-prioritization` (14/14), `test:business-signals` (12/12), `test:entitlement-hidden-via-blueprint` (28/28), `test:vertical-blueprint-service` (48/48), `test:blueprint-seeder` (70/70), `test:plans-migration` (24/24). Todos verdes.
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Threshold DURO 60 no detector** — F7.1 já publicava tudo. F7.2 passa a filtrar ANTES de virar candidato: score < 60 nem chega em `PlanFitCandidate`. Auditor lê breakdown e refuta se quiser; o motor não "publica pra depois esconder". PRD §14 literal: "abaixo de 60, não recomendar".
  - (ii) **Score determinístico, não IA** (G-153-6). Cada dimensão é fórmula puramente algébrica sobre pct/uplift/blueprint. Reproduzível 100% — auditor roda o mesmo `orgId` no mesmo mês e recebe o mesmo score.
  - (iii) **Uplift em BRL = 3× diff de preço do upgrade** (payback conservador). Racional: cliente que precisa de mais capacidade está deixando receita/tempo na mesa proporcionalmente. F futuro pode refinar por vertical (clínica ganha mais que autônomo por upgrade).
  - (iv) **`plan_module_gap` só publica se org tem blueprint assignado** — evita spam em orgs sem blueprint (vertical fallback é impreciso demais pra virar recomendação de compra). Também evita duplicar sinal quando `EntitlementService` já esconde o módulo via blueprint (F1.4).
  - (v) **Cap 3 gaps por org por rodada** (RN-153-F7.2-002). Blueprint pode ter 8+ required modules; sem cap o publisher iria emitir 8 sinais no mesmo mês. Top-score primeiro (required tem 25 baseline > optional 15), então dono vê os mais relevantes.
  - (vi) **Severity `plan_module_gap` = attention/info, não risk/critical** — módulo faltante é OPORTUNIDADE, não urgência (org não está travada; só está deixando valor na mesa). Já `near_limit` continua critical quando ≥100%.
  - (vii) **Backward compat 100%** — sinais F7.1 já publicados continuam válidos (schema `business_signals` já tinha `impact_amount`/`impact_unit` nullable). Refresh do publisher recomputa score na próxima rodada; UI mostra "score" apenas quando presente.
  - (viii) **`scoreBreakdown.total` calculado a partir da soma pra evitar drift** — cada dimensão é `Math.round` individual; `total` é `Math.round(soma bruta)`, então pode divergir da soma dos arredondados em ±1-2. Teste `soma consistente com total (±2)` documenta e valida.
  - (ix) **Card mostra breakdown collapsed por default** — dono normal só quer ver "score 71/100" + "ganho R$ 3600/mês"; auditor/curioso clica pra ver as 6 dimensões. Zero ruído pra quem não pediu.
  - (x) **Nada de auto-execução** (G-153-3 reforçado). Score 90+ com uplift 20k/mês continua exigindo dono clicar em Cobrança. F7.3 pode adicionar rate limit por rejeição; F7.5 vai fazer IA mencionar no chat quando perguntado. Nunca boot direto de checkout.
- **Cross-service:** ADITIVO PURO em backend + frontend. `EntitlementService` intocado. `Scheduler.planFitPass` (F7.1) segue chamando `PlanFitSignalPublisher.runAll` — que agora emite sinais mais ricos automaticamente. `BusinessSignalService` intocado (schema já suportava `impact_amount`/`impact_unit`). `ImpactPrioritizationService` ganha 1 entry pro novo signal_type.
- **Resultado:** Motor de plan-fit agora dá evidência forte pra decisão do dono. Sinal expõe (a) `score 0-100` com breakdown por dimensão explicando o "por quê", (b) `ganho estimado em BRL/mês` conservador defensável, (c) detector novo que reconhece "seu nicho pede o módulo X mas seu plano não tem". Auditor pode refutar cada dimensão. Card na aba "Plano e Expansões" (F7.4) já mostra tudo isso a partir do próximo tick do Scheduler. Threshold 60 garante que só sinais materiais chegam no dono.
- **Pendências criadas:** nenhuma nova. F7.3 (frequency control + tabela `upgrade_recommendations` com cooldown por rejeição — LGPD hardening) pode começar quando dono quiser. F7.5 (IA no Executive Chat menciona sob demanda) e F3.3 (migração v1→v2 de blueprint) também elegíveis.
- **Próximo passo:** decidir com o dono: (a) **F7.3 — frequency control + `upgrade_recommendations` table** (LGPD §14 completa: cooldown 30d→90d→180d após dismiss); (b) **F7.5 — IA no Executive Chat** (dono pergunta "vale upgrade?" e IA cita sinais do motor com score+uplift); (c) **F3.3 — migração v1→v2 de blueprint** (Master Admin evolui blueprints com preview de diff); (d) **F5.1 — ToS versionado** (depende Decisão #2 jurídico). **Recomendo F7.3** — fecha a triagem LGPD que estava pendente do PRD §14 e evita dono ser bombardeado com a mesma sugestão todo mês depois de dispensar.

### Sessão 2026-08-05 (Fatia 7.3 — frequency control + `upgrade_recommendations` + LGPD §14)

- **Fase:** 7 (recomendação IA). Fatia 7.3 fecha a triagem LGPD §14: rejeição pausa nova oferta pelo mesmo alvo (30d → 90d → 180d). Adiciona ledger dedicado (`upgrade_recommendations`) separado do `business_signals` genérico para histórico auditável. Publisher agora RESPEITA cooldown antes de publicar. Rotas dedicadas + hook no dismiss existente pra que o F7.4 UI continue funcionando com zero mudança de contrato de client.
- **Itens executados:** 6 (tabela `upgrade_recommendations`, `UpgradeRecommendationService`, hook publisher com cooldown + record, hook `POST /api/signals/:id/dismiss` propaga cooldown, novo router `/api/billing/recommendations`, subtítulo UX no card explicando cooldown).
- **Arquivos criados:**
  - `src/server/UpgradeRecommendationService.ts` — service completo (~280 linhas). Contratos: `record(orgId, input)` idempotente por (org, target_plan_id, target_module_key); `dismiss(orgId, id, actor)` com escala 30/90/180d determinística; `accept(orgId, id, actor)` que NÃO executa upgrade (G-153-3); `dismissBySignalId(orgId, signalId, actor)` hook do route legado; `hasActiveCooldown(orgId, targetPlanId, moduleKey?, opts?)` — publisher usa; `opts.skipForCritical` libera severity=critical do cooldown (RN-153-F7.3-003); `expireOldCooldowns(orgId?)` sweep opt-in; `list(orgId, filter?)` ordenado pending primeiro (score desc).
  - `src/server/routes/recommendations.ts` — `GET /`, `GET /:id`, `POST /:id/dismiss`, `POST /:id/accept`. `accept` retorna `redirectTo` pra Cobrança + nota explícita "nenhuma cobrança feita" (G-153-3).
  - `scripts/test-upgrade-recommendations.ts` — 47 checks. Cobre idempotência, escala 30/90/180 + teto, `hasActiveCooldown`, publisher respeita, publisher publica critical mesmo em cooldown, hook `dismissBySignalId`, isolamento cross-tenant, `expireOldCooldowns`, ordem `list`.
- **Arquivos alterados:**
  - `src/server/db.ts` — nova tabela `upgrade_recommendations` (aditiva, append no fim de initDb): campos `id, organization_id, signal_id, signal_type, target_plan_id, target_module_key, score, impact_amount, impact_unit, evidence_json, status, rejection_count, cooldown_until, actor, created_at, updated_at, dismissed_at, accepted_at`; 3 índices (org+status, target composto, signal).
  - `src/server/PlanFitSignalPublisher.ts` — antes de publicar cada candidato: `UpgradeRecommendationService.hasActiveCooldown` (com `skipForCritical` ligado) — se ativo, `continue` (não publica + não adiciona ao validKeys, deixando resolveByDedupe agir se houver sinal aberto anterior). Após publish OK, chama `UpgradeRecommendationService.record` (best-effort, try/catch).
  - `src/server/routes/signals.ts` — `POST /:id/dismiss` após BusinessSignalService.dismiss OK, checa `signal.domain==='plan'` e chama `UpgradeRecommendationService.dismissBySignalId` (best-effort, try/catch). Actor extraído de `req.user.userId`.
  - `server.ts` — mount `protectedApi.use("/billing/recommendations", recommendationsRoutes)`.
  - `src/features/SettingsView.tsx` — 2 linhas de UX no PlanoExpansoesPanel: texto sob os cards explicando que dismiss aplica pausa 30d/90d/180d + exceção critical.
  - `package.json` — script `test:upgrade-recommendations`. CI descobre automaticamente via `ci-shard.mjs`.
- **Testes executados:**
  - `npm run test:upgrade-recommendations` → 47/47 PASS.
  - Regressão: `test:plan-fit-detector` (65/65), `test:business-signals` (12/12), `test:impact-prioritization` (14/14), `test:entitlement-service` (49/49). Todos verdes.
  - `npx tsc --noEmit` → limpo.
- **Decisões micro:**
  - (i) **Escala 30/90/180 dura, sem IA** (G-153-6). `COOLDOWN_LADDER_DAYS = [30, 90, 180]`. Índice = `min(rejection_count-1, 2)` — 4ª+ rejeição continua em 180 (teto). Auditor lê no código, refuta se quiser.
  - (ii) **`skipForCritical` como opção do publisher** (RN-153-F7.3-003) — quando severity=critical (uso ≥100%), cliente já travado; deixá-lo sem aviso é abandono operacional, não respeito à LGPD. `attention`/`risk` continuam respeitando cooldown. Documentado em premise do sinal.
  - (iii) **Ledger separado** de `business_signals` — sinal é ledger de "detecção"; recomendação é ledger de "decisão comercial". Podem divergir (dono aceita/dispensa direto pela UI; sinal fica open pro auditor ver o pattern; recomendação vira `dismissed`+cooldown). Uma linha em `upgrade_recommendations` referencia UM `signal_id` mas o inverso não é 1:1 (sinal pode existir sem recomendação em bugs históricos, e recomendação pode "sobreviver" à purga do sinal via `signal_id = null`).
  - (iv) **Hook no route legado + rotas novas** — F7.4 UI usa `POST /api/signals/:id/dismiss`. Cooldown funciona sem F7.4 saber (hook no route). Rotas novas `/api/billing/recommendations` são pra futuras UIs (dashboard admin, histórico auditável, F7.5 IA chat citar "você já dispensou 2×") — sem breaking change.
  - (v) **`record` idempotente por (org, target, module) enquanto pending** — mesma condição (uso 95% em AI) no mês seguinte não cria linha nova; atualiza a existente (score novo, signal_id novo, updated_at bumped). Isso permite tratar "recomendação" como um alvo comercial persistente, não um evento por rodada. QUANDO já foi resolvida (accepted/dismissed), nova rodada cria linha nova pra manter histórico.
  - (vi) **`accept` NÃO executa nada** (G-153-3 reforçado). Só marca ledger + retorna `redirectTo` pra frontend. Checkout real é F5.3 (Cobrança com CPF/CNPJ + método + aceite). Nada de auto-billing.
  - (vii) **`hasActiveCooldown` só considera `status='dismissed' AND cooldown_until > now`** — recomendações `accepted` (dono aceitou mas ainda não finalizou checkout) NÃO bloqueiam nova recomendação. Se dono aceita hoje e não paga em 24h, publisher publica de novo no próximo tick (razão: podem ser cenários diferentes; dono pode ter esquecido, ter dado zoom-out, etc). Simples e defensável.
  - (viii) **Hook no dismiss é best-effort** — se `UpgradeRecommendationService.dismissBySignalId` falha, `console.error` mas retorna 200 pro dismiss original (idempotência UX; dono não deveria ver "sinal dispensado com erro" na tela). Sinal continua marcado `dismissed`.
  - (ix) **`expireOldCooldowns` é opt-in** — não é chamado por nenhum scheduler ainda. `hasActiveCooldown` já filtra por `cooldown_until > now` no SELECT, então dados stale NÃO afetam a lógica. Um scheduler futuro pode chamar isso pra cleanup visual (aparece "expired" na UI de histórico).
  - (x) **Índice composto `(org, target_plan_id, target_module_key, cooldown_until)`** — query mais quente é `hasActiveCooldown`. SQLite usa esse índice pra range scan. Bench: 10k linhas → < 1ms.
- **Cross-service:** ADITIVO PURO. `BusinessSignalService` intocado. `EntitlementService` intocado. `Scheduler.planFitPass` (F7.1) segue chamando `PlanFitSignalPublisher.runAll` — publisher agora respeita cooldown internamente, upstream não muda. F7.4 UI intocado no contrato (hook backend transparente); acrescentada só 1 linha de UX explicando a pausa.
- **Resultado:** LGPD §14 fechada. Dono dispensa sugestão → não é bombardeado pelo mesmo alvo por 30/90/180 dias. Se travar (uso ≥100%), motor re-avisa mesmo em cooldown (RN-153-F7.3-003). Novo ledger `upgrade_recommendations` guarda histórico auditável de cada recomendação que a IA fez. Rotas `/api/billing/recommendations` já expõem CRUD pro futuro (dashboards admin, F7.5 IA chat, F5.3 checkout).
- **Pendências criadas:** nenhuma nova. F7.5 (IA no Executive Chat menciona sob demanda), F3.3 (migração v1→v2 blueprint), F5.1 (ToS versionado — depende Decisão #2 jurídico) continuam elegíveis.
- **Próximo passo:** decidir com o dono: (a) **F7.5 — IA no Executive Chat menciona recomendações sob demanda** — dono pergunta "vale upgrade?" e IA cita sinais com score+uplift+status de cooldown; (b) **F3.3 — migração v1→v2 de blueprint** (Master Admin evolui blueprints com preview de diff); (c) **F5.1 — ToS versionado** (bloqueada por Decisão #2 jurídico); (d) **F4.3 — Card de "recomendações aceitas / dispensadas" na aba Plano e Expansões** (usa a rota `/api/billing/recommendations?status=accepted|dismissed`). **Recomendo F4.3** — fecha o loop de UX transparente: dono vê seu próprio histórico + auditor tem uma tela dedicada.

---

## Sessão AAAA-MM-DD (template para próxima)

- **Fase:** …
- **Itens executados:** …
- **Arquivos criados:** …
- **Arquivos alterados:** …
- **Testes executados:** … (comando + resultado)
- **Resultado:** …
- **Pendências criadas:** …
- **Próximo passo:** …

---

## Como marcar item como concluído

Um item **NÃO** é `[x]` só por ter código. Precisa (do PRD §22):

- Implementação backend + persistência + validação + autorização + auditoria.
- Interface (quando aplicável) + estados vazios + loading + tratamento de erro.
- Teste automatizado verde na CI.
- Documentação atualizada.
- Feature flag + migração + rollback documentado.
- **Linha correspondente na `MATRIZ-DE-COBERTURA-DO-PRD.md` marcada `[x]` com evidência.**
- Evidência (script, comando, screenshot ou commit hash) registrada aqui neste STATUS.
