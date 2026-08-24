# Runbook — Projeção de resultado do mês & ponto de equilíbrio pleno (ADR-188)

Capstone FORWARD do arco de reconciliação de P&L (ADR-182 receita → ADR-184 custo → ADR-185 centro
de custo → ADR-186 resultado consolidado — todos BACKWARD). Responde, no meio do mês, "no ritmo
atual, vou bater meu resultado?" — o análogo em LUCRO do alerta de ruptura de CAIXA (ADR-125).
Aditivo/reversível. Convenções: isolamento multi-tenant, RN-004 (derivado por query),
`business_signals` (nunca tabela de alerta paralela), determinístico, **nunca inventa dinheiro**.

---

## 1. O que resolve

O DRE (`ManagerialDreService`) e o resultado consolidado (ADR-186) são BACKWARD — no meio do mês
mostram só o que já ocorreu. O ponto de equilíbrio existente (`ComigoHealthService.breakEven`) é
DIÁRIO e usa um custo fixo MANUAL de número único. Nenhum serviço projetava o resultado de FIM de
mês nem o equilíbrio na estrutura de custo PLENA (fixo × variável do DRE). O ADR-188 dá isso.

## 2. Mapa dos serviços / pontos de código

| Peça | Onde | Papel |
| --- | --- | --- |
| `ResultProjectionService.project` | `src/server/ResultProjectionService.ts` | **F1** — read-model: run-rate da receita/variável + custo fixo do mês inteiro → resultado projetado + ponto de equilíbrio + confiança. Reusa `ManagerialDreService.monthly`. |
| `ResultProjectionService.publishResultProjectionSignal` / `pass` | `ResultProjectionService.ts` | **F2** — sinal advisory quando o mês projeta abaixo do equilíbrio; `pass()` no Scheduler. |
| `GET /api/dre/result-projection` | `src/server/routes/dre.ts` | **F1** — expõe o `project` (owner/admin; `?period`, `?asOf`; dinheiro §73). |
| Card "Projeção do mês" | `src/features/ReportsPanel.tsx` (`ResultProjectionCard`) | **F3** — resultado projetado + barra do equilíbrio + confiança/premissas. |

## 3. A conta (o que significa)

- **`contribuição`** = `receitaLiquida − cmv − despesasVariaveis` (o que sobra por real vendido).
- **`contributionRatio`** = `contribuição / receitaLiquida` (margem de contribuição; null sem receita).
- **`breakEvenRevenue`** = `despesasFixas ÷ contributionRatio` (a receita que zera o resultado).
- **`projected.receita`** = `receitaLiquidaMTD × (diasNoMês ÷ diasDecorridos)` (run-rate).
- **`projected.resultado`** = `receitaProjetada × contributionRatio − despesasFixas`.
- **ASSIMETRIA (RN-RP-3):** só receita/CMV/despesa variável são MTD e sofrem run-rate; o custo fixo
  vem do mês INTEIRO (competência — `ManagerialDreService.monthly` já agrega o período todo) e NÃO é
  escalonado. É o coração da honestidade.
- **`confidence`**: `no_revenue` (sem base) · `not_started` (mês não começou) · `insufficient_elapsed`
  (poucos dias) · `medium`/`high` (dias suficientes) · `actual` (mês fechado).

## 4. O sinal (advisory)

`result_projection/below_breakeven` (`business_signals`, dedupe `result_projection:below_breakeven`)
— publicado quando, com confiança média/alta, o resultado PROJETADO do mês é NEGATIVO. `basis:
hypothesis`, `impactAmount:null` (o número projetado vai na evidência — nunca inventa dinheiro
medido), severity `attention`. **Nunca** bloqueia, corta custo ou cria `decision_action`.
Self-healing: volta pro azul → `resolveByDedupe`; recorre → `reopenByDedupe` (respeita `dismissed`
§65). Dedupe rolante (sempre reflete o mês corrente). `pass()` horário só pras orgs com receita no mês.

## 5. Guardrails RN-RP (testados em `test:result-projection-hardening`)

1. **Nunca inventa dinheiro** — sem receita → razão/breakEven/projeção null (nunca 0/∞ forçado).
2. **Premissa + confiança explícitas** — poucos dias → `insufficient_elapsed`, nunca número "seco".
3. **Assimetria fixo × variável** — custo fixo do mês inteiro NÃO escalonado; só receita/variável run-rated.
4. **Derivado (RN-004)** — compõe `ManagerialDreService`; não é flag/contador mutável.
5. **Advisory** — o sinal nunca bloqueia, corta custo ou cria `decision_action`.
6. **Isolamento por org; determinístico** — `asOf` explícito → reprodutível.
7. **Reusa o motor de DRE** — sem 2º motor de resultado, sem custo hard-coded.

## 6. Troubleshooting

| Sintoma | Causa provável | Ação |
| --- | --- | --- |
| Card não aparece | sem receita no mês (`no_revenue`) ou rota falhou | Conferir se há vendas no período; a rota degrada em silêncio. |
| `confidence: insufficient_elapsed` | poucos dias decorridos | Esperado no começo do mês — a projeção ganha confiança com os dias. |
| `breakEvenRevenue` null | sem receita → sem razão de contribuição | Sem base pra ponto de equilíbrio; não é bug, é honestidade (RN-RP-1). |
| Resultado projetado muito otimista/pessimista | ritmo não uniforme (fim de mês concentra venda) | A premissa é ritmo constante (declarada); a confiança sobe perto do fim do mês. |
| Sinal `below_breakeven` não some após recuperar | ainda projeta negativo OU foi `dismissed` | Conferir a projeção atual; `dismissed` humano nunca é reaberto (§65). |

## 7. Track futuro (documentado)

- **Projetar o CONSOLIDADO (core + lojas, ADR-186)** — as lojas fecham por caixa mensal, não casam
  com run-rate diário; fica pra quando houver um modelo de ritmo por loja.
- **Ritmo por sazonalidade** — hoje a premissa é ritmo constante; um modelo de curva intra-mês
  (peso por dia da semana) melhoraria a projeção sem mudar o motor.

## 8. Testes

- `test:result-projection` (F1 — a conta, assimetria, honesto-null, confiança) ·
  `test:result-projection-signal` (F2 — sinal advisory, não-alerta-no-ruído, self-healing, `pass`) ·
  `test:result-projection-hardening` (F4 — RN-RP-1..7 + fiação de produção).
