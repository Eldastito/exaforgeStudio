# ADR-182 — Reconciliação dos dois rails de P&L (receita coerente e honesta)

**Estado:** **F0 (auditoria + ADR, doc-only) — ESTA fatia.** Fatias seguintes fatia-por-PR.
**Data:** 2026-08-21.
**Contexto:** aditivo sobre ADR-128 (DRE gerencial), ADR-129 (Empresa×Proprietário), a Operação
da Rede (`RetailStoreCostService`) e a ponte opt-in `RetailRevenueBridgeService`. Aditivo/
reversível. Convenções: isolamento multi-tenant, RN-004 (derivado por query), `business_signals`
(nunca tabela de alerta paralela), determinístico.

---

## 1. O problema (o que a auditoria PROVOU — e refutou)

O ZapFlow mede "faturamento do mês" por **dois rails** que não conversam:

- **Rail A — core/online** (`orders` + `comigo_orders`): vendas do checkout/WhatsApp/Comigo.
- **Rail B — loja física** (`retail_daily_closings`): fechamento diário de caixa da loja (PDV/
  Alterdata), entra só quando a ponte `retail_revenue_bridge` (opt-in, `db.ts:918`) está ligada.

### 1.1. O que foi REFUTADO

A hipótese ingênua ("a ponte cria `orders` e dobra no DRE") é **falsa**:
- `RetailRevenueBridgeService` é **100% read-only** (`RetailRevenueBridgeService.ts:17-18`) —
  nunca cria `orders`/`order_items`.
- O DRE org-wide (`ManagerialDreService.coreRevCost:29-35`) lê **só** `order_items JOIN orders`
  (status `pago/em_preparo/entregue/concluido`) + Comigo, e **ignora os fechamentos** mesmo com
  a ponte ligada.

### 1.2. Os dois problemas REAIS

**(A) Soma silenciosa sem dedupe.** `LossMarginService.monthlyRevenue = a(orders) +
b(comigo) + c(fechamentos, se ponte on)` (`LossMarginService.ts:69-78`) **não deduplica** o rail
A contra o rail B. Como orders (online) e fechamentos (loja física) costumam ser vendas de
canais DISTINTOS, o `a+b+c` normalmente está CORRETO — mas o risco de dobra é **latente e
silencioso**: se uma mesma venda existir nos dois rails, dobra sem aviso, e **não há chave de
correlação** pra detectar. Essa base alimenta muita superfície: `SalesSnapshotAdapter.receitaMes`,
`SurvivalIndexService`, `DecisionSimulatorService.marginContext`, `BusinessHealthService`.

**(B) Divergência sem explicação no mesmo painel.** `BusinessSnapshotV2Service` (`:30-34`)
carrega lado a lado, no payload que o Diretor IA narra: `finance.dre.receitaLiquida` (**só core**,
exclui lojas) e `sales.receitaMes` (**com lojas**). Com a ponte ligada os dois números divergem
pela receita das lojas — **sem escopo declarado**. Se a UI/Diretor os apresenta como aditivos ou
o usuário compara a aba DRE com a Operação da Rede (`allStoresResult.totals.faturamento`), o
faturamento das lojas "aparece de novo".

### 1.3. Chaves de correlação hoje

Só existe `cash_events(source_type, source_id = closing.id)` com índice único (`db.ts:6415`) —
deduplica **reimport do mesmo fechamento**, NÃO fechamento-vs-order. `retail_daily_closings`
(`db.ts:1760`) não tem `order_id`/source id; `orders` (`db.ts:675`) não tem marcador de origem.
**Não dá pra de-duplicar transação-a-transação hoje** — falta chave.

---

## 2. Tese e escopo

Os dois rails são **SEGMENTOS** (canais distintos), **não duplicatas**. O erro não é "somar" —
é somar de forma **opaca, inconsistente e sem detecção de sobreposição**. A correção é um
**read-model de receita RECONCILIADO**: segment-explícito, única fonte da verdade, coerente entre
as superfícies, e **honesto sobre o risco de sobreposição** (detecta e sinaliza, nunca dobra em
silêncio nem "some" com o risco).

