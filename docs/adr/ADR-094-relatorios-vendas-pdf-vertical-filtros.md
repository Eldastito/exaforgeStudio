# ADR-094 — Relatórios de vendas: PDF com marca + cards por vertical + filtros

**Status:** Aprovado (aguardando implementação).

**Origem:** Itens #4 e #12 (parte de relatórios) do `docs/BACKLOG-CAMPO-TOULON.md`. O `ReportsPanel` hoje mostra 6 cards fixos iguais pra todo negócio, sem impressão e sem filtros. Lojista precisa imprimir (contador, arquivo, sócio) e ver métricas relevantes à sua vertical.

---

## Contexto

Estado atual (`src/features/ReportsPanel.tsx`):
- 6 cards fixos: Pedidos, Faturamento, Ticket médio, Pedidos pagos, Agendamentos, Contatos
- Formato "30 dias × Total" — sem escolha de período
- Sem impressão/PDF (só uma dica de exportar pro Google Sheets)
- Sem personalização por vertical
- `ReportPdfService.ts` existe mas serve o relatório premium do Radar, não o de vendas do dono

Problemas: uma loja de moda quer ver peça mais vendida e giro; um hotel quer ocupação e RevPAR; uma clínica quer no-show e taxa de retorno. Todos veem os mesmos 6 cards genéricos.

## Decisão

### 1. Impressão → PDF com marca (backend)

Gera PDF no backend (não `window.print()`), com:
- Cabeçalho: logo + nome da loja + período do relatório
- Cards + tabelas formatadas
- Rodapé: data de geração + "gerado por ZappFlow"

Reusa a infra do `ReportPdfService` (já gera PDF premium do Radar). Botão "Exportar PDF" no `ReportsPanel`. Respeita o `StorageService` (disco/S3) pra guardar o arquivo gerado, com download autorizado.

### 2. Cards personalizados por vertical

**Core (todas as verticais):** Faturamento, Pedidos (não cancelados), Ticket médio, Pedidos pagos.

**Adicionais por vertical:**

| Vertical | Cards extras |
|---|---|
| 🛍️ varejo / 👗 moda | Produto/peça mais vendida, Menos vendida, Giro de estoque, Vendas por categoria |
| 🏨 hospitalidade | Ocupação (%), Diária média, RevPAR, Reservas por período |
| 💆 saude | Consultas realizadas, Taxa de retorno, No-show, Receita por profissional |
| 🛠️ servicos | Serviços mais pedidos, Ticket por serviço, Agenda ocupada (%) |
| 🍰 food | Itens mais vendidos, Ticket médio por pedido, Pedidos por canal |
| 🎓 educacao | Matrículas ativas, Inadimplência de mensalidade, Retenção |

Os cards extras usam dados que já existem (orders, order_items, products_services, reservations, appointments, subscriptions) — cálculo agregado no `AnalyticsService` (ADR-068).

### 3. Filtros (consolida item #12 parte relatórios)

- **Período:** 7 / 30 / 90 dias, mês corrente, mês anterior, intervalo custom
- **Por vendedor** (quando houver múltiplos usuários com role de venda)
- **Por produto / categoria**
- **Por canal** (WhatsApp / Instagram / loja / PDV)

Os filtros valem tanto pra visualização quanto pro PDF exportado (o PDF reflete o filtro ativo).

## Consequências

**Positivas:**
- Relatório vira ferramenta de gestão real, não vitrine genérica.
- PDF com marca profissionaliza (lojista leva pro contador, arquiva, mostra pro sócio).
- Cards por vertical fazem o dono sentir "isso foi feito pro meu negócio".
- Filtros permitem análise (qual vendedor rende mais, qual categoria puxa venda, qual canal converte).

**Trade-offs aceitos:**
- Cards por vertical exigem novas queries agregadas no `AnalyticsService` (RevPAR, no-show, giro de estoque não existem hoje) — trabalho por vertical.
- PDF backend é mais custoso que `window.print()`, mas o resultado com marca justifica.
- Filtro por vendedor depende de os pedidos terem `created_by`/`seller_id` preenchido — verificar cobertura no schema antes.
- Alguns cards (giro de estoque, RevPAR) exigem dados que nem toda loja preenche (custo, capacidade) — mostrar "—" com tooltip quando faltar dado, nunca erro.

## Implementação

Item independente (não bloqueia o Bloco A). Sugestão de escopo:

1. `AnalyticsService`: queries agregadas por vertical (giro, RevPAR, no-show, etc.)
2. `ReportsPanel`: cards condicionais por vertical + barra de filtros
3. Rota `GET /api/analytics/sales-report?period=&seller=&category=&channel=`
4. `ReportPdfService`: novo template "relatório de vendas" com marca da loja
5. Botão "Exportar PDF" que respeita o filtro ativo
6. Teste: `test:sales-report-vertical` — cards corretos por vertical + filtro aplica + PDF gera

## Escopo NÃO incluído (fica no item #12)

- **API de meios de pagamento do lojista** (conectar Cielo/Stone/PagSeguro pra receber dos clientes da loja) — assunto separado, não é relatório. Continua aberto no item #12.

## Aprovação

Aprovado por Emerson (jul/26): PDF com marca, cards por vertical, filtros. Itens #4 e #12 (parte relatórios) marcados `[x] decidido`; #12 mantém aberta só a parte de API de pagamento.
