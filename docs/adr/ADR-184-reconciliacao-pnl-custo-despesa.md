# ADR-184 — Reconciliação do lado de CUSTO/DESPESA do P&L (resultado coerente e honesto)

**Estado:** **F0 (#1285)** · **F1 (#1286)** · **F2 (#1287)** · **F3 (#1288) MERGEADAS** · **F4 EM
PR** — sinal advisory de base incoerente. Falta só F5 (hardening + runbook). Plano F0–F5.
**Data:** 2026-08-21.
**Contexto:** companion do ADR-182 (que reconciliou os rails de RECEITA). Aditivo sobre ADR-128
(DRE gerencial `ManagerialDreService`), ADR-114 (`LossMarginService`/`loss_events`), ADR-125
(`payables` por competência), ADR-083 E1–E6 (`RetailStoreCostService` + `retail_store_*_costs`),
ADR-129 (`OwnerDrawService`). Aditivo/reversível. Convenções: isolamento multi-tenant, RN-004
(derivado por query), `business_signals` (nunca tabela de alerta paralela), determinístico, **nunca
inventa dinheiro/custo/lucro**.

---

## 1. O problema (o que a auditoria PROVOU)

O ADR-182 provou que a RECEITA vinha de rails que não conversam e a reconciliou em segmentos
explícitos. O lado de **CUSTO/DESPESA tem a MESMA doença — e pior**: o custo vive em **três stores
DISJUNTOS, sem dimensão compartilhada**, e só UM deles entra no resultado do DRE.

### 1.1. Os três stores de custo (sem dimensão comum)

- **`payables`** (`db.ts:6366-6380`) — org-level, `category` **texto livre** (sem enum/FK), `recurrence`
  como proxy fixo/variável. **Sem `store_id`, sem `cost_center_id`, sem `segment`.** É o **único**
  que alimenta a despesa do DRE (`ManagerialDreService.despesasSplit:45-52`). `CostCenterService`
  existe (`CostCenterService.ts:5-12`) mas **não** está ligado a `payables` (nenhuma coluna de join).
- **`retail_store_fixed_costs`** (`db.ts:6511-6520`: aluguel/energia/folha/…) + **`retail_store_variable_costs`**
  (`db.ts:6537-6547`: card_fee/pix_fee/tax_sale/…) — OpEx **por loja**, consumido só por
  `RetailStoreCostService`. **NÃO é dobrado no DRE gerencial.**
- **`loss_events`** (`db.ts:5903-5914`, driver enum merma|quebra|vencimento|furto|desconto|devolucao|
  calote|divergencia|retrabalho|no_show|outro) — org+período. Só `desconto`/`devolucao` chegam ao
  DRE (como DEDUÇÃO de receita, `ManagerialDreService:67-69`). **`merma`/`quebra`/`furto`/`calote`/
  `divergencia` — perdas reais — NUNCA entram no resultado.**

### 1.2. Os problemas REAIS (paralelos ao ADR-182)

**(A) Mismatch de escopo no resultado.** `ManagerialDreService.resultadoOperacional =
margemBruta(receita CORE − CMV core+comigo) − despesas(payables org-wide)` (`:74`). A RECEITA e o
CMV são **core-only** (o ADR-182 F3 já rotulou `scope:"core"`); as DESPESAS são **org-wide**. Quando
o rail de loja é material, o resultado subtrai despesas do negócio INTEIRO de uma margem de UM
canal. O rail de loja está **ausente dos dois lados** do resultado: `retail_daily_closings` **não
tem coluna de custo** (`db.ts:1760-1784`), e `retail_store_*_costs` existe mas não é folded. O
resultado é honesto **por linha**, mas a **base do bottom-line mistura escopos**.

**(B) CMV não confiável — custo desconhecido tratado como zero.** `coreRevCost` usa
`SUM(unit_cost*qty)` (`:29-35`), mas `unit_cost` é **frequentemente 0** (`OrdersService:103`
`r.unit_cost||0`; `ComigoMesaService:107` grava 0 fixo). Sem cobertura de custo, o CMV vira 0 e a
**margem bruta é SUPERESTIMADA** silenciosamente. O precedente correto já existe no repo:
`ContentRevenueAttributionService:76-78` trata `unit_cost<=0` como **custo desconhecido → margem
null** ("não inventa lucro"). O DRE não faz isso: soma 0 e segue.

**(C) Vazamento de perdas operacionais.** As perdas puras (`merma`/`quebra`/`furto`/`calote`/
`divergencia`) são registradas (`loss_events`, escritas por `BalcaoService`/`RetailReconciliationService`/
`ComigoPricingService`) mas **não descontam o resultado do DRE** — some do bottom-line sem aviso.

### 1.3. O que existe e é honesto (não regredir)

`RetailStoreCostService` **já se recusa a inventar lucro de loja**: sem `gross_margin_percent` nem
cobertura de `avg_cost`, `resultado`/`pontoEquilibrio` voltam **NULL** por design (`:31-35`,
`db.ts:6524-6527`). O `avg_cost` é **org-wide** (não por loja) e só existe com entrada de NF-e —
loja 100% Alterdata/PDV fica `avg_cost=0` (`:435-437`). Essa honestidade é PREMISSA do ADR-184.

---

## 2. Tese e escopo

O custo/despesa tem a MESMA forma do problema da receita: **rails disjuntos** (CMV, payables,
custos de loja, perdas operacionais) que **não convergem** num read-model reconciliado com
**segmentos** e **escopo explícitos**, e **honesto onde o custo é incomputável**. A correção
(espelhando `PnlReconciliationService`): um **read-model de custo RECONCILIADO** — decompõe por
natureza, rotula escopo, sinaliza mismatch/cobertura, e **nunca inventa custo/lucro** (custo
desconhecido ≠ zero; custo de loja incomputável fica null, como já é).

**Fora de escopo (agora):** reescrever o DRE ou o resultado (o número atual não muda — RN-PNL-C-6);
ligar `cost_centers` a `payables` (falta chave — track futuro documentado); ratear payables org-wide
por loja/canal (sem dimensão — impossível hoje, honesto); inventar `avg_cost` por loja.

---

## 3. Guardrails RN-PNL-C (duros — no header dos services + testados)

1. **Segmentos de custo, não um bolo.** Cada segmento (CMV core/comigo · payables · perdas ·
   custos de loja) vem de UMA fonte; nunca soma o mesmo custo 2×.
2. **Custo desconhecido ≠ custo zero.** `unit_cost<=0` dominante → CMV/`coverage` sinalizado como
   incompleto; margem afetada nunca é apresentada como fato (reusa o precedente do
   `ContentRevenueAttributionService`). Nunca fabrica custo/lucro.
3. **Escopo sempre rotulado.** A base do resultado do DRE (margem core − payables org-wide) é
   EXPLÍCITA; a ausência do rail de loja nos dois lados é sinalizada, nunca implícita.
4. **Read-only/derivado (RN-004).** Não muta `payables`/`loss_events`/`closings`/nada; só query.
5. **Perdas operacionais visíveis.** `merma`/`quebra`/`furto`/`calote`/`divergencia` aparecem na
   decomposição de custo — nunca somem em silêncio do quadro.
6. **0-regressão numérica.** As linhas atuais do DRE não mudam; adiciona decomposição + flags de
   cobertura/escopo, não números novos.
7. **Isolamento por org; determinístico; honesto** (sem dado → segmento 0/null explícito).

---

## 4. Reuso vs. novo

- **Reusar:** as queries que já existem (`ManagerialDreService.coreRevCost`/`despesasSplit`,
  `LossMarginService`/`loss_events`, `RetailStoreCostService` para custo de loja com sua
  honestidade-null, `ComigoHealthService.rangeResult` para custo Comigo); `business_signals` +
  `resolveByDedupe`/`reopenByDedupe` (sinal de mismatch/cobertura); `FinanceSnapshotAdapter.dre`
  (rotular escopo de custo, como o ADR-182 F3 rotulou o de receita).
- **Criar (aditivo, mínimo):** `PnlCostReconciliationService` (read-model de custo
  segment-explícito) — a única peça nova; espelha `PnlReconciliationService`.

---

## 5. Plano por fatias (fatia = 1 PR draft, com teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — `PnlCostReconciliationService.monthlyCost(orgId, period)` (EM PR).** Read-model derivado:
  `{ segments: { cogs:{core,comigo,total,coverage,unknownCostRisk}, operatingExpenses:{fixas,
  variaveis,total,byCategory}, operationalLosses:{total,byDriver}, storeCosts:{fixed,variable,
  cogs,coverage,total}|null }, total, excludedFromResultado, unknownCostRisk, scope, note }`. Reusa
  as queries existentes (`order_items.unit_cost`, `ComigoHealthService`, `payables` por
  competência, `loss_events`, `RetailStoreCostService.allStoresResult`). `coverage` = receita core
  com `unit_cost>0` / receita core total; `unknownCostRisk` = true quando há receita core mas
  `coverage<0.5` (CMV subestimado, margem inflada — nunca conserta, RN-PNL-C-2); `operationalLosses`
  exclui `desconto`/`devolucao` (já dedução de receita) e expõe as perdas puras (RN-PNL-C-5);
  `storeCosts` null onde `RetailStoreCostService` já devolve null (honesto). `total` = base de custo
  do DRE = `cogs + operatingExpenses` (perdas/loja SEPARADAS, não somadas — RN-PNL-C-1/3);
  `excludedFromResultado` torna explícito o que o resultado do DRE ignora.
  `test:pnl-cost-reconciliation` (24).
- **F2 — Coerência de custo no snapshot executivo (EM PR).** `FinanceSnapshotAdapter.dre` ganha
  `costScope` + `costScopeNote` (base do resultado = margem core − payables org-wide; perdas e
  loja fora) + `cmvCoverage` + `unknownCostRisk` + `excludedFromResultado` — derivados do read-model
  da F1 pro Diretor IA narrar a base do resultado sem fingir precisão (quando `unknownCostRisk`, a
  nota diz que margem/lucro NÃO são fato). **0-regressão**: só ADICIONA campos; as linhas do DRE e
  o `scope`/`scopeNote` de receita (ADR-182 F3) ficam intactos. `test:pnl-cost-snapshot-coherence`
  (12); `test:pnl-snapshot-coherence`/`test:business-health` sem regressão.
- **F3 — Perdas operacionais na foto de custo (EM PR).** `PnlCostReconciliationService.
  operationalLossesDetail` torna LEGÍVEL o vazamento: decompõe as perdas puras (merma/quebra/furto/
  calote/divergencia) por driver com o rótulo canônico (`DRIVER_LABEL` exportado do
  `LossMarginService` — fonte única, não duplica), ordenado desc, exclui desconto/devolucao (já
  dedução de receita). Surge no snapshot `dre.operationalLossesDetail`. NÃO muda o
  `resultadoOperacional` (RN-PNL-C-5/6 — só expõe o que já sai do lucro sem aviso); honesto sem
  perda. `test:pnl-operational-losses` (12); `test:loss-margin` sem regressão.
- **F4 — Sinal de base incoerente (advisory) (EM PR).** `PnlCostReconciliationService.
  publishCostCoherenceSignal` — quando a cobertura de CMV é baixa (`unknownCostRisk` → margem/lucro
  não confiáveis), publica `business_signals` (`pnl_cost/base_incoherent`, `basis:hypothesis`,
  `impactAmount:null`, severity attention) pro dono CADASTRAR os custos; nunca corrige sozinho (zero
  `decision_action`, não inventa custo). Self-healing (`resolveByDedupe` quando o custo é cadastrado
  / `reopenByDedupe` quando recorre, respeita `dismissed` §65); dedupe por período. `pass()` no
  Scheduler (só orgs que venderam no mês). `test:pnl-cost-coherence-signal` (11).
- **F5 — Hardening + runbook (FECHA o ADR-184).** `test:pnl-cost-reconciliation-hardening` —
  doc-of-record executável: (A) codifica RN-PNL-C-1..7 como regressão sobre os serviços reais
  F1–F4 + (B) fiação (`pass` no Scheduler, testes wired, runbook/ADR presentes) + runbook
  `docs/runbook/pnl-custo-operacao.md` (mapa, a base do resultado, custo desconhecido, o sinal,
  guardrails, **track futuro**: dimensão de rateio via `cost_centers` + custo de loja no DRE).

**Critério de sucesso:** um read-model de custo segment-explícito e coerente; a base do resultado
do DRE fica AUTO-DESCRITA (escopo + cobertura de CMV); custo desconhecido e perdas operacionais
NUNCA somem em silêncio; nunca inventa custo/lucro; zero regressão no número atual.
