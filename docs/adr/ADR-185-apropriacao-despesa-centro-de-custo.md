# ADR-185 — Apropriação de DESPESA a centro de custo (a dimensão de rateio que faltava)

**Estado:** **F0 (ESTA, doc-only) EM PR.** Plano F0–F4.
**Data:** 2026-08-22.
**Contexto:** fecha o **track futuro** que a auditoria do ADR-184 apontou — "despesa org-wide **sem
dimensão** de rateio". Aditivo sobre a **Controladoria (PRD-E)**: `cost_centers`+`CostCenterService`
(registro da dimensão, PRD-E-007), `ConsumptionLedgerService.byCostCenter` (consumo de MATERIAL por
centro) e `payables`/`FinancialLedgerService` (despesa financeira). Aditivo/reversível. Convenções:
isolamento multi-tenant, RN-004 (derivado por query), CREATE-then-ALTER, `business_signals` (nunca
tabela de alerta paralela), determinístico, **nunca inventa despesa/rateio**.

---

## 1. O problema (o que a auditoria PROVOU)

A Controladoria já tem a DIMENSÃO (`cost_centers`, com vínculo opcional a departamento/loja) e já
apropria o **consumo de material** por centro (`ConsumptionLedgerService.byCostCenter:93`, route
`/controler/consumption/by-cost-center`). Mas a **despesa financeira** — o que o DRE realmente
subtrai (aluguel, folha, serviços, via `payables`) — **não tem cost center**:

- `payables` (`db.ts:6366-6380`) tem `category` (texto livre) e `recurrence`, mas **nenhuma coluna
  de centro de custo** (a auditoria do ADR-184 §1.1 confirmou: sem `cost_center_id`/`store_id`).
- `FinancialLedgerService.addPayable:87-94` grava a conta **sem dimensão**.
- `CostCenterService` (`:5-12`) se descreve como "a dimensão em que todo consumo, despesa e rateio
  futuro será apropriado" — mas o elo `payables → cost_centers` **nunca existiu** (grep zero).

**Efeito:** não dá pra responder "quanto o CENTRO X custou este mês" pelo lado financeiro — só pelo
consumo de material. O ADR-184 só conseguiu SINALIZAR a despesa como org-wide; aqui damos a chave.

## 2. Tese e escopo

Dar à despesa financeira a MESMA dimensão que o consumo já tem: um `cost_center_id` opcional em
`payables` + um relatório de **despesa por centro de custo** (espelha `byCostCenter`), com a fatia
**não apropriada** (`unallocated`) sempre visível — e um sinal advisory quando a maior parte da
despesa ainda não tem centro. Consumo (quantidade) e despesa (R$) ficam LADO A LADO no extrato do
centro, **nunca somados** (unidades distintas — RN-CC).

**Fora de escopo (agora):** ratear automaticamente uma despesa org-wide entre centros (exige regra
de rateio — a apropriação aqui é por TAG explícita do operador, nunca inventada); orçamento por
centro (`cost_centers` não tem valor de budget — track futuro); folded no `resultadoOperacional` do
DRE (o DRE gerencial segue org-wide; este é um corte GERENCIAL paralelo, 0-regressão).

## 3. Guardrails RN-CC (duros — no header dos services + testados)

1. **Apropriação é por TAG explícita, nunca inventada.** Sem `cost_center_id` → conta fica
   `unallocated` (honesto), nunca chuta um centro.
2. **Centro validado.** Só apropria a `cost_center` que existe, é da org e está ativo.
3. **`unallocated` sempre visível.** O relatório mostra a despesa sem centro — nunca esconde o que
   falta apropriar.
4. **Consumo (qtd) e despesa (R$) nunca somados.** Unidades distintas — reportados à parte.
5. **Read-only/derivado (RN-004).** O relatório é query; a TAG é um UPDATE aditivo.
6. **0-regressão.** `cost_center_id` nullable; o DRE e o caixa não mudam; corte gerencial paralelo.
7. **Isolamento por org; determinístico; honesto** (sem dado → 0/[] explícito).

## 4. Reuso vs. novo

- **Reusar:** `cost_centers`+`CostCenterService` (a dimensão + validação), `payables`/
  `FinancialLedgerService` (a despesa), o padrão `ConsumptionLedgerService.byCostCenter` (agrupar
  por centro), as rotas `/controler/*`, `business_signals`+`resolveByDedupe`/`reopenByDedupe`.
- **Criar (aditivo, mínimo):** coluna `payables.cost_center_id` + `expensesByCostCenter` +
  `CostCenterStatementService` (extrato do centro) + um sinal advisory de despesa não apropriada.

## 5. Plano por fatias (fatia = 1 PR draft, com teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — TAG + relatório de despesa por centro.** `ALTER TABLE payables ADD COLUMN cost_center_id`
  (nullable, aditive); `addPayable` aceita `costCenterId` (valida centro ativo da org — RN-CC-2) +
  `setPayableCostCenter(orgId, payableId, costCenterId|null)` (apropria/desapropria, valida);
  `FinancialLedgerService.expensesByCostCenter(orgId, {from,to})` → `{ items:[{costCenterId, name,
  total}], unallocated, total }` (competência do vencimento, `unallocated` = payables sem centro,
  RN-CC-3). Rota `GET /controler/expenses/by-cost-center` + `PUT /controler/payables/:id/cost-center`.
  `test:cost-center-expense`.
- **F2 — Extrato do centro (consumo + despesa lado a lado).** `CostCenterStatementService.statement
  (orgId, costCenterId, {from,to})` COMPÕE despesa financeira (F1, R$) + consumo de material
  (`ConsumptionLedgerService.byCostCenter`, QTD) — SEM somar (RN-CC-4), cada um com sua unidade e
  procedência. Rota `GET /controler/cost-centers/:id/statement`. `test:cost-center-statement`.
- **F3 — Sinal advisory de despesa não apropriada.** `CostCenterExpenseSignalService`/método —
  quando a fração `unallocated` da despesa do mês passa de um limiar, publica `business_signals`
  (`cost_center/unallocated_expense`, `basis:hypothesis`, `impactAmount:null`, severity attention)
  pro operador apropriar; nunca apropria sozinho (RN-CC-1). Self-healing (`resolveByDedupe` quando
  cai / `reopenByDedupe`); `pass()` no Scheduler (só orgs com centro de custo). `test:cost-center-signal`.
- **F4 — Hardening + runbook (FECHA o ADR-185).** `test:cost-center-hardening` codifica RN-CC-1..7
  + fiação + runbook `docs/runbook/centro-de-custo-operacao.md`.

**Critério de sucesso:** a despesa financeira ganha a mesma dimensão que o consumo — dá pra ver
"quanto cada centro custou" (R$) com a fatia não apropriada sempre honesta; consumo e despesa nunca
somados; nunca inventa apropriação; zero regressão no DRE/caixa.
