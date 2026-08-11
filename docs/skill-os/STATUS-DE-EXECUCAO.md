# SkillOS (PRD 4) — Status de Execução

_Fonte de verdade de estado entre sessões (§71). Nenhuma sessão futura deve depender da memória da IA._

## Estado atual

- **Fase:** 0 — Auditoria do codebase.
- **Última fatia:** Fase 0 concluída (auditoria completa).
- **Baseline:** `main` @ `4df6e9c` (pós PRD 3 F12).

## Entregue nesta sessão

- `docs/skill-os/ANALISE-PRD4-vs-CODEBASE.md` — matriz REUTILIZAR/ESTENDER/COMPOR/CRIAR/DEFERIR completa (6 áreas), duplicidades, riscos, decisões (D1–D8), migrations, serviços impactados, compatibilidade, rollout/rollback, fatiamento F1–F12.

## Achados-chave (resumo)

- ~75–80% já existe (reuso/composição). Net-new real: Capability Registry, Skill Registry+Manifest, Capability Resolver, Planner (síntese), Model Router/Profile/Provider Abstraction, Prompt versioning, Circuit Breaker, `withTimeout`, Grounding gate, Evals/Regression/Shadow, OCR.
- Mandatos de reuso: ADR-159 (choke-point de execução = §67), AC-A01 (fachada de contexto), convenção #12 (alertas em `business_signals`).
- §30 (custo só admin) já atendido por construção — formalizar como teste.
- Colisão de nome: `skills` = RH → **namespacing `skillos_`** (Decisão D1).

## Riscos abertos

- Executor de skill paralelo violaria ADR-159 (RISK-1). Kernel virar cadeia de 3 LLMs (RISK-2). Pricing sem Claude (RISK-3). Vazamento de R$ via evidência de sinal (RISK-4).

## Próxima ação

- Aguardar revisão da matriz. Aprovada → **Fase 1 (Core Contracts)**: tipos puros (`Capability`, `SkillManifest`, `SkillResult`, `ModelRequirements`, `ReliabilityResult`, failure taxonomy) + testes determinísticos, sem alterar comportamento.

## Testes / CI

- Fase 0 é docs-only (sem código, sem teste novo). Suítes de contexto (F1–F12 do PRD 3) permanecem verdes no `main`.
