# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 9 — Observability + Admin Master (em revisão/PR).
- **Última fatia:** F9 entregue (observabilidade de AI Runs no tenant + invariante §30/D5). F8 mergeada (#965).
- **Baseline:** `main` @ `51d73de` (pós F8).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1 (mergeada #958):** `src/server/skillosModel.ts` (puro) — contratos + guardas determinísticas + taxonomia AI-FAIL-1..6. `test:skillos-contracts` (31 checks).
- **Fase 2 (mergeada #959):** tabelas `skillos_capabilities`/`skillos_skills` + `SkillOsRegistryService` (registro/lookup/ciclo de vida/compat vertical+entitlement). Rota read-only. `test:skillos-registry` (21).
- **Fase 3 (mergeada #960):** `SkillOsResolverService.resolve` — escolha determinística de Skill (sem IA, §11) + `rankSkills` puro + fallbackChain + sem-silêncio. `test:skillos-resolver` (19).
- **Fase 4 (mergeada #961):** AI Run estende `ai_usage_log` (D4) + `AiReliabilityKernel.run` (choke-point: validação+taxonomia+retry por política+AI Run). `test:skillos-reliability` (19).
- **Fase 5 (mergeada #962):** `skillos_model_profiles` + `SkillOsModelRouterService.route` + `SkillOsProviderHealthService` (circuit breaker derivado) + PRICES com Claude. `test:skillos-model-router` (19).
- **Fase 6 (mergeada #963):** `checkGrounding` (gate UNSUPPORTED_CLAIM §19) + `assessConfidence` (§21) + serviços grounding/confidence + kernel `spec.ground` opt-in. `test:skillos-grounding` (21).
- **Fase 7 (mergeada #964):** `SkillOsPlannerService.plan` — objetivo→ExecutionPlan (resolve via F3, agrega, valida deps, sem silêncio) + `toPlaybook` (ponte F8). `test:skillos-planner` (18).
- **Fase 8 (mergeada #965):** `SkillOsExecutionBridge` — a ponte Skill/Plano → execução GOVERNADA, SEM bypass (ADR-159/§67). `propose` reusa `DecisionActionService.propose` (skill NUNCA executa direto — vira decision_action com política de aprovação); `execute` é passthrough puro pro `CommandExecutorService.execute` (guardas G1 autonomia/G2 execution_mode/G3 aprovado vivem LÁ — não reimplementadas). `proposePlanStep` (F7→F8): plano ready + passo resolvido propõe (correlationId do plano, ADR-158); blocked/unresolved não propõe. Nenhum executor/política paralelos (RN-BR-1..4). Inerte (nenhuma skill ligada ainda) → 0 mudança de comportamento. `test:skillos-execution-bridge` (13): propose reusa, SEM BYPASS (aprovada-sem-policy barrada, rejeitada barrada), cadeia completa (propose→aprovar→policy→execute→handler), proposePlanStep, isolamento. Runtime existente (command-executor/decision-actions/runtime-execute-e2e) verde — 0 regressão.
- **Fase 9:** `SkillOsObservabilityService.aiRuns` — visão OPERACIONAL das AI Runs pro TENANT na Central de Saúde (§17): status (ok/retried/fallback/blocked/failed), validação, grounding, failure class, fallback rate, successRate, avgConfidence, top skills e saúde de provider (REUSA `SkillOsProviderHealthService` F5). Tudo DERIVADO por query das linhas ricas de `ai_usage_log` (`run_id != null`) — ignora o legado do `recordUsage` (RN-OBS-3), sem tabela/contador/painel novos. **Invariante §30/Decisão D5 formalizado**: `assertTenantSafe` (guarda recursivo por denylist de chave de custo — cost/brl/usd/cents/price/token/…) LANÇA se um payload de tenant carregar custo financeiro; `aiRuns` se auto-guarda antes de devolver (defesa em profundidade, não só teste). O custo (R$/US$) segue SÓ no `AiUsageDashboardService` sob `requireMasterAdmin`. `RuntimeExceptionsService.indicators` ganhou 4 contadores de IA (aditivo, §30-safe). Rota `GET /api/health-center/ai-runs` (tenant, module-gated). `test:skillos-observability` (31): agregação, §30/D5 (guarda passa no tenant e LANÇA no payload admin), indicators aditivo, provider health, isolamento. `tsc` limpo; runtime-operations (indicators) + model-router/reliability verdes — 0 regressão.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F9 → **Fase 10 (Prompt versioning + Evals/Regression)**: versionar prompt por skill (`prompt_version` já existe no AI Run) + suíte de eval/regressão determinística (golden por skill; sombra/canary vem depois). ESTENDER o AI Run, sem motor de eval paralelo.

## Testes / CI

- `test:skillos-contracts` (31) + `-registry` (21) + `-resolver` (19) + `-reliability` (19) + `-model-router` (19) + `-grounding` (21) + `-planner` (18) + `-execution-bridge` (13) + `-observability` (31), determinísticos. Runtime governado (command-executor/decision-actions/runtime-execute-e2e) + runtime-operations (indicators) verde. AI-usage + billing + context + tenant-isolation verdes — 0 regressão.
