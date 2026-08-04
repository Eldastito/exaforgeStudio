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