**Fora de escopo (agora):** dedupe transação-a-transação (exige nova chave de correlação
loja/dia↔order — fica como track futuro documentado); reescrever o DRE/Operação da Rede; unificar
`orders.total_amount` vs `order_items.line_total` (bases levemente distintas — documentar, não
mexer).

---

## 3. Guardrails RN-PNL (duros — no header dos services + testados)

1. **Segmentos, não duplicatas.** O total nunca soma o mesmo segmento duas vezes; cada segmento
   vem de UMA fonte (core/comigo/fechamentos).
2. **Sobreposição é DETECTADA e sinalizada** — nunca somada em silêncio nem descartada.
3. **Escopo sempre rotulado.** Receita do DRE (core) ≠ receita de vendas (all-channels); jamais
   apresentadas como o mesmo número nem somadas.
4. **Read-only/derivado (RN-004).** Não muta `orders`/`closings`/nada; só query.
5. **Ponte opt-in respeitada.** Ponte off → segmento de fechamentos ausente (0-regressão).
6. **0-regressão numérica.** O total reconciliado é idêntico ao `a+b+c` atual; muda a
   TRANSPARÊNCIA (decomposição + flag), não o número.
7. **Isolamento por org; determinístico; honesto** (sem dado → segmento 0/null explícito).

---

## 4. Reuso vs. novo

- **Reusar:** as queries que já existem (`LossMarginService` a/b/c, `RetailRevenueBridgeService.
  monthlyRevenue`, `ManagerialDreService`), `business_signals`+`resolveByDedupe`/`reopenByDedupe`
  (sinal de sobreposição), `BusinessSnapshotV2Service`/`FinanceSnapshotAdapter` (rotular escopo).
- **Criar (aditivo, mínimo):** `PnlReconciliationService` (read-model segment-explícito) — a
  única peça nova; os demais serviços passam a DELEGAR a ele (fonte única).

---

## 5. Plano por fatias (fatia = 1 PR draft, com teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — `PnlReconciliationService.monthlyRevenue(orgId, period)`.** Read-model derivado:
  `{ segments: {coreOrders, comigo, storeClosings}, total, bridgeEnabled, overlapRisk, note }`.
  Reusa as queries existentes; `total` = soma dos segmentos (0-regressão vs `a+b+c`);
  `overlapRisk` = true quando `coreOrders>0 && storeClosings>0` (única condição em que a dobra é
  possível), com nota honesta. `test:pnl-reconciliation`.
- **F2 — `LossMarginService.monthlyRevenue` DELEGA ao reconciliador** (fonte única). Total
  idêntico (RN-PNL-6); todos os consumidores passam a herdar a decomposição rastreável. Sem
  regressão nos testes que dependem do número.
- **F3 — Coerência no snapshot executivo.** `BusinessSnapshotV2Service`/`FinanceSnapshotAdapter`
  passam a rotular o ESCOPO (`dre.receitaLiquida` = core; `sales.receitaMes` = all-channels) e a
  expor a decomposição, pro Diretor IA NUNCA somar/confundir os dois (RN-PNL-3).
- **F4 — Sinal de sobreposição (advisory).** Quando `overlapRisk` é material, publica
  `business_signals` (`pnl_reconciliation/overlap_risk`, dedupe por org+período) pro dono
  conferir — honesto ("confira se uma venda não está contada em pedido E em fechamento");
  self-healing (`resolveByDedupe` quando o risco some). Nunca corrige sozinho.
- **F5 — Hardening + runbook.** `test:pnl-reconciliation-hardening` codifica RN-PNL-1..7 +
  runbook `docs/runbook/pnl-reconciliacao-operacao.md` (inclui o track futuro da chave de
  correlação para dedupe transação-a-transação).

**Critério de sucesso:** um único read-model de receita, segment-explícito e coerente entre DRE,
vendas e Operação da Rede; a sobreposição possível é DETECTADA e sinalizada (não some nem dobra
em silêncio); zero regressão no número atual.
