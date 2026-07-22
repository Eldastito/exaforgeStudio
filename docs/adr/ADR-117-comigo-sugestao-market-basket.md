# ADR-117 — Comigo: Sugestão de venda zero-token (market-basket) (Fatia 2)

- **Status:** Proposto (escopo aprovado; implementação neste PR)
- **Data:** 2026-07
- **Origem:** Fatia 2 do Comigo (ADR-111) — "sugestão". Implementa o **nível zero-token** do ADR-088 D5.
- **Relacionadas:** ADR-088 D5 (sugestão frugal — ranking/co-ocorrência, LLM só na ponta), PR #3 (Balcão + `comigo_order_items`).

## Contexto

O ADR-088 D5 separa a sugestão em dois níveis: **zero-token** (a maioria) — *"mais pedidos", "sugestão da casa", "quem pediu isso também levou…"* — que é **ranking/co-ocorrência** pré-computado, não IA; e **com token** (só quando o cliente escreve um desejo) — LLM + RAG do cardápio. Este PR entrega o nível zero-token, que também é motor de **upsell grátis** no Balcão.

## Decisões

### D1 — Co-ocorrência (market-basket), consulta e não IA
"Quem levou X também levou Y" = contar, entre os pedidos que tiveram X, quais outros itens mais aparecem. É `GROUP BY` sobre `comigo_order_items`, **zero-token**. Ranqueia por nº de pedidos em que co-ocorre.

### D2 — "Mais pedidos" / "sugestão da casa"
Ranking dos itens mais vendidos (Σ qty em vendas paid/done), usado quando ainda não há item no pedido (abertura) — a "sugestão da casa".

### D3 — Onde aparece
No **Balcão**: com o pedido vazio, mostra "Mais pedidos" (toque pra adicionar); com item no pedido, mostra "Quem levou {último item} também levou" — upsell no fluxo, sem atrito. Também serve de base pro Mesa/QR depois.

### D4 — Guarda-corpo
Sugere só o que a própria loja vende e o histórico sustenta (nunca inventa item). Frugal: nenhuma chamada de IA. O nível com-LLM (desejo escrito) fica pro Mesa/QR (RAG do cardápio).

## Serviço (`ComigoSuggestionService`)
- `alsoBought(orgId, productId, limit)` → itens que mais co-ocorrem com `productId`.
- `topSellers(orgId, limit)` → mais vendidos (paid/done).
- Endpoint `GET /api/comigo/suggest?productId=` → `{ alsoBought, top }`.

## Consequências
**Positivas:** upsell grátis (zero-token), reusa o histórico do Balcão, base pronta pro Mesa/QR; sem custo de IA.

**Trade-offs:** co-ocorrência precisa de histórico (frio no começo) — mitigado pelo fallback "mais pedidos"; só sugere itens com `product_id` (itens avulsos sem catálogo não entram) — aceitável.

## Guardas
- Zero-token (consulta, não IA); só itens da própria loja; isolamento por `organization_id`.

## Testes
`test:comigo-suggest` — co-ocorrência ranqueia certo (quem tem X vê Y mais que Z); mais vendidos por qty; exclui o próprio item; isolamento entre orgs.
