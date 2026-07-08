# ADR-068 — AnalyticsService — métricas de negócio agregadas

**Status:** Implementado.

**Origem:** Fase 3 do plano de produção — retrofit de decisão já em código, sem documentação. Sem métricas de vendas, atendimento e IA visíveis para o lojista, o SaaS vira caixa-preta: o dono paga a assinatura mês a mês e não sabe se está tendo ROI. Isso é churn silencioso — cancelamento no terceiro mês "porque não sinto diferença". O `AnalyticsService` foi o antídoto: transformar o que a operação já registra (tickets, pedidos, mensagens, orçamentos, reservas) num painel que responde "qual é o meu retorno" em segundos.

---

## Contexto

O ZappFlow é multi-tenant e roda em cima de SQLite embarcado (não temos data warehouse, não temos OLAP, não temos ClickHouse). O volume por tenant é modesto — hotel/loja de bairro / restaurante — na casa de centenas a poucos milhares de tickets/pedidos por mês. Nesse patamar, agregar **em SQL puro no request** cabe em dezenas de milissegundos e evita toda uma camada de pipeline (Kafka, materialized views, cron de rollup). Trade-off consciente: quando um tenant crescer para OLAP, este serviço quebra e precisará ser reescrito — decisão registrada abaixo.

Dimensões que o painel precisa cortar:

- **Período**: `today` / `week` (7d) / `month` (30d) / `all` — janela relativa ao *agora* do servidor (São Paulo, `TZ=America/Sao_Paulo` no boot). SQLite `datetime('now', '-N days')` sempre em UTC, mas como o boot fixa TZ do processo e o `date('now')` respeita esse TZ, o corte "hoje" bate com o dia comercial do lojista sem código extra de fuso.
- **Vendedor**: `getTeamPerformance` agrupa por `tickets.assigned_to`, junta com `users` para nome/cargo — leaderboard da equipe.
- **Produto**: `getProfit` agrupa `order_items` por `name_snapshot` (preservado no momento da venda — se o produto for renomeado depois, o histórico continua íntegro).
- **Canal**: `channelData` faz join `tickets -> contacts.channel_id` para mostrar origem (WhatsApp X, Instagram Y).
- **Estágio do funil**: `funnelByStage` e `stageVelocity` leem `ticket_stage_logs` — mostram onde a jornada trava.

## Decisão

**Formato e política:**

1. **Agregação síncrona, sem cache.** Cada `GET /api/analytics/*` reexecuta as queries. Cabe em ~50–200ms no volume atual. Cache introduziria staleness sem ganho perceptível para o usuário — o painel é olhado poucas vezes por dia por tenant.
2. **Retorno único e gordo em `getMetrics`.** Um único payload devolve 20+ campos (KPIs, sparklines de 7 dias, funil, motivos de perda, CSAT, bloco `hospitality`). Isso evita N chamadas do dashboard e mantém consistência de janela — todos os números do painel foram calculados no mesmo instante.
3. **`try/catch` por bloco, degradação silenciosa.** Cada métrica opcional (CSAT, orçamentos, reservas, hospitality) é envelopada — se a tabela ainda não existe (tenant novo, migration antiga), o campo volta zerado em vez de derrubar o painel inteiro. Ver `AnalyticsService.ts:225-291`.
4. **Deltas período-a-período reais.** `previousFilter` calcula a janela imediatamente anterior de mesmo tamanho; `pctDelta` devolve variação arredondada em 0.1%. `all` não tem "anterior" e devolve zeros.
5. **Sparklines de 7 dias pré-preenchidas com zero.** `buildDailySeries` alinha a série ao calendário — dia sem venda aparece como zero, não some. Sem isso o gráfico do dashboard mentiria.
6. **Métricas core**: receita paga (`paidRevenue`), ticket médio (`averageOrderValue`), volume por período, conversão da IA (`resolutionRateAI` = % de tickets **não** transferidos para humano), tempo médio de primeira resposta (query real sobre `messages`), mais/menos vendidos e margem por produto (`getProfit`).
7. **Margem só quando há dado de custo.** `getProfit` retorna `hasCostData: cost > 0` — o front esconde o card de lucro quando o lojista ainda não preencheu `unit_cost` no estoque, em vez de mostrar "margem 100%" enganosa.

## Consequências

**Positivas:**
- Zero infra nova. Todas as métricas vêm do SQLite que já existe.
- Consistência garantida: como é um único método, os números do topo do painel batem com os do gráfico e com o funil — não há corrida entre agregadores.
- Extensão barata: adicionar métrica é um `SELECT` a mais dentro do `try` correspondente; front consome o novo campo quando estiver pronto.
- `name_snapshot` em `order_items` blinda o relatório de mudanças de catálogo — histórico não se corrompe se o lojista renomear um produto.

**Trade-offs aceitos:**
- **Não escala além de ~100k tickets/mês por tenant.** As queries de funil e velocidade fazem `LEAD() OVER (PARTITION BY ticket_id)` e joins sem índice de covering. Quando o primeiro tenant grande aparecer, será preciso ou (a) materializar diariamente em tabelas de rollup ou (b) mudar para Postgres com views agregadas. Não é o problema de hoje.
- **Sem OLAP, sem cubo.** Não dá para pivotar por várias dimensões arbitrárias no runtime. O que não está no retorno de `getMetrics` não existe — dashboards ad-hoc dependem de mudança de código.
- **Sem precomputação.** Se o painel for aberto 500 vezes ao dia por um tenant grande, cada abertura repete o trabalho. Aceito enquanto o volume for baixo; revisitar quando o P95 do endpoint passar de 500ms.
- **Timezone é global do processo.** Multi-tenant com hotéis em fusos diferentes ainda vai reportar tudo em São Paulo. Fine para o Brasil; refazer quando entrarmos em internacional.
- **Filtros injetados por string.** `dateFilter` é concatenado no SQL. Como o valor vem de um `enum` fechado (`today/week/month/all`) validado antes, não há vetor de injection hoje, mas qualquer novo período tem que passar por `currentFilter` para manter a garantia.

## Testes

- `scripts/test-sales-analytics.ts` — cobre o núcleo do relatório "mais/menos vendidos" (a query espelha a de `getProfit`/rota `sales-analytics`): pedidos `cancelado`/`aguardando_pagamento` não contam, produto ativo com zero vendas aparece na lista dos menos vendidos, janela de 30 dias respeitada, isolamento por `organization_id`, produto inativo escondido.
- `scripts/test-sales-margin-trend.ts` — cobre margem por produto (avg_cost do estoque, cost_total, margin_percent), série temporal de tendência (receita/custo/lucro por dia), totais consolidados e formato do CSV de exportação. Verifica que produto sem venda ainda aparece com `avg_cost` correto para o lojista comparar preço-custo mesmo sem histórico.

**Lacunas honestas** (não cobertas por teste automatizado hoje):
- `getMetrics` completo — nenhum teste ponta-a-ponta chama o método e verifica o payload. Deltas, sparklines, funil, CSAT, hospitality e `getTeamPerformance` são cobertos apenas por revisão manual e pelo dashboard em staging.
- Consumidores (`BusinessContextService`, `RevenueSimulatorService`, `RevenueAuditService`, `RevenueIntelligenceService`, `AIOrchestratorService`) dependem do shape do retorno — qualquer renomeação de campo quebra silenciosamente essas rotas. Enquanto não houver teste de contrato, mudança em `getMetrics` exige `grep -rn "AnalyticsService\." src/server` e leitura de cada consumidor.
