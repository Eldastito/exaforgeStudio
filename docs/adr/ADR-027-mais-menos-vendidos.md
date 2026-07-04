# ADR-027 — Catálogo: mais e menos vendidos

**Status:** Implementado e testado (consulta determinística sobre dados já existentes; sem IA, sem rede).
**Origem:** item 30 do levantamento de pendências, registrado desde a ADR-019: "o dado bruto existe (`order_items`), mas nenhum relatório usa isso ainda; fica para quando o cadastro por foto já estiver gerando volume real de produtos". Com as Fases 0–2 do Smart Inventory em produção alimentando o catálogo, o backlog aprovado destravou o item.

## O que é

`GET /api/products/sales-analytics?days=30|90|365` — ranking de produtos por unidades vendidas/receita no período, com três decisões deliberadas:

1. **Mesmo filtro de status do `best_sellers` da vitrine** (`pago`/`em_preparo`/`entregue`/`concluido`): só pedido que virou receita conta — carrinho abandonado (`aguardando_pagamento`) e cancelamento ficam de fora, para o ranking nunca inflar com venda que não aconteceu. Reaproveita o critério já validado em `storefrontPublic.ts` em vez de inventar um segundo.
2. **Produto ativo com ZERO venda aparece na lista dos menos vendidos** — o "menos vendido" mais importante é o que nunca vendeu e continua ocupando vitrine/estoque; um ranking só de quem vendeu esconderia exatamente esse insight.
3. **Produto inativo não aparece** — já foi tirado de circulação, não é acionável.

Na tela: botão "Vendas" no Catálogo abre um modal com período (30/90 dias, 1 ano), totais do período (unidades, receita, quantos produtos ativos venderam) e as duas listas — top 10 e os 10 piores (zero-venda destacado em âmbar como "parados na vitrine").

## O que NÃO virou escopo

Sem gráfico/tendência temporal, sem exportação, sem margem por produto (exigiria cruzar com `avg_cost` — possível extensão natural agora que o custo real existe via Fases 1/2, mas não pedida). A leitura é um modal de decisão rápida ("o que promover, o que tirar da vitrine"), não um BI.

## Validação

`npm run test:sales-analytics` (10 verificações novas) + suíte completa (20 scripts, 376 verificações, zero quebras):
- Pedidos pagos/concluídos somam; cancelado e aguardando pagamento não contam.
- Janela de período respeitada (venda de 90 dias atrás fora da janela de 30, dentro da de 365).
- Zero-venda aparece; inativo não aparece; isolamento por organização nas duas direções.
- Receita calculada corretamente a partir de `line_total`.
- `npm run lint` e `npm run build` limpos.
