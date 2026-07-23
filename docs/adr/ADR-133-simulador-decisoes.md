# ADR-133 — Simulador de Decisões ("decidir antes de gerar o problema")

- **Status:** Completa — Fatias 1–4 (contratar; comprar estoque; retirar mais; payback de investimento). Hardening: CMV/dia do `buyStock` em janela móvel de 30 dias.
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
`buyStock(orgId, { amount })` responde o impacto na **cobertura** (dias) e quanto tende a ficar **parado**. Cobertura = capital em estoque ÷ **CMV/dia**, com **CMV/dia = receita dos últimos 30 dias (janela MÓVEL) × (1 − margem) ÷ 30**. A janela móvel (`revenue30`, sobre `orders` + `comigo_orders`) — e não a receita do mês corrente — evita subestimar o CMV/dia no início do mês, o que superestimaria a cobertura (viés apontado na re-auditoria). O parado estimado usa a **fração atual de estoque sem giro** (`RetailImpactService.stockCapital`) aplicada à compra. Sem velocidade de venda (margem/vendas), devolve `coverageKnown=false` mas ainda alerta o parado pelo padrão — honesto sobre o que não dá para estimar.

- Rota `POST /api/health-center/simulate/buy-stock`.
- UI: o cartão da Central vira um simulador com duas perguntas ("Posso contratar?" / "Posso comprar estoque?").

### D2c — Fatia 3: "posso retirar mais?"
`withdraw(orgId, { amount })` é o **what-if** de uma retirada adicional agora: projeta o **caixa** (antes → depois) e o **% do resultado** que as retiradas passariam a representar, contra o **pró-labore sustentável** (30% do resultado, limitado ao caixa). Reusa `OwnerDrawService.summary` (retrospectivo) e transforma em projeção. Veredito calibrado: `ok` (cabe no teto) / `atencao` (passa dos 30%, abaixo de 70%) / `excesso` (sem caixa, resultado ≤ 0, ou acima de 70%).

- Rota `POST /api/health-center/simulate/withdraw`.
- UI: terceira aba do simulador ("Posso retirar mais?").

### D2d — Fatia 4: "quanto vender para pagar essa máquina?" (payback)
`payback(orgId, { amount, months=12 })` — receita total necessária = **investimento ÷ margem** (a margem é o que sobra de cada venda para amortizar). Em N meses, quanto de venda por mês (e % a mais que hoje, ~vendas/dia); e o **payback no ritmo de lucro atual** = investimento ÷ (receita do mês × margem). Sem margem, recusa e pede os dados.

- Rota `POST /api/health-center/simulate/payback`.
- UI: quarta aba do simulador ("Pagar um investimento?").

## Guardas
- IA sugere o contexto; o dono decide (ADR-091 §6). Grounded: sem margem, não simula.
- Determinístico (zero-token), isolado por `organization_id`.

## Testes
`test:decision-simulator` — **contratar:** sem margem recusa e pede dados; custo ≤ 0 rejeitado; com margem detectada (50%) a venda necessária = custo ÷ margem (5000/0,5 = 10000); ticket médio e vendas/dia; veredito; monotonicidade; isolamento. **comprar estoque:** valor ≤ 0 rejeitado; cobertura atual = capital ÷ CMV/dia (3000/50 = 60) e nova cobertura inclui a compra (90); parado estimado pela fração sem giro (33% → ~R$500); sem velocidade de venda devolve `coverageKnown=false` mas responde. **retirar mais:** valor ≤ 0 rejeitado; projeta o caixa (3000 − 1000 = 2000); retirar mais que o caixa é excesso; com resultado zerado qualquer retirada é excesso; veredito e nível presentes. **payback:** sem margem recusa; receita total = investimento ÷ margem (12000/0,5 = 24000); venda/mês em 12m = 2000; payback no ritmo atual = 12000/1500 = 8 meses; prazo maior reduz a venda/mês mas não o payback real.
