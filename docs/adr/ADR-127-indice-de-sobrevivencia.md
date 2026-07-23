# ADR-127 — Índice de Sobrevivência Empresarial (placar 0-100)

- **Status:** Implementada (Fatias 1–2). F1: placar 0-100 ponderado, hasData/confiança, faixa, tendência, snapshot, exposição na Central. F2: componente de estoque/capital parado com dado real (Σ quantidade × custo médio vs. faturamento) e histórico do placar (`history` + snapshot-on-read + mini-gráfico na Central).
- **Data:** 2026-07
- **Origem:** PRD "Central de Sobrevivência e Decisão" — Épico 11. Um indicador único de 0 a 100, com faixas (saudável/atenção/risco/crítico), que **não prevê fechamento** — aponta **fatores de risco** e reforça o plano de ação.
- **Relacionadas:** ADR-126 (Central de Saúde — status por regra e prioridades), ADR-125 (Motor de Caixa — dias de sobrevivência, ruptura), ADR-114 (margem de perda), RIE/IQR (qualidade de receita), AnalyticsService (margem/lucro). ADR-088 D5 (frugalidade), ADR-091 §6 (orientativo, humano decide).

## Contexto

A Central de Saúde (ADR-126) já dá o status e as prioridades, mas o dono se beneficia de um **número único e memorável** para acompanhar no tempo — "meu índice subiu de 58 para 66". O Índice de Sobrevivência é esse placar: uma **composição ponderada** e transparente dos sinais que já calculamos, cada componente com peso explícito (PRD §18). É **orientativo**, não uma previsão jurídica/financeira — a comunicação sempre deixa isso claro.

## Decisões

### D1 — Composição ponderada, transparente e determinística
Score 0-100 = média ponderada de 7 componentes (pesos iniciais do PRD §18), cada um pontuado 0-100 por regra explícita a partir de sinal existente:

| Componente | Peso | Fonte |
|---|---|---|
| Caixa e dias de sobrevivência | 25% | ADR-125 (survivalDays, ruptura, saldo) |
| Margem e rentabilidade | 20% | AnalyticsService.getProfit (margem %) |
| Vendas, conversão e recompra | 20% | RIE/IQR (score de qualidade de receita) |
| Recebíveis e inadimplência | 12% | ADR-125 (a receber vs. caixa) |
| Estoque e capital parado | 10% | (sinal futuro; neutro enquanto sem dado) |
| Execução operacional | 8% | RIE (driver operacional) |
| Dependência do dono e qualidade dos dados | 5% | ADR-126 (dataQuality) |

Zero-token, isolado por `organization_id`.

### D2 — Sem dado ≠ nota ruim (neutro + confiança)
Componente sem dado disponível entra **neutro** (não pune nem premia) e é marcado `hasData=false`. O **nível de confiança** do índice reflete quantos componentes têm dado real. A comunicação orienta a completar o checklist (ADR-126) para o índice ficar fiel — nunca finge precisão (PRD §21/§22).

### D3 — Faixas orientativas + tendência
Faixas: **saudável ≥ 75**, **atenção ≥ 55**, **risco ≥ 35**, **crítico < 35**. Snapshot mensal/por-dia permite **tendência** (subindo/estável/caindo) — o que o dono acompanha. Nunca rotula "vai fechar": aponta o que puxa o índice para baixo e liga na ação (Central de Saúde).

### D4 — Reuso total (a Central mostra o placar)
O índice **não recalcula** nada: orquestra ADR-125/126/114 + RIE + Analytics. Aparece na **Central de Saúde** (placar + os componentes que mais pesam) e coexiste com o status por regra (ADR-126 D1) — o status é o alerta imediato; o índice é o acompanhamento no tempo.

## Escopo (faseamento)
- **Fatia 1 (nesta entrega):** `SurvivalIndexService.score()` (7 componentes ponderados, hasData/confiança, faixa) + snapshot/tendência + exposição na Central de Saúde (placar + breakdown) + `test:survival-index`.
- **Fatia 2:** refinar componentes fracos (estoque/capital parado, recompra, dependência do dono) com sinais dedicados; histórico com gráfico.
- **ADRs seguintes:** DRE gerencial; Empresa × Proprietário.

## Consequências
**Positivas:** placar único e memorável que engaja o dono; 100% reuso; determinístico e testável; reforça a Central e a narrativa de sobrevivência.

**Trade-offs / riscos:** composição pode simplificar demais → pesos e componentes **explícitos** e refináveis; dado incompleto → **neutro + confiança** e checklist; risco de virar "promessa" → comunicação **orientativa** (nunca previsão de fechamento).

## Guardas
- Determinístico e transparente (pesos + regra por componente visíveis).
- **Sem dado = neutro**, com nível de confiança explícito; nunca finge precisão.
- **Orientativo** (não prevê fechamento); liga sempre na ação da Central.
- Isolado por `organization_id`; frugal (zero-token).

## Testes
- `test:survival-index` — índice 0-100 na faixa certa (crítico com caixa em ruptura, saudável com caixa forte/margem boa); componente sem dado entra neutro e baixa a confiança; pesos somam 100; snapshot/tendência; isolamento por org.
