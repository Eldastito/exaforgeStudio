# Runbook — Reconciliação de CUSTO/DESPESA do P&L (ADR-184)

Companion do runbook de receita (ADR-182). Trata da **base de custo do resultado** do DRE: como o
custo é decomposto, por que a margem pode não ser confiável, e o que o resultado ignora. Aditivo/
reversível. Convenções: isolamento multi-tenant, RN-004 (derivado por query), `business_signals`
(nunca tabela de alerta paralela), determinístico, **nunca inventa custo/lucro**.

---

## 1. O problema (por que existe)

O custo vive em **três stores disjuntos** sem dimensão comum, e só um entra no resultado do DRE:

- **`payables`** (org-wide, `category` texto livre) — **única** fonte de despesa do DRE.
- **`retail_store_*_costs`** (OpEx por loja, via `RetailStoreCostService`) — **fora** do DRE gerencial.
- **`loss_events`** — só `desconto`/`devolucao` chegam ao DRE (dedução de receita); as perdas puras
  (`merma`/`quebra`/`furto`/`calote`/`divergencia`) **não descontam** o resultado.

Efeito: `resultadoOperacional = margemBruta(core-only) − despesas(org-wide)` mistura escopos, e o
CMV (`order_items.unit_cost`) é **frequentemente 0** → margem bruta **superestimada** em silêncio.

## 2. Mapa dos serviços / pontos de código

| Peça | Onde | Papel |
| --- | --- | --- |
| `PnlCostReconciliationService.monthlyCost` | `src/server/PnlCostReconciliationService.ts` | **F1** — read-model reconciliado: segmentos cogs/operatingExpenses/operationalLosses/storeCosts + `total` (base do DRE) + `excludedFromResultado` + `unknownCostRisk`. |
| `FinanceSnapshotAdapter.dre.*` (custo) | `src/server/FinanceSnapshotAdapter.ts` | **F2** — `costScope`/`costScopeNote`/`cmvCoverage`/`unknownCostRisk`/`excludedFromResultado` + **F3** `operationalLossesDetail` no snapshot que o Diretor IA narra. |
| `operationalLossesDetail` | `PnlCostReconciliationService` | **F3** — decompõe as perdas puras por driver (rótulo `DRIVER_LABEL` do `LossMarginService`, fonte única). |
| `publishCostCoherenceSignal` / `pass` | `PnlCostReconciliationService` | **F4** — sinal advisory `pnl_cost/base_incoherent` quando `unknownCostRisk`; self-healing; `pass()` no Scheduler. |

## 3. Os números (o que significam)

- **`total`** = base de custo do DRE = **CMV (core+Comigo) + despesas (payables)**. É o que o
  `resultadoOperacional` subtrai da receita core.
- **`cmvCoverage`** (0..1) = fração da receita core com custo de aquisição cadastrado. Baixo →
  `unknownCostRisk`: o CMV está subestimado e **margem/lucro NÃO são fato**.
- **`excludedFromResultado`** = `{ operationalLosses, storeCosts }` — o que o resultado do DRE
  **ignora** (perdas puras + rail de loja). NÃO somar no `total` (escopos distintos).
- **`operationalLossesDetail`** = as perdas puras por driver, com rótulo — o vazamento tornado legível.

## 4. O sinal (advisory)

`pnl_cost/base_incoherent` (`business_signals`, dedupe `pnl_cost_coherence:<period>`) — publicado
quando `unknownCostRisk`. `basis:hypothesis`, `impactAmount:null`, severity `attention`. **Nunca**
cria `decision_action` nem conserta sozinho. Self-healing: custo cadastrado → `resolveByDedupe`;
recorre → `reopenByDedupe` (respeita o `dismissed` humano §65). `pass()` horário só pras orgs que
venderam no mês.

## 5. Guardrails RN-PNL-C (testados em `test:pnl-cost-reconciliation-hardening`)

1. **Segmentos de custo, não um bolo** — cada segmento de UMA fonte; `total` não soma escopos distintos.
2. **Custo desconhecido ≠ custo zero** — cobertura de CMV baixa é sinalizada; margem afetada nunca
   é fato; nunca fabrica custo/lucro.
3. **Escopo sempre rotulado** — a base do resultado (margem core − payables org-wide) é explícita.
4. **Read-only/derivado (RN-004)** — não muta `payables`/`loss_events`/nada.
5. **Perdas operacionais visíveis** — merma/quebra/furto nunca somem do quadro.
6. **0-regressão** — as linhas do DRE não mudam; adiciona decomposição + flags; sinal é advisory.
7. **Isolamento por org; determinístico; honesto** (sem dado → segmento 0/null explícito).

## 6. Troubleshooting

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| Sinal `base_incoherent` recorrente | CMV sem cobertura (`unit_cost` 0) | Cadastrar os custos dos produtos (entrada/NF-e). O sinal resolve sozinho quando a cobertura sobe. |
| `storeCosts` null numa org com loja | loja sem `gross_margin_percent`/`avg_cost` | É honesto por design (`RetailStoreCostService`) — cadastrar margem/custo da loja pra ter CMV de loja. |
| Margem do DRE "boa demais" | CMV subestimado (custo 0) | Olhar `cmvCoverage`/`unknownCostRisk` no snapshot — a margem não é fato sem cobertura. |

## 7. Track futuro (documentado, fora de escopo do ADR-184)

- **Dimensão de rateio** — ligar `cost_centers` a `payables` (hoje sem coluna de join) pra apropriar
  despesa por segmento/loja.
- **Custo de loja no DRE** — folded do `RetailStoreCostService` no resultado, quando houver
  `gross_margin_percent`/cobertura de `avg_cost` por loja (hoje é rail paralelo).

## 8. Testes

- `test:pnl-cost-reconciliation` (F1) · `test:pnl-cost-snapshot-coherence` (F2) ·
  `test:pnl-operational-losses` (F3) · `test:pnl-cost-coherence-signal` (F4) ·
  `test:pnl-cost-reconciliation-hardening` (F5 — RN-PNL-C-1..7 + fiação).
