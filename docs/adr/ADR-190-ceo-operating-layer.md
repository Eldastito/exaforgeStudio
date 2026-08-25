# ADR-190 — CEO Operating Layer (Executive Business Operating System)

**Estado:** **F0–F3 FECHADAS** (#1341–#1344) + **F4 (Executive Business Snapshot) EM PR.** Camada
TRANSVERSAL de gestão executiva — composição sobre o que já existe, sem motores paralelos.
**Data:** 2026-08-25.
**Natureza:** aditiva, composicional, governada, orientada por exceção. **Não** é dashboard/BI novo.
Convenções herdadas: isolamento por org, RN-004 (derivado por query), `business_signals` (nunca alerta
paralelo), determinístico antes de LLM, nunca inventa dado (`null`/`unknown` ≠ 0), aditivo/reversível.

---

## 1. Contexto (o que a auditoria F0 provou)

`docs/prd/ANALISE-CEO-OPERATING-LAYER-vs-CODEBASE.md` mapeou o PRD contra o repo (3 auditorias
paralelas). Veredito: **~90% composição**. O código genuinamente novo cabe em ~4 primitivas. O PRD
superestima dois pontos que já existem:

- **Financeiro** é o braço MAIS consolidado (não o menos — §30 do PRD desatualizado): receita
  (`PnlReconciliationService`), custo (`PnlCostReconciliationService`+`payables`/`cost_centers`), margem
  (`ManagerialDreService`/`ConsolidatedResultService`), **caixa real** (`FinancialLedgerService.cashOnHand`),
  vencido (`overdueReceivables`), break-even (`ResultProjectionService`), e `FinanceSnapshotAdapter` já
  rotula `basis`/`scope`.
- **Priorização** já existe: `ImpactPrioritizationService.prioritize` (≤3 global + ≤3/domínio, L0–L4).

## 2. Decisões arquiteturais (D1–D9)

- **D1** — Executive Snapshot é serviço FINO read-only (§14), compõe `BusinessSnapshotV2Service.read`
  (por domínio) → mapeia a 3 pilares; cacheia via `EvidencePackageService`; nunca persiste o derivado.
- **D2** — PILAR é um MAPA determinístico `domain→pillar`, não motor.
- **D3** — Métricas ESTENDEM `BusinessGoalService.METRICS` (§9/§62) com `pillar`/`basis`/`availability`/
  `source`/`betterDirection`; **sem** `ExecutiveMetricRegistry` paralelo.
- **D4** — Exceção e prioridade REUSAM `BusinessSignalService.attention` + `ImpactPrioritizationService`
  (só projetam pra moldura executiva). Zero tabela de alerta nova.
- **D5** — Financeiro é composição sobre `FinanceSnapshotAdapter` + `default_rate` novo.
- **D6** — Visão = 3 colunas aditivas em `organization_settings` (sem tabela nova).
- **D7** — Fala Tu: a intent de negócio (roteada por `AIOrchestratorService`/`ExecutiveAdvisorService`)
  passa a consumir o Executive Snapshot determinístico (IA narra, não calcula — §43).
- **D8** — `null`/`unknown` de verdade (§8/§10/§31): sem fonte → `availability:'unavailable'` + `value:null`.
- **D9** — Key-person dependency (§38) DEFERIDA (shadow), fora do caminho crítico do North Star.

## 3. Guardrails RN-CEO-01..15

Composição não motor · null≠zero · fato≠hipótese · IA não calcula KPI · executado≠resultado ·
sugerir≠criar (meta/missão) · governança intacta · isolamento · dinheiro role-gated · sem fonte→unknown ·
sem sinal/executor/mission/learning paralelo. Codificados como regressão no hardening (F11).

## 4. Plano de fatias (18 do PRD → 11)

F0 auditoria (FECHADA) · **F1 Executive Metric Registry (EM PR)** · F2 métricas faltantes honestas ·
F3 Business Vision (FECHADA) · **F4 `ExecutiveBusinessSnapshotService` (EM PR)** · F5 exceções+constraint · F6 Mission Bridge ·
F7 financeiro executivo · F8 briefing · F9 Fala Tu intents + bloco "Hoje" · F10 golden path ·
F11 hardening+runbook. **Diferidas:** key-person dependency · briefing proativo · evidence-UI.

Defaults honestos adotados (dono delegou): `new_customers` = 1ª compra em `orders`; `default_rate` =
vencido ÷ total a receber; `churn_rate` = `unknown` + `cancellations` por tipo; visão = 3 colunas em
`organization_settings`; NPS = `unknown` (só há CSAT).

## 8. F4 — Executive Business Snapshot (esta fatia)

A PRIMITIVA CENTRAL (D1) que responde ao North Star (§4): *"Como está minha empresa?"* →
**3 pilares** (comercial/operações/financeiro), cada um com **indicadores** (via `measure()` da
F1/F2 — sem fonte → `value:null`, nunca 0, RN-CEO-11) + **metas** (agrupadas pela procedência de
pilar do próprio metric) + **exceções** (do feed `BusinessSignalService.attention`) + **prioridades**
(`ImpactPrioritizationService.prioritize` ≤3), mais **missões** (`FalaTuHomeService.missionsBlock`)
e a **visão** (F3). `ExecutiveBusinessSnapshotService.read` é FINO, READ-ONLY, composição PURA — não
persiste, não cacheia de novo (o `BusinessSnapshotV2.read` já cacheia por baixo), zero tabela nova.
Mapa DETERMINÍSTICO `domain→pillar` (D2, conservador: só o claramente comercial/financeiro sai de
`operations`; não mapeado → `operations` mas nada some do bloco global de atenção). **Saúde
QUALITATIVA** por pilar = rollup determinístico de FATOS já derivados (crítico se há exceção
`critical`; atenção se `risk`/meta `behind`; `ok` se há sinal sem exceção; **`unknown`** se o pilar
não tem indicador disponível, meta nem exceção — null≠zero também na saúde). Dinheiro role-gated
(§73/RN-CEO-13): rota `GET /api/executive/snapshot` é owner/admin; `includeMoney:false` REDIGE
valores BRL (indicador/meta/impacto) pra superfícies de menor privilégio reusarem a primitiva.
`test:executive-snapshot` (19). 0-regressão.

## 7. F3 — Business Vision (esta fatia)

A VISÃO é intenção HUMANA (§12): `ExecutiveVisionService.get/save` grava SÓ o que o dono escreveu
(nunca inventa; patch parcial; string vazia limpa; sem dado → campos null + `defined:false`).
Persistência mínima em **5 colunas aditivas** de `organization_settings` (D6 — sem tabela nova;
`vision_statement`/`vision_horizon`/`strategic_priority`/`vision_updated_at`/`vision_updated_by`);
snapshots derivados NUNCA moram aqui. Rotas `GET/PUT /api/executive/vision` ADICIONADAS ao router
`/api/executive` que JÁ EXISTE (prior art: briefing/effectiveness/ask via `ExecutiveAdvisorService` —
reuso pras futuras F8/F9), com `requireRole('owner','admin')` (§50). `test:executive-vision` (7).

## 6. F2 — Métricas executivas com fonte real

Adiciona ao registro (F1) os indicadores dos 7 executivos (§7) + §11 que faltavam, cada um sobre
system-of-record REAL, com `availability` honesta (RN-CEO-11/§31-33): COMERCIAL `sales_count`,
`new_customers` (1ª compra paga — §37), `average_ticket`; OPERAÇÕES `cancellations` (por tipo, `down`;
churn como TAXA fica `unknown` §36), `customer_satisfaction` (CSAT %; NPS `unknown` — só há CSAT);
FINANCEIRO `operating_cost` (`PnlCostReconciliationService`), `cash_balance` (`FinancialLedgerService.
cashOnHand`, fact; **não infere de receita** §32), `overdue_receivables` (fact), `default_rate`
(vencido÷a-receber, %). As financeiras só ficam `available` quando a fonte existe (payables/cash_accounts/
receivables) — sem fonte → `measure()` devolve `value:null`, nunca 0. `unit` widened p/ `percent`.
`catalog()` (metas) passa a filtrar só métricas `up` (não se define "meta" de aumentar inadimplência);
`executiveCatalog()` mantém todas. `test:executive-metrics-sources` (15). 0-regressão.

## 5. F1 — Executive Metric Registry

ESTENDE `BusinessGoalService.METRICS` (D3) com os descritores executivos, sem registry paralelo e sem
regressão (as 5 métricas existentes — revenue/appointments/content_revenue/content_leads/receivables —
ganham `pillar`/`basis`/`source`/`betterDirection`; fontes internas → `available` por padrão). Novos
públicos: `describe` · `availability` · `measure` (leitura HONESTA: sem fonte → `value:null`+`basis:'unknown'`,
RN-CEO-11) · `executiveCatalog` · `metricsByPillar`. Taxonomia `EXECUTIVE_PILLARS` (commercial/operations/
finance). `test:executive-metric-registry` (16). Sem UI, sem rota, sem tabela — fundação das fatias seguintes.
