# Decision Intelligence — Plano e Fatias (aditivo sobre ADR-135/136)

**Contexto:** consolidação proposta no PRD "ZapFlow Decision Intelligence Fabric 2.0". A análise comparativa (`ANALISE-COMPARATIVA-PRD-vs-REPO.md`) concluiu que ~85% já existe; este incremento constrói **só os slivers genuinamente novos**, como **extensão aditiva da ADR-136 (Decision & Action Ledger) + ADR-135 (Enterprise Intelligence Kernel)** — **sem** abrir ADR/módulo paralelo (decisão do dono: "estender ADR-136/152", 2026-08-08) e **sem** duplicar alertas/tarefas/scheduler/memória existentes.

**Decisões do dono (2026-08-08):**
- Governança: **estender ADR-136/152** (não abrir ADR-156).
- External Intelligence: **adiada** (DI-4). Mantém a restrição da ADR-079 D4 (cache cross-tenant exige ADR próprio).

**Legenda:** `[x]` entregue · `[~]` em andamento · `[ ]` planejado · `[-]` adiado.

---

## Fatia DI-1 — Fundação leve `[x]` ENTREGUE

Sem UI/menu novo. Backward-compat 100% (campos aditivos + cache opt-in).

- **Classificação de impacto L0–L4 + perfil de análise** — `ImpactPrioritizationService.levelFor(...)` (determinístico, zero-token). Cada prioridade do Pareto passa a carregar `impactLevel`/`impactLevelN`/`impactLevelLabel`/`analysis`. O `analysis` é o **roteador de profundidade** (aiDepth, externalResearch no/cache/yes, premortem/redTeam/advocate, deepAnalysis, humanApprovalRequired) que a DI-2 vai consultar.
  - Guardrail: o nível é **advisório** — o gate real de autonomia/RBAC continua em `ApprovalPolicyService`/`agent_policies` (PRD §35). `humanApprovalRequired` não autoriza nada; só sinaliza.
  - Regra: dinheiro sozinho chega no máximo a **L3**; **L4** exige severidade crítica combinada ou override de segurança/compliance (irreversibilidade/risco jurídico entram na DI-2).
- **Evidence Package v1 (interno)** — `EvidencePackageService.build(...)`: embrulha o `BusinessSnapshotV2Service` num pacote reutilizável com `generatedAt`/`expiresAt`/`freshness`/`confidence`/`sources`. Cache opt-in por org (`organization_settings.evidence_layer_enabled`, default 0) na tabela `evidence_packages` (UNIQUE por `org,subject`). Slots `externalEvidence`/`historicalEvidence` ficam vazios (adiados).
  - NÃO recalcula domínio (reusa o Snapshot V2). É cache derivado (pode sobrescrever; não toca em retenção).
- **Rota (read-only, sem menu):** `GET /api/decision-intelligence/evidence` e `GET /api/decision-intelligence/priorities`.
- **Teste:** `npm run test:decision-intelligence-di1` (25 checks — níveis L0–L4, cache hit/miss/force, freshness, confidence, sources, isolamento por org). CI: auto-derivado do `package.json` (ci-shard).
- **Arquivos:** `src/server/db.ts` (flag + tabela), `src/server/ImpactPrioritizationService.ts`, `src/server/EvidencePackageService.ts`, `src/server/routes/decisionIntelligence.ts`, `server.ts` (mount), `scripts/test-decision-intelligence-di1.ts`, `package.json`.

## Fatia DI-2 — O cérebro decisório `[x]` ENTREGUE

- **`DecisionEngine.analyze({ mode })`** (`src/server/DecisionEngine.ts`) — estratégias **Pre-Mortem / Red Team / Advocate** como **modos** (não agentes residentes, não tabelas próprias — PRD §13/§37), determinísticas (zero-token, rodam em CI sem chave de IA) sobre o Evidence Package (DI-1). Roteadas pelo nível de impacto: **L0/L1 não disparam análise profunda** (critério §8); `mode` explícito força uma estratégia. Síntese com postura advisória (proceed / proceed_with_caution / hold_for_human) — o gate real segue no RBAC/ApprovalPolicy (§35).
- **`decision_risks`** + **`DecisionRiskService`** (`src/server/DecisionRiskService.ts`) — o Pre-Mortem grava riscos previstos (probabilidade, indicador líder, limiar, mitigação) ligados opcionalmente a `decision_actions`; cada risco monitorável **publica em `business_signals`** (domain `decision`), reusando o ledger/alertas existente — nunca tabela de alerta própria (convenção nº 12). Ciclo predicted→materialized→resolved (resolve fecha o sinal via `resolveByDedupe`). Idempotente por `dedupe_key`, best-effort na publicação (convenção nº 7).
- **Banda de cenários** conservador/base/agressivo — `DecisionSimulatorService.scenarios(...)` (aditivo; o simulador clássico dá 1 número).
- **Rotas:** `POST /api/decision-intelligence/analyze`, `GET /api/decision-intelligence/risks`, `POST /api/decision-intelligence/risks/:id/resolve`.
- **Teste:** `npm run test:decision-intelligence-di2` (26 checks). Migração aditiva (`decision_risks`).

## Fatia DI-3 — Loop fechado `[ ]`

- Métricas de decisão (`prediction_accuracy`, `financial_loss_avoided`, `cache_hit_rate`) aditivas sobre `action_outcomes` + `AiUsageDashboardService`; card no Diretor IA / Central de Saúde (aba, sem tela nova — ADR-152 D8).
- Sub-budgets de IA (research/deep_analysis/external_api) aditivos sobre `AiQuotaSignalService`/`PlanService`.

## Fatia DI-4 — External Intelligence `[-]` ADIADA

- `ExternalResearchProvider` + Research Broker + cache por vertical (dedup por fingerprint, freshness). **Bloqueada** pela ADR-079 D4 (compartilhamento cross-tenant exige ADR próprio de isolamento/LGPD). Reabrir só com decisão explícita do dono.

## Fora de escopo (frugalidade, PRD §43)

- **Tool Registry / capability dispatch** e **refactor de Unified Memory** (consolidar 8 tabelas de memória): alto custo/risco, ganho marginal incerto — adiados até necessidade concreta.
