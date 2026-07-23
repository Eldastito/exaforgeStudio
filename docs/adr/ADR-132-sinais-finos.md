# ADR-132 — Sinais finos da Central de Saúde (precisão que a apresentação promete)

- **Status:** Completa — Fatias 1–4 (recebíveis vencidos; conversão de orçamentos; concentração no maior cliente; estoque sem giro conectado).
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

### Fatia 2 — Conversão de orçamentos ✅
`QuoteService.conversionStats(orgId, days=30)` calcula a **taxa** e a **tendência** de conversão, com base nos orçamentos **decididos** (aceito/recusado/expirado) por janela de envio — para não subestimar por causa dos que ainda estão em aberto. Compara a janela atual com a anterior (mesma duração) e só emite sinal com amostra mínima (≥3 decididos), evitando ruído.

- **Central de Saúde:** gatilho `conversao_caiu` ("Conversão de orçamentos caiu de X% para Y%") quando a queda é ≥ 8 pontos; `overview` expõe `conversao` (taxa atual/anterior, sinal, amostra) para a UI.
- **UI:** uma linha "Conversão de orçamentos: X%" na Central, com "(caiu de Y%)"/"(subiu de Y%)".
- Determinístico (zero-token), isolado por `organization_id`.

### Fatia 3 — Concentração no maior cliente ✅
`BusinessHealthService.customerConcentration(orgId, days=90)` soma as vendas pagas (`orders` + `comigo_orders`) na janela e mede a fatia do **maior cliente identificado** sobre a receita **total** (inclui venda anônima, para não superestimar). Retorna `{ topPct, topName, topRevenue, totalRevenue }`.

- **Central de Saúde:** gatilho `concentracao_cliente` ("Seu maior cliente (Nome) é X% da receita — risco de dependência") quando `topPct ≥ 40%`; `overview` expõe `concentracao`.
- **UI:** um cartão de atenção com o nome do maior cliente e a % da receita.
- Entregue como **sinal da Central** (não como novo componente do Índice) para não reponderar os 7 componentes existentes (peso 100) — uma mudança de produto que exigiria decisão à parte.
- Determinístico (zero-token), isolado por `organization_id`.

### Fatia 4 — Estoque sem giro conectado ✅
Liga `RetailImpactService.stockCapital` (capital **sem giro** = com saldo e **sem saída** há N dias) à Central e ao Índice, no lugar do capital **total** de estoque.

- **Índice de Sobrevivência:** o componente `estoque` passa a pontuar pelo capital **sem giro** (não pelo total). Assim, muito estoque **que gira** deixa de ser penalizado; só o dinheiro travado no produto errado pesa. A nota mostra "R$ X parados sem giro (de R$ Y em estoque)".
- **Central de Saúde:** gatilho `estoque_parado` ("R$ X parados em estoque sem giro (N itens)") quando o capital sem giro é material (≥ 15% da receita do mês, ou qualquer valor quando não há vendas); `overview` expõe `estoque` (total, sem giro, contagem).
- **UI:** cartão com o valor sem giro e o total de estoque.
- Determinístico (fato, não estimativa), isolado por `organization_id`.

## Guardas
- Determinístico (zero-token), isolado por `organization_id`. Mudanças aditivas — orgs sem o sinal ficam inalteradas.

## Testes
- `test:business-health` — recebível vencido gera o KPI `aReceberVencido` (só o que passou do vencimento), o gatilho `receber_vencido` e a prioridade destacando o vencido; conversão em queda vira o gatilho `conversao_caiu` e `overview.conversao` traz as taxas.
- `test:survival-index` — recebível vencido derruba o componente de recebíveis e a nota registra o valor vencido; muito capital **que gira** (com saída recente) NÃO é penalizado no componente de estoque.
- `test:business-health` (estoque) — capital sem giro material vira o gatilho `estoque_parado` e aparece em `overview.estoque`.
- `test:quote-service` — `conversionStats`: taxa atual/anterior, sinal de queda (deltaPts), amostra mínima (<3 decididos não gera taxa) e isolamento por org.
- `test:business-health` (concentração) — maior cliente = 80% da receita vira `concentracao_cliente` e aparece em `overview.concentracao`; receita pulverizada não dispara o alerta.
