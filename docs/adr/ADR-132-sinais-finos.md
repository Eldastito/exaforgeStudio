# ADR-132 — Sinais finos da Central de Saúde (precisão que a apresentação promete)

- **Status:** Fatia 1 implementada (recebíveis vencidos). Fatias 2–4 planejadas.
- **Data:** 2026-07
- **Origem:** auditoria de veracidade da apresentação "ZappFlow Sobrevivência". A Central de Saúde e o Índice já existem e são testados, mas alguns sinais eram **aproximados** demais para o que a apresentação afirma. Esta ADR os torna precisos, um por fatia.
- **Relacionadas:** ADR-126 (Central de Saúde), ADR-127 (Índice de Sobrevivência), ADR-125 (Motor de Caixa), ADR-088 D5 (frugal/zero-token).

## Contexto — o que a auditoria apontou

- "R$ Y **vencidos** a receber" → o código usava o **total em aberto**, sem recorte de vencimento.
- "Conversão de **orçamentos** caiu de X% para Y%" → não era calculada.
- "**Concentração** no maior cliente (% da receita)" → ausente do Índice.
- "R$ em estoque **sem giro**" → o cálculo real (`RetailImpactService.stalledCapital`) existe, mas não estava ligado à Central/Índice.

## Fatias

### Fatia 1 — Recebíveis vencidos ✅
`FinancialLedgerService.overdueReceivables(orgId)` soma as contas a receber **abertas com `due_date < hoje`** (o fiado é saldo corrente, sem vencimento por item, então fica de fora). `summary()` passa a expor `aReceberVencido` e `aReceberVencidoCount`.

- **Central de Saúde:** um gatilho `receber_vencido` ("R$ X já venceram…"), a prioridade de cobrança passa a **liderar pelo vencido** quando há ("Cobrar R$ X já vencido, de R$ Y a receber"), e o KPI "A receber" mostra o quanto está vencido.
- **Índice de Sobrevivência:** o componente `recebiveis` deixa de olhar só a razão a-receber/caixa e **penaliza pela fatia vencida** (até −50% do score se tudo estiver vencido). Orgs sem vencidos ficam inalteradas.
- Determinístico, isolado por `organization_id`.

### Fatia 2 — Conversão de orçamentos (planejada)
Calcular taxa e tendência de conversão de orçamentos (`quotes`) e ligar à Central.

### Fatia 3 — Concentração no maior cliente (planejada)
Componente de risco de concentração (% da receita no maior cliente) no Índice.

### Fatia 4 — Estoque sem giro conectado (planejada)
Ligar `RetailImpactService.stalledCapital` (capital parado sem saída há N dias) à Central e ao Índice, no lugar do capital total de estoque.

## Guardas
- Determinístico (zero-token), isolado por `organization_id`. Mudanças aditivas — orgs sem o sinal ficam inalteradas.

## Testes
- `test:business-health` — recebível vencido gera o KPI `aReceberVencido` (só o que passou do vencimento), o gatilho `receber_vencido` e a prioridade destacando o vencido.
- `test:survival-index` — recebível vencido derruba o componente de recebíveis e a nota registra o valor vencido.
