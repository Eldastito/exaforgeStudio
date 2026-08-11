# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 1 — Core Contracts (em revisão/PR).
- **Última fatia:** F1 entregue (contratos puros). Fase 0 mergeada (#957).
- **Baseline:** `main` @ `e0facfd` (pós Fase 0).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1:** `src/server/skillosModel.ts` (puro, sem DB/LLM) — contratos `Capability`, `SkillManifest`, `ModelRequirements`/`ModelProfile`, `SkillResult`, `ReliabilityResult`, `ConfidenceThresholds` + taxonomia de falhas AI-FAIL-1..6 + guardas determinísticas (`toolAllowedBySkill` §44, `retryPolicyFor` §27, `modelMeets` §22/23, `confidenceAction` §21, `validateCapability`/`validateSkillManifest`). REUSA `EvidenceReference` (contextModel) e a semântica `fact/estimate/hypothesis` (§20). `test:skillos-contracts` (31 checks). Zero arquivo existente alterado → 0 mudança de comportamento.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F1 → **Fase 2 (Capability + Skill Registry)**: `skillos_capabilities`/`skillos_skills` (tabelas prefixadas, Decisão D1), no padrão declarativo de `AnomalyDetectorRegistry`; enable/disable/lookup + compat vertical/entitlement. Ainda sem alterar os agentes existentes.

## Testes / CI

- `test:skillos-contracts` (31 checks, determinístico, sem DB/LLM). Suítes de contexto (PRD 3) seguem verdes.
