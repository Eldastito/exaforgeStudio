# ADR-188 — Projeção de Resultado do Mês & Ponto de Equilíbrio pleno (forward-looking)

**Estado:** **F0 #1306 · F1 #1307 · F2 #1308 MERGEADAS** · **F3 EM PR** — card "Projeção do mês" no
`ReportsPanel`. Plano F0–F4.
**Data:** 2026-08-24.
**Contexto:** capstone FORWARD do arco de reconciliação de P&L (ADR-182 receita → ADR-184 custo por
natureza → ADR-185 despesa por centro de custo → ADR-186 resultado consolidado). Todo esse arco é
BACKWARD (o que já aconteceu). Falta a pergunta que o dono mais faz no meio do mês: **"no ritmo
atual, vou bater meu resultado?"** — o análogo em LUCRO do alerta de ruptura de CAIXA (ADR-125, já
provado valioso). Aditivo/reversível. Convenções: isolamento multi-tenant, RN-004 (derivado por
query), `business_signals` (nunca tabela de alerta paralela), determinístico, **nunca inventa
dinheiro** (sem receita → sem margem → sem ponto de equilíbrio; honesto-null, nunca 0 forçado).

---

## 1. O problema (o que a auditoria PROVOU)

O ZapFlow tem MOTOR de resultado e MOTOR de ponto de equilíbrio — mas nenhum PROJETA o mês:

- **`ManagerialDreService.monthly`** (`:93`) — o DRE gerencial de competência: `receitaLiquida`, `cmv`,
  `margemBruta`, **`despesasFixas`/`despesasVariaveis`** (o split que a ADR-184/185 alimentam),
  `resultadoOperacional`. É do PERÍODO fechado/corrente, **backward** — no meio do mês reflete só o
  que já ocorreu (receita parcial), não o fim do mês.
- **`ConsolidatedResultService.monthly`** (ADR-186) — core + lojas, também **backward**.
- **`ComigoHealthService.breakEven`** (`:71`) — ponto de equilíbrio **DIÁRIO**, mas usa um campo de
  custo fixo MANUAL de número único (`comigo_fixed_costs_monthly`) + margem de janela de 30 dias
  (Comigo/varejo). **Não compõe** a estrutura de custo real do DRE (despesas por natureza/centro),
  e é diário — não projeta o RESULTADO do mês.

**Nenhum serviço projeta o resultado de fim de mês** a partir do realizado-até-agora + custo fixo
do mês inteiro, nem calcula o ponto de equilíbrio na estrutura de custo PLENA (fixo × variável do
DRE). O dono só descobre que não bateu o resultado no fechamento — tarde para reagir.

## 2. Tese e escopo

Uma camada de LEITURA que PROJETA o resultado do mês por **run-rate** honesto: usa o realizado-até-
`asOf` (receita/CMV/despesa variável), projeta a receita de fim de mês pelo ritmo (dias corridos ×
elapsed), **mantém o custo fixo do mês inteiro** (competência, não escalonado), e deriva:
`resultadoProjetado`, `breakEvenRevenue` (custo fixo ÷ razão de margem de contribuição) e o
`pctToBreakEven` ao vivo. Sempre com **premissas + nível de confiança explícitos** (mesmo espírito
do Motor de Caixa — nunca um número "seco"). Um sinal proativo quando o mês PROJETA abaixo do ponto
de equilíbrio, cedo o bastante para reagir. **Reusa** o `ManagerialDreService`; nenhum motor novo.

**A conta (comportamento de custo, não "margem bruta ÷ receita" ingênua):**
- `contribuição = receitaLiquida − cmv − despesasVariaveis` (o que sobra por real vendido).
- `razão = contribuição / receitaLiquida` (razão de margem de contribuição; null sem receita).
- `breakEvenRevenue = despesasFixas ÷ razão` (a receita que zera o resultado).
- `receitaProjetada = receitaLiquidaMTD × (diasNoMês ÷ diasDecorridos)`.
- `resultadoProjetado = receitaProjetada × razão − despesasFixas`.

O custo fixo vem do PERÍODO INTEIRO (`ManagerialDreService.monthly(period).despesasFixas` já agrega
por competência do mês, independente do dia); só receita/CMV/despesa variável são MTD e sofrem
run-rate. Essa assimetria é o coração da honestidade da projeção.

