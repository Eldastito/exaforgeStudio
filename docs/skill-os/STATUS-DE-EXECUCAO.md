# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 5 — Model Router + Provider Health (em revisão/PR).
- **Última fatia:** F5 entregue (router + circuit breaker). F4 mergeada (#961).
- **Baseline:** `main` @ `b04f161` (pós F4).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1 (mergeada #958):** `src/server/skillosModel.ts` (puro) — contratos + guardas determinísticas + taxonomia AI-FAIL-1..6. `test:skillos-contracts` (31 checks).
- **Fase 2 (mergeada #959):** tabelas `skillos_capabilities`/`skillos_skills` + `SkillOsRegistryService` (registro/lookup/ciclo de vida/compat vertical+entitlement). Rota read-only. `test:skillos-registry` (21).
- **Fase 3 (mergeada #960):** `SkillOsResolverService.resolve` — escolha determinística de Skill (sem IA, §11) + `rankSkills` puro + fallbackChain + sem-silêncio. `test:skillos-resolver` (19).
- **Fase 4 (mergeada #961):** AI Run estende `ai_usage_log` (D4) + `AiReliabilityKernel.run` (choke-point: validação+taxonomia+retry por política+AI Run). `test:skillos-reliability` (19).
- **Fase 5:** tabela de plataforma `skillos_model_profiles` + `SkillOsModelRouterService` (registra catálogo, `route(requirements)` = casa `modelMeets` + saúde + custo/latência, determinístico, barra `open`, sem-silêncio) + `SkillOsProviderHealthService` (circuit breaker DERIVADO por query de `ai_usage_log.run_status`, RN-004 — healthy/watch/degraded/open/half_open; amostra insuficiente→healthy; open+última OK→half_open) + `PRICES` do `llm.ts` estendido com modelos Claude (RISK-3, aditivo). Primitivas puras (`rankModelCandidates`/`ModelRoute`/`ProviderHealthState`/`AIProviderContract`). Rotas `GET /api/skillos/models`, `POST /api/skillos/route`, `GET /api/skillos/provider-health/:provider`. `test:skillos-model-router` (19). Guardrails RN-MR-1..5 + RN-HLT-1..3. Catálogo inerte → 0 mudança de comportamento.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F5 → **Fase 6 (Grounding + Confidence)**: integra `ContextPacket`/`EvidenceReference` (PRD 3) — o *gate* `UNSUPPORTED_CLAIM` sobre a evidência (COMPOR, primitiva existe) + `groundingStatus` real no AI Run (hoje 'skipped') + Confidence Engine COMPONDO sobre `ImpactPrioritizationService.scoreSignal`/`confidenceBand`. Começa com Skills estruturadas.

## Testes / CI

- `test:skillos-contracts` (31) + `-registry` (21) + `-resolver` (19) + `-reliability` (19) + `-model-router` (19), determinísticos. AI-usage ledger(28)/dashboard(40)/quota(33) + billing + context + tenant-isolation verdes — PRICES/`ai_usage_log` aditivos, 0 regressão.
