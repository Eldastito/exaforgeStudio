# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 3 — Capability Resolver (em revisão/PR).
- **Última fatia:** F3 entregue (resolução determinística). F2 mergeada (#959).
- **Baseline:** `main` @ `234adfc` (pós F2).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1 (mergeada #958):** `src/server/skillosModel.ts` (puro) — contratos + guardas determinísticas + taxonomia AI-FAIL-1..6. `test:skillos-contracts` (31 checks).
- **Fase 2 (mergeada #959):** tabelas `skillos_capabilities`/`skillos_skills` + `SkillOsRegistryService` (registro/lookup/ciclo de vida/compat vertical+entitlement). Rota read-only. `test:skillos-registry` (21).
- **Fase 3:** `SkillOsResolverService.resolve(orgId, user, {capabilityId, vertical?, maxRisk?})` — escolhe a Skill DETERMINISTICAMENTE (sem IA, §11): disponibilidade da Capability → candidatas active/vertical → filtro risco/RBAC → `rankSkills` (determinística > barata > menor risco > versão) → vencedora + razão + alternativas + fallbackChain (§25, só declaradas existentes+active). Sem silêncio (§65): inexistente/indisponível/sem-skill → `resolved:false`+razão. Primitivas puras em `skillosModel` (`rankSkills`/`budgetRank`/`riskRank`/`isDeterministicSkill`/`SkillResolution`). Rota `POST /api/skillos/resolve` (inspeção, não executa). `test:skillos-resolver` (17). Guardrails RN-RES-1..5. 0 mudança de comportamento (catálogo inerte).

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F3 → **Fase 4 (Reliability Core)**: AI Run (ESTENDER `ai_usage_log` com run_id/skill/status de validação/grounding/confidence, Decisão D4) + schema validation + error taxonomy + retry (promover `JobQueueService.computeBackoffSeconds`) + correlação (ADR-158). Kernel DENTRO de `llm.ts` (Decisão D2) — ainda sem grounding avançado.

## Testes / CI

- `test:skillos-contracts` (31) + `test:skillos-registry` (21) + `test:skillos-resolver` (17), determinísticos. Suítes de contexto (PRD 3) + tenant-isolation (13) verdes.
