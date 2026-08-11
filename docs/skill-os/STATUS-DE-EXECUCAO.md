# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 2 — Capability + Skill Registry (em revisão/PR).
- **Última fatia:** F2 entregue (catálogo persistido). F1 mergeada (#958).
- **Baseline:** `main` @ `18f9667` (pós F1).

## Entregue nesta sessão

- **Fase 0 (mergeada #957):** `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (7 grupos), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compat, rollout/rollback, fatiamento F1–F12.
- **Fase 1 (mergeada #958):** `src/server/skillosModel.ts` (puro) — contratos + guardas determinísticas + taxonomia AI-FAIL-1..6. `test:skillos-contracts` (31 checks).
- **Fase 2:** tabelas de plataforma `skillos_capabilities`/`skillos_skills` (sem org_id — §49; prefixo D1) + `SkillOsRegistryService` (registro validado/idempotente, lookup, ciclo de vida enable/disable, `skillsForCapability` p/ o Resolver F3, compat vertical + entitlement via `EntitlementService`). Rota read-only `GET /api/skillos/capabilities[/:id]`,`/skills` (gestor). Catálogo INERTE (nada registrado ainda) → 0 mudança de comportamento. `test:skillos-registry` (21 checks). Guardrails RN-REG-1..5.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aprovada a F2 → **Fase 3 (Capability Resolver)**: resolução conservadora (1 skill → resolve direto; depois ranking por regra — determinístico primeiro, §11). Consome `SkillOsRegistryService.skillsForCapability` + compat vertical/entitlement. **Nada de IA escolhendo skill** nesta fase.

## Testes / CI

- `test:skillos-contracts` (31) + `test:skillos-registry` (21), determinísticos. Suítes de contexto (PRD 3) + tenant-isolation (13) verdes.
