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

## Fatia DI-3 — Loop fechado `[x]` ENTREGUE

- **`DecisionMetricsService.summary(orgId, {days})`** (`src/server/DecisionMetricsService.ts`) — métricas do ciclo Decidir→Executar→Monitorar→Aprender, **determinísticas e derivadas por query** (RN-004, sem contador mutável), agregando o que já foi medido:
  - **valor protegido** (PRD §36, argumento comercial): prejuízo evitado + custo evitado (+ receita recuperada), de `action_outcomes` (colunas ADR-152 F3.1).
  - **acurácia de previsão**: esperado × realizado (`action_outcomes`).
  - **materialização de risco**: dos `decision_risks` (DI-2), quantos materializaram.
  - **aceitação de recomendações**: `decision_actions` (created_by ai|rule) aceitas vs rejeitadas.
  - **cache hit-rate** do Evidence Layer: log append-only `evidence_cache_events` (gravado no `EvidencePackageService.build` quando o cache está ligado), derivado por COUNT.
- **Rota:** `GET /api/decision-intelligence/metrics?days=` (alimenta o card do Diretor IA / Central de Saúde — aba, sem tela nova, ADR-152 D8).
- **Teste:** `npm run test:decision-intelligence-di3` (16 checks). Migração aditiva (`evidence_cache_events`).
- **Sub-budgets de IA `[-]` MOVIDOS PARA DI-4:** research/deep_analysis/external_api só passam a ter gasto real quando a External Intelligence existir; construir o orçamento agora seria infraestrutura inerte (frugalidade, PRD §43). Entram junto da DI-4. Hoje o gasto de IA segue metrado e limitado por `PlanService.aiAllowed` + `ai_monthly_limit_cents`.

## Fatia DI-4 — External Intelligence `[~]` DESTRAVADA (ADR-156, aguardando aprovação)

Decisão do dono (2026-08-08): **compartilhado por vertical anonimizado, com ADR nova antes do código**. A ADR foi escrita: **`docs/adr/ADR-156-external-intelligence-vertical-compartilhada.md`** (é a "ADR de agregação anonimizada" que a ADR-079 D4 exigia). **Nenhum código até o dono aprovar a ADR.**

Sub-fatias (ver ADR-156 D8):
- **DI-4.1 `[x]` ENTREGUE** — gatilho **admin master** (D5). `vertical_intelligence` (compartilhada, **sem `organization_id`**) + `organization_contextualization` (por-org) + `ExternalResearchProvider` (interface + **stub determinístico**) + `researchAnonymize` (filtro PII + `assertNoTenantData`) + `VerticalIntelligenceService.runResearch` (escrita admin) + `ResearchBrokerService.resolve` (leitura tenant **read-only**, nunca chama provider) + dedup por fingerprint + freshness + opt-in. Rotas: `POST /vertical-intelligence/run` (master), `GET /vertical-intelligence` (master), `GET /external-evidence` (tenant). Teste: `npm run test:decision-intelligence-di4` (17 checks — inclui "compartilhado nunca tem org/PII", "1 pesquisa N contextos", "tenant não dispara provider").
- **DI-4.2 `[x]` ENTREGUE** — orçamento de pesquisa de **PLATAFORMA** (não por-org: quem dispara é o admin master). `research_usage_log` (append-only, sem org) + `platform_settings` (KV) + `ResearchBudgetService` (gasto do mês derivado por SUM; `status`/`canSpend`/`record`). `VerticalIntelligenceService.runResearch` **recusa antes de chamar o provider** quando o teto estoura (`budget_exceeded`). Rotas master: `GET/PUT /research-budget`. É o guardrail que precede o provider real (DI-4.4). Teste: `npm run test:decision-intelligence-di4-budget` (11 checks).
- **DI-4.3** — fio até o slot `externalEvidence[]` do Evidence Package + consumo pelo `DecisionEngine` só em L3+.
- **DI-4.4** (posterior, opt-in) — provider real (web-search) atrás da interface, gated por env.

Princípio de segurança (ADR-156 D1/D2): a camada compartilhada guarda **só pesquisa do mundo externo** (mercado/tendências), **zero** dado por-org/pessoal; o isolamento por `organization_id` permanece intacto para todo dado privado.

## Fora de escopo (frugalidade, PRD §43)

- **Tool Registry / capability dispatch** e **refactor de Unified Memory** (consolidar 8 tabelas de memória): alto custo/risco, ganho marginal incerto — adiados até necessidade concreta.
