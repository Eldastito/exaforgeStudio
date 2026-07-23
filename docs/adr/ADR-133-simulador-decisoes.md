# ADR-133 — Simulador de Decisões ("decidir antes de gerar o problema")

- **Status:** Fatias 1 e 2 implementadas ("posso contratar?"; "posso comprar esse estoque?"). Fatias 3–4 planejadas.
- **Data:** 2026-07
- **Origem:** auditoria de veracidade da apresentação "ZappFlow Sobrevivência". O "Simulador de decisões" — o dono pergunta ANTES de agir ("posso contratar? posso comprar esse estoque? quanto vender para pagar a máquina?") — foi apontado como majoritariamente **ausente** (só existia o `RevenueSimulatorService`, de 2 alavancas de receita). Esta ADR cria o simulador de decisões de gestão prometido, uma pergunta por fatia.
- **Relacionadas:** ADR-126 (Central de Saúde), ADR-125 (Motor de Caixa), ADR-129 (Empresa × Proprietário), ADR-088 D5 (frugal/zero-token), ADR-091 §6 (IA sugere, humano decide).

## Decisões

### D1 — Determinístico, com a margem/receita REAIS do negócio
`DecisionSimulatorService` calcula com os números do próprio tenant, nunca com palpite. `marginContext(orgId)` resolve a **margem** e o **ticket médio** recentes (via `ComigoHealthService.breakEven`, com fallback para `AnalyticsService.getProfit`) e a **receita do mês** (`LossMarginService.monthlyRevenue`) — robusto entre verticais. **Zero-token**, isolado por `organization_id`.

### D2 — Fatia 1: "posso contratar?"
`hire(orgId, { monthlyCost })` responde quanto de venda ADICIONAL por mês a contratação exige, dada a margem atual: **extraReceita = custoMensal ÷ margem**. Devolve também: % a mais que a receita atual, ~vendas/dia extras (pelo ticket médio) e um **veredito** textual calibrado (viável / planeje / salto grande). Sem margem cadastrada, **recusa e pede os dados** (não inventa — grounding).

- Rota `POST /api/health-center/simulate/hire`.
- UI: cartão "Simulador — posso contratar?" na Central de Saúde (custo mensal → resultado).

### D2b — Fatia 2: "posso comprar esse estoque?"
`buyStock(orgId, { amount })` responde o impacto na **cobertura** (dias) e quanto tende a ficar **parado**. Cobertura = capital em estoque ÷ **CMV/dia** (CMV/dia ≈ receita do mês × (1 − margem) ÷ 30). O parado estimado usa a **fração atual de estoque sem giro** (`RetailImpactService.stockCapital`) aplicada à compra. Sem velocidade de venda (margem/vendas), devolve `coverageKnown=false` mas ainda alerta o parado pelo padrão — honesto sobre o que não dá para estimar.

- Rota `POST /api/health-center/simulate/buy-stock`.
- UI: o cartão da Central vira um simulador com duas perguntas ("Posso contratar?" / "Posso comprar estoque?").

### D3 — Próximas fatias (planejadas)
- **Retirar mais (pró-labore)?** — what-if projetando o efeito no caixa (evolui o `OwnerDrawService`, hoje retrospectivo).
- **Payback de investimento** — "quanto vender para pagar a máquina em N meses".

## Guardas
- IA sugere o contexto; o dono decide (ADR-091 §6). Grounded: sem margem, não simula.
- Determinístico (zero-token), isolado por `organization_id`.

## Testes
`test:decision-simulator` — **contratar:** sem margem recusa e pede dados; custo ≤ 0 rejeitado; com margem detectada (50%) a venda necessária = custo ÷ margem (5000/0,5 = 10000); ticket médio e vendas/dia; veredito; monotonicidade; isolamento. **comprar estoque:** valor ≤ 0 rejeitado; cobertura atual = capital ÷ CMV/dia (3000/50 = 60) e nova cobertura inclui a compra (90); parado estimado pela fração sem giro (33% → ~R$500); sem velocidade de venda devolve `coverageKnown=false` mas responde.
