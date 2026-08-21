# Runbook — Reconciliação dos rails de P&L (receita coerente)

ADR-182. Como o ZapFlow mantém a receita mensal **coerente e honesta** entre os dois rails que a
medem — sem dobrar em silêncio nem apresentar números que não batem.

## O problema em uma frase

A receita do mês vem de dois canais que não conversavam: **core/online** (`orders` + Comigo) e
**loja física** (`retail_daily_closings`, via a ponte opt-in `retail_revenue_bridge`). São
**segmentos distintos**, mas eram somados de forma opaca e sem detecção de sobreposição.

## Mapa dos serviços

| Fatia | Peça | Papel |
| --- | --- | --- |
| F1 | `PnlReconciliationService.monthlyRevenue` | Read-model **fonte única**: decompõe por segmento (`coreOrders`/`comigo`/`storeClosings`), `total`, `bridgeEnabled`, `overlapRisk`, `note`. |
| F2 | `LossMarginService.monthlyRevenue` | Passou a **delegar** ao reconciliador (número idêntico; todos os consumidores herdam a decomposição). |
| F3 | `FinanceSnapshotAdapter.dre` / `SalesSnapshotAdapter.receitaMes` | Rotulam o **escopo** (`core` × `all_channels`) — o Diretor IA nunca soma/confunde os dois. |
| F4 | `PnlReconciliationService.publishOverlapSignal` / `pass` | Sinal **advisory** de sobreposição (`business_signals`), self-healing; nunca corrige sozinho. |

## Os dois números de receita (e por que divergem)

- **`finance.dre.receitaLiquida`** — escopo **`core`**: pedidos + Comigo. **Exclui** fechamentos
  de loja. É o DRE gerencial (ADR-128).
- **`sales.receitaMes`** — escopo **`all_channels`**: core + fechamentos de loja (quando a ponte
  está ligada). Carrega `segments`, `bridgeEnabled` e `overlapRisk`.

Com a ponte ligada os dois **divergem pela receita das lojas** — isso é **correto e esperado**,
não um bug. Os escopos rotulados existem justamente pra ninguém somar um com o outro.

## O sinal de sobreposição (`pnl_reconciliation/overlap_risk`)

Quando um mês tem receita nos **dois** rails (`overlapRisk`), o `pass()` do Scheduler (só pras
orgs com a ponte ligada) publica um `business_signal` advisory pro dono conferir se **uma mesma
venda** não está registrada como pedido **e** como fechamento. É **hipótese** (`basis:hypothesis`,
`impactAmount:null`) — não afirma que há dobra, porque **não há chave** pra provar. Self-healing:
some o risco → resolve; recorre → reabre (respeita o `dismissed` humano, §65). **Nunca cria
`decision_action`** — o dono decide.

## Guardrails RN-PNL (o que o sistema garante)

1. Segmentos, não duplicatas — total nunca soma o mesmo segmento 2×.
2. Sobreposição é detectada e sinalizada, nunca somada em silêncio nem descartada.
3. Escopo sempre rotulado (`core` ≠ `all_channels`); os dois nunca são somados/confundidos.
4. Read-only/derivado — não muta `orders`/`closings`.
5. Ponte opt-in respeitada — off → sem segmento de loja (0-regressão).
6. 0-regressão numérica — `total` idêntico ao `a+b+c` legado.
7. Isolamento por org; determinístico; honesto (sem dado → 0/null explícito).

## Troubleshooting

- **DRE e "receita do mês" (vendas) não batem** → esperado quando a ponte está ligada: DRE é
  `core`, vendas é `all_channels`; a diferença é a receita de loja (ver `sales.receitaMes.segments`).
- **Recebi o aviso de sobreposição mas não há dobra** → o sinal é advisory (hipótese); se você
  confirmou que os canais são distintos, **dispense** (dismiss) — ele não reabre sozinho.
- **O aviso não aparece** → só dispara pras orgs com `retail_revenue_bridge=1` e quando há
  receita nos dois rails no mês corrente.

## Track futuro — dedupe transação-a-transação

Hoje **não há chave de correlação** entre um `retail_daily_closing` e o(s) `order`(s) que
representem a mesma venda (`retail_daily_closings` não tem `order_id`; `orders` não tem marcador de
origem). Por isso a sobreposição é **sinalizada, não corrigida**. Um dedupe exato exigiria
adicionar essa chave (ex.: `orders.source_channel`/`store_day_ref` ou um vínculo
loja+dia↔order) — fica como evolução futura, fora do escopo desta ADR.

## Testes (regressão)

`test:pnl-reconciliation` (17) · `test:pnl-delegation` (6) · `test:pnl-snapshot-coherence` (12) ·
`test:pnl-overlap-signal` (13) · `test:pnl-reconciliation-hardening` (RN-PNL-1..7 + fiação).
`test:loss-margin` (26) segue como regressão de 0-mudança de número.
