# ADR-186 — Resultado CONSOLIDADO (all-channels): o lucro real incluindo as lojas

**Estado:** **F0 MERGEADA (PR #1296)** · **F1 EM PR** — `ConsolidatedResultService.monthly`.
Plano F0–F4.
**Data:** 2026-08-24.
**Contexto:** capstone da reconciliação de P&L — fecha o **track futuro** do ADR-184 ("custo de loja
folded no DRE"). Aditivo sobre ADR-128 (`ManagerialDreService`, DRE gerencial core-only), ADR-083
E1–E6 (`RetailStoreCostService`, resultado por loja) e ADR-182 (rótulo de escopo core×all_channels).
Aditivo/reversível. Convenções: isolamento multi-tenant, RN-004 (derivado por query),
`business_signals` (nunca tabela de alerta paralela), determinístico, **nunca inventa dinheiro/lucro**.

---

## 1. O problema (o que a auditoria PROVOU)

O número que o dono de varejo dirige o negócio por — o **lucro** — está **incompleto**:

- `ManagerialDreService.monthly` (`:93`) devolve `resultadoOperacional` = margem CORE (pedidos +
  Comigo) − despesas (payables org-wide). É **core-only** (o ADR-182 F3 já rotulou `scope:"core"`):
  **exclui a receita E o custo das lojas físicas**.
- `RetailStoreCostService.allStoresResult` (`:796`) computa o `resultado` POR LOJA e o `totals.
  resultado` da rede — mas **NUNCA é folded no DRE**. Vive numa tela à parte (Operação da Rede).

Efeito: um dono que roda lojas vê, no DRE, um lucro que **não é o dele** (falta o resultado das
lojas). Pra saber o lucro REAL ele teria que somar duas telas na cabeça — e ninguém deduplica.

### 1.1. O risco REAL de somar as duas fontes: DUPLA CONTAGEM de custo

`resultadoOperacional` do core JÁ subtrai as **payables org-wide**. `resultado` da loja subtrai os
**`retail_store_fixed_costs`/`retail_store_variable_costs`** (por loja). As duas bases DEVERIAM ser
complementares (payables = custo de HQ/administrativo; store-costs = o específico da loja). Mas se o
dono lançou "aluguel da loja 1" como **payable** E como **custo fixo de loja**, somar os dois
resultados **subtrai o aluguel duas vezes** — e não há chave que prove o duplo lançamento. (É o
espelho, no lado do CUSTO, da sobreposição de RECEITA que o ADR-182 tratou.)

### 1.2. O custo de loja é honesto-null (premissa a preservar)

`RetailStoreCostService` **já se recusa a inventar lucro de loja**: sem `gross_margin_percent`/
cobertura de `avg_cost`, o `resultado` da loja volta **null** (`:31-35`). O consolidado herda essa
honestidade: onde a loja não tem resultado computável, o consolidado é **parcial e sinalizado**,
nunca completa com lucro inventado.

---

## 2. Tese e escopo

Dar ao dono o **lucro consolidado (all-channels)** — core + lojas — **ao LADO** do resultado core
(nunca no lugar: 0-regressão), escopo-rotulado como o ADR-182 fez pra receita, honesto onde o custo
de loja é incomputável, e **detectando a dupla contagem** de custo (payables de custo-de-loja
coexistindo com custos de loja) — nunca subtrai 2× em silêncio.

**Fora de escopo (agora):** mutar o `resultadoOperacional` core do `ManagerialDreService` (fica
intacto — o consolidado é um read-model NOVO ao lado); deduplicar transação-a-transação payable↔
store-cost (sem chave — detecta e sinaliza, como o ADR-182 fez); ratear payables org-wide por loja
(ADR-185 já dá a dimensão por TAG; aqui é agregado).

---

## 3. Guardrails RN-CR (duros — no header dos services + testados)

1. **Aditivo — não muta o resultado core.** O consolidado é read-model NOVO; o `resultadoOperacional`
   core do DRE fica idêntico (0-regressão).
2. **Escopo sempre rotulado.** `core` × `all_channels`; jamais apresentados como o mesmo número.
3. **Custo de loja honesto-null.** Onde `RetailStoreCostService` devolve null (sem margem/avg_cost),
   o consolidado é PARCIAL + sinalizado — nunca inventa lucro de loja.
4. **Dupla contagem DETECTADA.** Payables de custo-de-loja + custos de loja coexistindo → flag +
   nota; nunca subtrai o mesmo custo 2× em silêncio.
5. **Read-only/derivado (RN-004).** Só query; não muta DRE/lojas/nada.
6. **Nunca inventa dinheiro/lucro.** Sem dado → parcial/null explícito.
7. **Isolamento por org; determinístico; honesto.**

---

## 4. Reuso vs. novo

- **Reusar:** `ManagerialDreService.monthly` (resultado core), `RetailStoreCostService.
  allStoresResult` (resultado das lojas, já null-honesto), o padrão de rótulo de escopo do ADR-182 F3,
  `FinanceSnapshotAdapter.dre` (surfacar o consolidado ao lado do core),
  `business_signals`+`resolveByDedupe`/`reopenByDedupe` (sinal de dupla contagem), `payables.category`
  + categorias de `retail_store_fixed_costs` (heurística de dupla contagem).
- **Criar (aditivo, mínimo):** `ConsolidatedResultService` (read-model consolidado + detecção de
  dupla contagem) + um sinal advisory.

---

## 5. Plano por fatias (fatia = 1 PR draft, com teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — `ConsolidatedResultService.monthly(orgId, period)` (EM PR).** Read-model derivado:
  `{ core:{resultadoOperacional, scope:'core'}, stores:{resultado, faturamento, storesTotal,
  storesWithResult, materialMissing}, consolidated:{resultadoOperacional, partial,
  scope:'all_channels'}, doubleCountRisk, doubleCountCategories, note }`. `consolidated = core +
  stores.resultado` (só soma resultados de loja não-null); `partial:true` quando ≥1 loja tem
  faturamento mas resultado null (sem margem/`avg_cost`) — NÃO inventa lucro de loja (RN-CR-3/6);
  `doubleCountRisk` = categoria de `retail_store_fixed_costs` que também aparece em `payables` do mês
  (heurística `contains`, hipótese — RN-CR-4). Core INTACTO (0-regressão comprovada vs
  `ManagerialDreService`). Reusa `ManagerialDreService.monthly`/`RetailStoreCostService.
  allStoresResult`. `test:consolidated-result` (16); `test:managerial-dre`/`test:retail-store-result`
  sem regressão.
- **F2 — Consolidado no snapshot executivo.** `FinanceSnapshotAdapter.dre` ganha um bloco
  `consolidated` (all_channels) AO LADO do resultado core (que fica intacto — 0-regressão) +
  `doubleCountRisk`/`partial`/`scopeNote` — pro Diretor IA narrar o lucro REAL sem confundir escopos.
  `test:consolidated-snapshot`.
- **F3 — Sinal advisory de dupla contagem.** `ConsolidatedResultService.publishDoubleCountSignal`
  — quando o `doubleCountRisk` é material, publica `business_signals` (`consolidated_result/
  double_count_risk`, `basis:hypothesis`, `impactAmount:null`, severity attention) pro dono conferir
  se um custo de loja não está lançado 2×; nunca corrige sozinho. Self-healing; `pass()` no Scheduler
  (só orgs com loja). `test:consolidated-double-count-signal`.
- **F4 — Hardening + runbook (FECHA o ADR-186).** `test:consolidated-result-hardening` codifica
  RN-CR-1..7 + fiação + runbook `docs/runbook/resultado-consolidado-operacao.md`.

**Critério de sucesso:** o dono vê o lucro REAL (core + lojas) ao lado do core, escopo-rotulado,
parcial-e-honesto onde o custo de loja é incomputável, com a dupla contagem DETECTADA e sinalizada
— nunca inventa lucro nem subtrai custo 2× em silêncio; zero regressão no resultado core.