**Fora de escopo (agora):** projetar o CONSOLIDADO com lojas (as lojas fecham por caixa mensal, não
casam com run-rate diário — fica em track); prever sazonalidade/tendência (a premissa é ritmo
constante, declarada); mutar o DRE (só leitura); decidir/executar corte de custo (advisory).

## 3. Guardrails RN-RP (duros — no header do service + testados)

1. **Nunca inventa dinheiro.** Sem receita no mês → razão null → SEM ponto de equilíbrio nem
   projeção (honesto-null, nunca 0/∞ forçado).
2. **Premissa + confiança explícitas.** Ritmo constante declarado; poucos dias decorridos →
   confiança baixa (`insufficient_elapsed`), nunca uma projeção "seca".
3. **Assimetria fixo × variável.** Custo fixo do mês inteiro (competência) NÃO é escalonado por
   run-rate; só receita/variável são MTD projetados. Nunca escalona custo fixo.
4. **DERIVADO (RN-004).** Compõe `ManagerialDreService`; não é flag/contador mutável.
5. **Advisory.** O sinal nunca bloqueia, nunca corta custo, nunca cria `decision_action`.
6. **Isolamento por org; determinístico; honesto** (asOf explícito → reprodutível).
7. **Reusa o motor de DRE (ADR-182/184/186)** — sem 2º motor de resultado, sem custo hard-coded.

## 4. Reuso vs. novo

- **Reusar:** `ManagerialDreService.monthly` (linhas do DRE, split fixo/variável), o padrão de
  `business_signals`+`resolveByDedupe`/`reopenByDedupe` (sinal advisory self-healing), o passe do
  `Scheduler`, a `FinanceSnapshotAdapter`/`routes/dre.ts` (superfície), o padrão de card do
  `FiscalProfilePanel`/views de finanças.
- **Criar (aditivo, mínimo):** `ResultProjectionService` (read-model de projeção + ponto de
  equilíbrio pleno) + um sinal advisory + um card na UI. Zero tabela nova (tudo derivado).

## 5. Plano por fatias (fatia = 1 PR draft, com teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — `ResultProjectionService.project(orgId, { period?, asOf? })` + a conta.** Read-model:
  `{ period, asOf, elapsedDays, totalDays, mtd:{ receitaLiquida, cmv, despesasVariaveis,
  despesasFixas, resultadoOperacional }, contributionRatio, breakEvenRevenue, projected:{ receita,
  resultado }, pctToBreakEven, onTrack, confidence, assumptions[], note }`. Reusa
  `ManagerialDreService.monthly`; honesto-null (sem receita → razão/breakEven null); confiança por
  dias decorridos. Rota `GET /api/dre/result-projection` (owner/admin; §73 dinheiro role-gated).
  `test:result-projection` (~15); `test:managerial-dre` sem regressão.
- **F2 — Sinal proativo "mês projeta abaixo do equilíbrio".** `publishResultProjectionSignal` — com
  dias decorridos suficientes E `resultadoProjetado < 0` (mês fura o equilíbrio), publica
  `business_signals` (`result_projection/below_breakeven`, `basis:hypothesis`, `impactAmount:null`,
  severity attention) pro dono reagir cedo; nunca corta custo nem cria `decision_action` (RN-RP-5).
  Self-healing (`resolveByDedupe` ao voltar pro azul / `reopenByDedupe` ao recorrer, respeita
  `dismissed` §65). `pass()` no Scheduler. `test:result-projection-signal` (~10).
- **F3 — UI: card "Projeção do mês".** Na view de finanças/DRE, um card que mostra
  `resultadoProjetado` + `breakEvenRevenue` + `pctToBreakEven` (barra) + premissas/confiança
  honestas. UI-only sobre a rota F1; tsc+build verdes.
- **F4 — Hardening + runbook (FECHA o ADR-188).** `test:result-projection-hardening` codifica
  RN-RP-1..7 + fiação + runbook `docs/runbook/projecao-resultado-operacao.md`.

**Critério de sucesso:** no meio do mês, o dono vê — num lugar só — o resultado que o mês PROJETA no
ritmo atual, quão longe está do ponto de equilíbrio pleno (custo fixo × variável reais do DRE) e um
nudge proativo quando o mês fura o azul, cedo o bastante pra reagir; sempre com premissa e confiança
explícitas, nunca um número inventado.
