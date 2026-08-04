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
