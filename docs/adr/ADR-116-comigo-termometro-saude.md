# ADR-116 — Comigo: Termômetro de Saúde do negócio (Fatia 2)

- **Status:** Proposto (escopo aprovado; implementação neste PR)
- **Data:** 2026-07
- **Origem:** Fatia 2 do Comigo (ADR-111) — "termômetro de saúde completo". Implementa o ADR-088 D7.
- **Relacionadas:** ADR-088 D7 (termômetro, não gráfico), ADR-111 (faseamento), ADR-112 D3 (fiado é venda/margem, não caixa), PR #2 (custo por item → lucro real), PR #4 (`daySummary`).

## Contexto

O autônomo não quer gráfico — quer saber, num sinal, se o negócio vai **bem ou mal**, e o que fazer. O termômetro revela o número que ele nunca teve: *quanto sobra de verdade*, subindo ou caindo. Já temos o dado cru (o Balcão registra venda + custo por item; o fiado entra como venda). Falta a **leitura**.

## Decisões

### D1 — Sinal único: subindo / estável / caindo (toggle dia/semana/mês)
Um sinal, não um dashboard. Toggle de janela: **dia · semana · mês**.

### D2 — Pesar LUCRO, não faturamento (ADR-088 D7)
O termômetro sobe quando **sobra mais dinheiro**, não quando vende mais. Lucro = Σ(preço) − Σ(custo por item), usando o `unit_cost_snapshot` do Balcão (PR #2). Fiado conta como venda/margem no ato (ADR-112 D3) — o termômetro é de **resultado**, não de caixa.

### D3 — Comparar o MESMO período (sábado × sábado passado)
Obrigatório p/ negócio sazonal (ADR-088 D7): nunca comparar com o período imediatamente anterior.
- **dia:** hoje × **mesmo dia da semana passada** (7 dias atrás).
- **semana:** últimos 7 dias × os 7 anteriores.
- **mês:** últimos 30 dias × os 30 anteriores.
Sinal por variação de **lucro**: > +5% subindo · ±5% estável · < −5% caindo (limiar configurável). Base zero (negócio novo) → sobe se houver lucro.

### D4 — Ponto de equilíbrio + barra de meta ao vivo
O dono informa os **custos fixos mensais** (`comigo_fixed_costs_monthly` — aluguel, etc.). Deriva:
- custo fixo diário = fixos ÷ 30;
- margem média (janela recente) → **faturamento de equilíbrio** = fixo diário ÷ margem;
- **unidades de equilíbrio** = equilíbrio ÷ ticket médio → *"você precisa de R$420 ou 22 galetos pra empatar hoje"*;
- **progresso ao vivo** (o que já vendeu hoje ÷ meta) — a barra de meta do ADR-088 D7 ("12 de 22 pra empatar o dia").
Trabalha com chute: sem fixos informados, mostra a meta como "informe seus custos fixos p/ ver o ponto de equilíbrio".

### D5 — Uma frase + uma ação (zero-token)
Nunca só o número (ADR-088 D7). Uma frase curta derivada dos próprios números, por **template** (frugal — sem LLM):
- lucro sobe → *"Tá sobrando mais: seu lucro subiu X% no {período}. 🚀"*
- vendas sobem mas lucro cai → *"Vendeu mais e sobrou menos — o custo subiu. Revê o preço do que mais sai. 🔎"*
- tudo cai → *"Mais fraco que no mesmo {período} anterior. Manda o cardápio pros clientes pra dar um gás. 📣"*
- estável → *"Firme, no mesmo ritmo do {período} anterior."*

## Modelo de dados
- `organization_settings.comigo_fixed_costs_monthly REAL DEFAULT 0` (custos fixos p/ o ponto de equilíbrio).
- Sem tabela nova: o termômetro deriva de `comigo_orders` + `comigo_order_items` (status paid/done, por `created_at`).

## Serviço (`ComigoHealthService`)
- `rangeResult(orgId, from, to)` → `{ revenue, cost, profit, orders }` (status paid/done por data de venda).
- `trend(orgId, period)` → `{ signal, period, profit, prevProfit, profitDeltaPct, vendasDeltaPct }`.
- `breakEven(orgId, date)` → `{ dailyFixed, avgMargin, breakEvenRevenue, breakEvenUnits, achievedRevenue, achievedUnits, progress }`.
- `insight(orgId, period)` → `{ text }`.
- Endpoint `GET /api/comigo/health?period=dia|semana|mes`; setting em `PUT /api/comigo/settings`.

## Escopo (Fatia 2, fatiada)
- **Este PR:** termômetro (D1–D5) + custos fixos + UI aba "Saúde".
- **Próximas da Fatia 2:** Mesa/QR pay-first · Pix dinâmico (txid+webhook PSP) · sugestão LLM+RAG.

## Consequências
**Positivas:** entrega o payoff emocional do produto reusando 100% do dado já registrado; zero-token; ponto de equilíbrio dá meta concreta ao dia; comparação de mesmo período não mente em negócio sazonal.

**Trade-offs:** ponto de equilíbrio depende do dono informar os fixos (mitigado: mostra o resto sem eles); margem média de janela curta oscila no começo (amostra pequena) — aceitável, melhora com histórico.

## Guardas
- Lucro real (custo por item), não faturamento; fiado é venda, não caixa (coerência com ADR-112).
- Zero-token (template); isolamento por `organization_id`.
- Nunca só número: sempre frase + ação; nunca humilhar (guarda-corpo do tutor).

## Testes
`test:comigo-health` — lucro = receita − custo; comparação de mesmo período (hoje × 7 dias atrás); sinal subindo/estável/caindo pelo limiar; ponto de equilíbrio (unidades e faturamento) + progresso; frase coerente com os números; isolamento.
