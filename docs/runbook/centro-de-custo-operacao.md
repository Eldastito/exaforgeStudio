# Runbook — Apropriação de despesa a centro de custo (ADR-185)

Como a DESPESA financeira ganha a dimensão de centro de custo que o CONSUMO de material já tinha na
Controladoria (PRD-E). Aditivo/reversível. Convenções: isolamento multi-tenant, RN-004 (derivado por
query), CREATE-then-ALTER, `business_signals` (nunca tabela de alerta paralela), determinístico,
**nunca inventa apropriação/dinheiro**.

---

## 1. O que muda e por quê

A Controladoria já tinha a DIMENSÃO (`cost_centers`) e já apropriava o CONSUMO de material por centro
(`ConsumptionLedgerService.byCostCenter`). Faltava a DESPESA financeira (`payables` — o que o DRE
subtrai). O ADR-184 só conseguiu SINALIZAR a despesa como org-wide; o ADR-185 dá a chave para
responder **"quanto o centro X custou"** pelo lado financeiro.

## 2. Mapa dos serviços / pontos de código

| Peça | Onde | Papel |
| --- | --- | --- |
| `payables.cost_center_id` | `db.ts` (ALTER nullable) | **F1** — a coluna de apropriação; contas existentes ficam `unallocated`. |
| `FinancialLedgerService.addPayable` / `setPayableCostCenter` | `FinancialLedgerService.ts` | **F1** — cria/apropria a conta a um centro ATIVO (valida; tag explícita). |
| `FinancialLedgerService.expensesByCostCenter` | `FinancialLedgerService.ts` | **F1** — despesa (R$) por centro no período + `unallocated` sempre visível. |
| `CostCenterStatementService.statement` | `CostCenterStatementService.ts` | **F2** — extrato do centro: despesa (R$) + consumo (qtd por produto+UoM), lado a lado, nunca somados. |
| `CostCenterExpenseSignalService` | `CostCenterExpenseSignalService.ts` | **F3** — sinal advisory quando a maioria da despesa está solta; `pass()` no Scheduler. |

## 3. Como usar (operador)

1. **Cadastrar centros** — Controladoria → Centros de Custo (`POST /api/controler/cost-centers`).
2. **Apropriar despesa** — ao cadastrar a conta (`POST /api/cash/payables` com `costCenterId`) ou
   depois (`PUT /api/cash/payables/:id/cost-center` com `{costCenterId}` ou `null` p/ desapropriar).
3. **Ver quanto cada centro custou** — `GET /api/cash/expenses/by-cost-center?from&to` (R$ por centro +
   `unallocated`) e `GET /api/controler/cost-centers/:id/statement` (extrato: despesa + consumo).
4. **Nudge automático** — se a maioria da despesa do mês ficar sem centro, o sistema publica um sinal
   (`cost_center/unallocated_expense`) em Atenção/Smart Inbox pra você apropriar.

## 4. Guardrails RN-CC (testados em `test:cost-center-hardening`)

1. **Apropriação por TAG explícita, nunca inventada** — sem `cost_center_id` → `unallocated`.
2. **Centro validado** — só apropria a centro que existe, é da org e está ativo.
3. **`unallocated` sempre visível** — o relatório nunca esconde o que falta apropriar.
4. **Consumo (qtd) e despesa (R$) nunca somados** — unidades distintas, reportados à parte.
5. **Read-only/derivado (RN-004)** — relatório é query; a tag é UPDATE aditivo.
6. **0-regressão** — `cost_center_id` nullable; DRE e caixa não mudam; sinal é advisory (zero `decision_action`).
7. **Isolamento por org; determinístico; honesto** (sem dado → 0/[]/null).

## 5. Troubleshooting

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| Sinal `unallocated_expense` recorrente | maioria da despesa sem centro | Apropriar as contas (`PUT .../cost-center`). O sinal resolve sozinho quando a fração cai. |
| `addPayable` volta `invalid_cost_center` | centro inexistente/inativo/de outra org | Usar um centro ATIVO da própria org. |
| Extrato do centro → 404 | centro inexistente/de outra org | Conferir o id do centro. |
| Consumo do extrato "não bate" com R$ | são dimensões distintas | Consumo é QUANTIDADE (por produto+UoM), despesa é R$ — nunca somados (RN-CC-4). |

## 6. Track futuro (documentado, fora de escopo do ADR-185)

- **Rateio automático** de uma despesa org-wide entre centros (exige regra de rateio — hoje a
  apropriação é sempre por tag explícita).
- **Orçamento por centro** (`cost_centers` não tem valor de budget hoje) → previsto × realizado.
- **Custo de loja folded no DRE** (track do ADR-184) — o extrato aproxima, mas o `resultadoOperacional`
  do DRE gerencial segue org-wide.

## 7. Testes

- `test:cost-center-expense` (F1) · `test:cost-center-statement` (F2) · `test:cost-center-signal` (F3)
  · `test:cost-center-hardening` (F4 — RN-CC-1..7 + fiação).
