# ADR-135 — Enterprise Intelligence Kernel (camada transversal aditiva)

- **Status:** Epic 1 / Fatia B1 implementada (Business Snapshot V2 + FinanceSnapshotAdapter + Diretor vê finanças sob feature-flag). Demais adapters e a camada de ação (sinais/decisões/aprovações) nas fatias seguintes.
- **Data:** 2026-07
- **Origem:** PRD "ZappFlow Enterprise Intelligence" (Agentes Setoriais, Orquestração Transversal). Lacuna nº1 do diagnóstico: **o Diretor IA não recebe caixa, DRE, contas a pagar/receber, compras nem operação** em seu panorama — hoje `ExecutiveAdvisorService` só via `BusinessContextService` (CRM/vendas/estoque/campanhas/agenda). Esta ADR abre a camada transversal, começando pela maior alavancagem de curto prazo: **conectar os motores financeiros que já existem ao Diretor**.
- **Relacionadas:** ADR-070 (BusinessContext/Diretor), ADR-125/126/128/129 (motores financeiros), ADR-131 (Tutor), ADR-085 (Impact Ledger). PRD Epics 0–2.

## Decisões

### D1 — Aditivo, sem reescrever
`BusinessContextService.build()` é **preservado**. Nada dos motores existentes é reescrito — os adapters apenas os **reusam** (read-only). Nenhum fluxo atual muda.

### D2 — Business Snapshot V2 (JSON por domínio, adapter falha isolado)
`BusinessSnapshotV2Service.build(orgId, period)` devolve `{ organization, period, dataQuality, domains, topPriorities }`. Cada domínio vem de um **adapter** que reusa serviços determinísticos e **falha isolado**: erro em um domínio devolve `{ available:false, error }` sem derrubar o snapshot. Fatia B1 entrega o domínio **`finance`**; sales/inventory/procurement/retail_ops/tasks entram em B2.

### D3 — FinanceSnapshotAdapter (fato × estimativa por métrica)
Reusa `FinancialLedgerService` (caixa, a receber/vencido, a pagar, entrou hoje), `CashForecastService` (dias de sobrevivência, primeira ruptura), `ManagerialDreService` (receita líquida, CMV, margem, resultado, sobra), `OwnerDrawService` (retiradas, pró-labore sustentável, alerta) e `BusinessHealthService` (status). Cada métrica carrega **`source` e `basis` (`fact`|`estimate`)** — caixa/contas são fato; previsão/DRE são estimativa. Zero recálculo, zero-token.

### D4 — Diretor consome o V2 sob feature-flag (desligada por padrão)
`ExecutiveAdvisorService.buildPanorama(orgId)` = `BusinessContextService.build()` + (se `organization_settings.diretor_snapshot_v2=1`) o **bloco financeiro V2** serializado, com instrução explícita: "use EXATAMENTE estes números; NUNCA invente; se faltar, diga que falta". `ask` e `briefing` passam a usar `buildPanorama`. **Flag desligada por padrão** — organizações existentes não mudam de comportamento (rollback = desligar a flag).

### D5 — API read-only + toggle
`GET /api/business/snapshot?period=YYYY-MM` (panorama estruturado, read-only), `GET/PUT /api/business/snapshot/flag` (liga/desliga o Diretor V2 — owner/admin). Isolado por `organization_id`.

## Consequências
**Positivas:** o Diretor IA passa a enxergar as finanças reais (caixa, DRE, vencidos, ruptura, retiradas) — a lacuna nº1 do PRD — reusando o que já existe, sem risco (read-only, flag off). Cria a fundação (`BusinessSnapshotV2` + adapters) sobre a qual os próximos domínios e a camada de ação (Epic 2) se conectam como adapters/políticas, não sistemas isolados.

**Trade-offs / escopo:** B1 entrega só o domínio `finance` e a leitura; os adapters de Sales/Inventory/Procurement/RetailOps/Tasks e as tabelas transversais (`business_signals`, `decision_actions`, approvals, outcomes, Pareto) ficam para as fatias seguintes. O teste valida o snapshot determinístico e a injeção no panorama; a narrativa do LLM em si não é testada (zero-token).

## Guardas
- Determinístico (zero-token); IA narra, não calcula. Isolado por `organization_id`.
- Aditivo; feature-flag off por padrão; adapter falha isolado.

## Testes
`test:business-snapshot` — o domínio `finance` reusa os motores (caixa 5000/fato, a pagar 2000, a receber com vencido 700, previsão como estimativa, DRE com origem); org vazia ainda gera snapshot; **flag desligada não altera o panorama do Diretor** (compatível); **ligada injeta o bloco V2 com o caixa REAL** e a instrução anti-invenção; isolamento por org.
