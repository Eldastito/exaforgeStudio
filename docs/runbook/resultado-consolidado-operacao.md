# Runbook — Resultado consolidado all-channels (ADR-186)

O lucro REAL do dono de varejo: core + lojas, ao lado do resultado core. Capstone da reconciliação
de P&L (revenue ADR-182 → cost ADR-184 → bottom line ADR-186). Aditivo/reversível. Convenções:
isolamento multi-tenant, RN-004 (derivado por query), `business_signals` (nunca tabela de alerta
paralela), determinístico, **nunca inventa dinheiro/lucro**.

---

## 1. O que resolve

O DRE gerencial (`ManagerialDreService`) é CORE-only — exclui receita E custo das lojas físicas. O
resultado das lojas (`RetailStoreCostService`) vive numa tela à parte. Quem roda lojas via, no DRE,
um lucro que **não é o dele**. O ADR-186 dá o lucro CONSOLIDADO (core + lojas) **ao lado** do core.

## 2. Mapa dos serviços / pontos de código

| Peça | Onde | Papel |
| --- | --- | --- |
| `ConsolidatedResultService.monthly` | `src/server/ConsolidatedResultService.ts` | **F1** — compõe core (`ManagerialDreService`) + lojas (`RetailStoreCostService.allStoresResult`); `partial` + `doubleCountRisk`. |
| `FinanceSnapshotAdapter.dre.consolidated` | `src/server/FinanceSnapshotAdapter.ts` | **F2** — bloco `consolidated` (all_channels) ao lado do core no snapshot que o Diretor IA narra. |
| `ConsolidatedResultService.publishDoubleCountSignal` / `pass` | `ConsolidatedResultService.ts` | **F3** — sinal advisory de dupla contagem; `pass()` no Scheduler. |

## 3. Os números (o que significam)

- **`core.resultadoOperacional`** = resultado do DRE gerencial (canais core; **intacto**).
- **`consolidated.resultadoOperacional`** = `core + Σ resultado das lojas` (só soma os não-null) =
  o **lucro real** (all_channels).
- **`consolidated.partial`** = há loja com faturamento mas SEM resultado computável (sem margem/
  `avg_cost`) → o consolidado é parcial; **não inventa lucro de loja**.
- **`doubleCountRisk` / `doubleCountCategories`** = mesma categoria de custo (ex.: aluguel) aparece
  como `payable` E como custo fixo de loja → risco de subtrair 2×; **confira**.

## 4. O sinal (advisory)

`consolidated_result/double_count_risk` (`business_signals`, dedupe `consolidated_double_count:
<period>`) — publicado quando `doubleCountRisk`. `basis:hypothesis`, `impactAmount:null`, severity
`attention`. **Nunca** cria `decision_action` nem corrige sozinho. Self-healing: risco some →
`resolveByDedupe`; recorre → `reopenByDedupe` (respeita `dismissed` §65). `pass()` horário só pras
orgs com loja ativa.

## 5. Guardrails RN-CR (testados em `test:consolidated-result-hardening`)

1. **Aditivo** — não muta o resultado core (0-regressão).
2. **Escopo rotulado** — `core` × `all_channels`, jamais o mesmo número.
3. **Custo de loja honesto-null** — loja sem resultado computável → consolidado PARCIAL, não inventa.
4. **Dupla contagem DETECTADA** — nunca subtrai o mesmo custo 2× em silêncio; flag + sinal.
5. **Read-only/derivado (RN-004)** — só query.
6. **Nunca inventa dinheiro/lucro** — sem dado → parcial/null explícito.
7. **Isolamento por org; determinístico; honesto.**

## 6. Troubleshooting

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| Consolidado marcado `partial` | loja com faturamento sem margem/`avg_cost` | Cadastrar `gross_margin_percent` da loja (ou custo dos itens PDV via NF-e). |
| Sinal `double_count_risk` | mesmo custo como payable E custo de loja | Conferir se não é o mesmo aluguel/energia lançado 2× — remover de um dos lados. |
| Consolidado = core numa org com loja | loja sem faturamento no período OU sem resultado | Conferir fechamentos de caixa da loja + margem cadastrada. |

## 7. Track futuro (documentado)

- **Folded no `resultadoOperacional` do DRE** — hoje o consolidado é um read-model AO LADO; unificar
  exigiria resolver a dupla contagem por chave (não só detectar).
- **Rateio de payables org-wide por loja** — o ADR-185 dá a dimensão por TAG; o consolidado usa
  agregado.

## 8. Testes

- `test:consolidated-result` (F1) · `test:consolidated-snapshot` (F2) ·
  `test:consolidated-double-count-signal` (F3) · `test:consolidated-result-hardening` (F4 — RN-CR + fiação).
