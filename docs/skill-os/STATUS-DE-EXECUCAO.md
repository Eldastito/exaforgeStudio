# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 4 — Reliability Core (em revisão/PR).
- **Última fatia:** F4 entregue (AI Reliability Kernel + AI Run). F3 mergeada (#960).
- **Baseline:** `main` @ `80cfa07` (pós F3).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1 (mergeada #958):** `src/server/skillosModel.ts` (puro) — contratos + guardas determinísticas + taxonomia AI-FAIL-1..6. `test:skillos-contracts` (31 checks).
- **Fase 2 (mergeada #959):** tabelas `skillos_capabilities`/`skillos_skills` + `SkillOsRegistryService` (registro/lookup/ciclo de vida/compat vertical+entitlement). Rota read-only. `test:skillos-registry` (21).
- **Fase 3 (mergeada #960):** `SkillOsResolverService.resolve` — escolha determinística de Skill (sem IA, §11) + `rankSkills` puro + fallbackChain + sem-silêncio. `test:skillos-resolver` (19).
- **Fase 4:** AI Run estende `ai_usage_log` (Decisão D4 — colunas aditivas run_id/skill/capability/prompt_version/context_hash/validation/grounding/confidence/failure_class/retry/fallback/run_status/correlation; legado intacto) + `AiReliabilityKernel.run(orgId, spec, invoke)` — o choke-point de confiabilidade (Decisão D2, em volta do primitivo de `llm.ts`): validação de saída (§18) + taxonomia AI-FAIL (§17) + retry por política (§27, reusa `computeBackoffSeconds` do JobQueue) + registro da AI Run (RN-KER-1) + correlação (ADR-158). Grounding/Model Router são F5/F6 (grounding='skipped' aqui). `invoke` INJETADO → testável sem IA real. Opt-in, nenhum caller migrado → 0 mudança de comportamento. `test:skillos-reliability` (19). Guardrails RN-KER-1..4.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F4 → **Fase 5 (Model Router + Provider Health)**: provider abstraction (`invoke/health/estimateUsage/supports`) + model profiles + health + fallback + circuit breaker (a única primitiva de Kernel genuinamente nova — trip-signal de degradedChannels + error_class). Começa com os providers já usados (`llm.ts`: OpenAI/Google). Pricing ESTENDER com Claude (RISK-3).

## Testes / CI

- `test:skillos-contracts` (31) + `-registry` (21) + `-resolver` (19) + `-reliability` (19), determinísticos. AI-usage ledger(28)/dashboard(40)/quota(33) + billing + context + tenant-isolation verdes — as colunas aditivas em `ai_usage_log` não regridem nada.
