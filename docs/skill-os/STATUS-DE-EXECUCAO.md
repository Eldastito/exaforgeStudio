# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 7 — Planner (em revisão/PR).
- **Última fatia:** F7 entregue (objetivo → ExecutionPlan). F6 mergeada (#963).
- **Baseline:** `main` @ `2b67267` (pós F6).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1 (mergeada #958):** `src/server/skillosModel.ts` (puro) — contratos + guardas determinísticas + taxonomia AI-FAIL-1..6. `test:skillos-contracts` (31 checks).
- **Fase 2 (mergeada #959):** tabelas `skillos_capabilities`/`skillos_skills` + `SkillOsRegistryService` (registro/lookup/ciclo de vida/compat vertical+entitlement). Rota read-only. `test:skillos-registry` (21).
- **Fase 3 (mergeada #960):** `SkillOsResolverService.resolve` — escolha determinística de Skill (sem IA, §11) + `rankSkills` puro + fallbackChain + sem-silêncio. `test:skillos-resolver` (19).
- **Fase 4 (mergeada #961):** AI Run estende `ai_usage_log` (D4) + `AiReliabilityKernel.run` (choke-point: validação+taxonomia+retry por política+AI Run). `test:skillos-reliability` (19).
- **Fase 5 (mergeada #962):** `skillos_model_profiles` + `SkillOsModelRouterService.route` + `SkillOsProviderHealthService` (circuit breaker derivado) + PRICES com Claude. `test:skillos-model-router` (19).
- **Fase 6 (mergeada #963):** `checkGrounding` (gate UNSUPPORTED_CLAIM §19) + `assessConfidence` (§21) + serviços grounding/confidence + kernel `spec.ground` opt-in. `test:skillos-grounding` (21).
- **Fase 7:** `SkillOsPlannerService.plan(orgId, user, {goal, steps:[{capabilityId, dependsOn?}]})` — objetivo + capabilities → `ExecutionPlan`: resolve cada passo via Resolver (F3), agrega risco/perfil de contexto, valida deps (dep inexistente/ciclo→blocked). NÃO executa (§12). Sem silêncio (§65): capability sem skill → passo unresolved + plano blocked + `unresolvedCapabilities`. Primitivas puras (`maxRisk`/`deepestProfile`/`validatePlanDeps`/`topoSortSteps`/`ExecutionPlan`). Ponte `toPlaybook` projeta na forma do `ProcessRuntime`/`PlaybookEngine` (reuso F8, sem persistir/executar). Síntese CONSERVADORA (caller declara os passos; decompor objetivo aberto por IA é fase posterior). Rota `POST /api/skillos/plan`. `test:skillos-planner` (18). Guardrails RN-PLN-1..5. 0 mudança de comportamento.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F7 → **Fase 8 (Policy + Execution Bridge)**: Skill Result → `DecisionActionService`/`ApprovalPolicyService` → `CommandExecutorService` SEM bypass (ADR-159/§67). O plano (F7) vira execução governada — todo efeito de skill é um `command_type` atrás do choke-point único.

## Testes / CI

- `test:skillos-contracts` (31) + `-registry` (21) + `-resolver` (19) + `-reliability` (19) + `-model-router` (19) + `-grounding` (21) + `-planner` (18), determinísticos. AI-usage + billing + context + tenant-isolation verdes — 0 regressão.
