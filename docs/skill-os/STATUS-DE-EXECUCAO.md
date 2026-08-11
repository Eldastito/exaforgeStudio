# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 6 — Grounding + Confidence (em revisão/PR).
- **Última fatia:** F6 entregue (gate UNSUPPORTED_CLAIM + Confidence Engine). F5 mergeada (#962).
- **Baseline:** `main` @ `1d987e7` (pós F5).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1 (mergeada #958):** `src/server/skillosModel.ts` (puro) — contratos + guardas determinísticas + taxonomia AI-FAIL-1..6. `test:skillos-contracts` (31 checks).
- **Fase 2 (mergeada #959):** tabelas `skillos_capabilities`/`skillos_skills` + `SkillOsRegistryService` (registro/lookup/ciclo de vida/compat vertical+entitlement). Rota read-only. `test:skillos-registry` (21).
- **Fase 3 (mergeada #960):** `SkillOsResolverService.resolve` — escolha determinística de Skill (sem IA, §11) + `rankSkills` puro + fallbackChain + sem-silêncio. `test:skillos-resolver` (19).
- **Fase 4 (mergeada #961):** AI Run estende `ai_usage_log` (D4) + `AiReliabilityKernel.run` (choke-point: validação+taxonomia+retry por política+AI Run). `test:skillos-reliability` (19).
- **Fase 5 (mergeada #962):** `skillos_model_profiles` + `SkillOsModelRouterService.route` + `SkillOsProviderHealthService` (circuit breaker derivado) + PRICES com Claude. `test:skillos-model-router` (19).
- **Fase 6:** GROUNDING + CONFIDENCE (COMPÕE sobre PRD 3). Primitivas puras em `skillosModel`: `checkGrounding` (gate UNSUPPORTED_CLAIM §19 — fato/estimativa tem de citar `EvidenceReference` que EXISTE; determinístico, sem NLP) + `assessConfidence` (§21 — reusa `confidenceBand`; grounding unsupported derruba a confiança → ação fallback). Serviços `SkillOsGroundingService` (check + evidenceFromPacket/evidenceFromRagHits, reusa evidenceFromRagHit) e `SkillOsConfidenceService` (assess + `fromSignal` compondo `ImpactPrioritizationService.scoreOne`). Kernel (F4) ganha `spec.ground` opt-in → grava `grounding_status` REAL na AI Run; `blockOnUnsupported` → AI-FAIL-3 (fallback). Sem `ground` → skipped (F4 inalterado). `test:skillos-grounding` (21). Guardrails RN-GND-1..3 + RN-CONF-1..4. 0 mudança de comportamento.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F6 → **Fase 7 (Planner)**: intent/goal → capabilities → ExecutionPlan. REUTILIZAR `ProcessRuntimeService`/`PlaybookEngine` (planos autorais) + CRIAR a camada de SÍNTESE goal→plano. Consome Context (PRD 3) + Resolver (F3). Não executa — planeja.

## Testes / CI

- `test:skillos-contracts` (31) + `-registry` (21) + `-resolver` (19) + `-reliability` (19) + `-model-router` (19) + `-grounding` (21), determinísticos. AI-usage + billing + context + tenant-isolation verdes — 0 regressão.
