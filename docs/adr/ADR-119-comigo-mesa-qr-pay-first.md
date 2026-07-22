# ADR-119 — Comigo: Mesa/QR autoatendimento pay-first (Fatia 2)

- **Status:** Proposto (escopo aprovado; implementação neste PR — fecha a Fatia 2)
- **Data:** 2026-07
- **Origem:** Fatia 2 do Comigo (ADR-111). Implementa o ADR-088 D4 (Mesa/QR) + D5 nível LLM (futuro).
- **Relacionadas:** ADR-088 D4 (pay-first), ADR-118 (Pix dinâmico — o rail que torna o "sem atendente" possível), PR #3 (Balcão), storefrontPublic (padrão de rota pública), main.tsx (roteamento de páginas públicas por path).

## Contexto

A 3ª superfície do Comigo (ADR-088): o **cliente final** lê o QR na mesa → vê o cardápio → pede → **paga** → só então o pedido cai na fila do Balcão. **Sem atendente, sem login.** O **pay-first** (D4) elimina calote/fiado esquecido e funde "pedir + pagar" numa etapa. Só ficou viável agora que o **Pix dinâmico** (ADR-118) confirma o pagamento sozinho.

## Decisões

### D1 — Superfície pública por token, sem login
Cada org tem um `comigo_mesa_token` (aleatório) no QR. Rotas públicas `/api/public/comigo/:token/*` (sem JWT, padrão storefrontPublic) resolvem a org pelo token. A página do cliente é servida pelo SPA em `/mesa/:token` (roteamento por path, como `/loja/:slug`).

### D2 — Pay-first: o pedido só entra na fila quando PAGO
O cliente monta o pedido → o servidor **cria o pedido `source='mesa'`** e **gera a cobrança Pix dinâmica** (ADR-118) → o cliente paga → o webhook do PSP confirma → **só então** o pedido aparece na fila de **preparo** do Balcão. Enquanto não pago, não vira trabalho pra ninguém (elimina calote).

### D3 — Preço é do SERVIDOR, nunca do cliente
O pedido público manda só `{productId, qty}`; o **preço vem do catálogo no servidor** (nunca confia no valor do cliente). Valida item ativo e pertencente à org. Guarda contra manipulação de preço.

### D4 — Fila de preparo no Balcão
Pedido de mesa pago e ainda não entregue = `source='mesa' AND status='paid' AND fulfilled_at IS NULL`. O Balcão mostra esses pedidos (já itemizados pelo cliente — zero digitação do operador) e marca **"pronto/entregue"** (`fulfilled_at`). Conta no caixa (pix_dyn) e nas vendas normalmente.

### D5 — Consumo local × viagem
O cliente marca no pedido (afeta embalagem/preço/fiscal — ADR-088 D4). Sessão por apelido, sem login.

## Modelo de dados
- `comigo_orders`: `source TEXT DEFAULT 'balcao'` (balcao|mesa), `fulfilled_at DATETIME`.
- `organization_settings`: `comigo_mesa_token TEXT` (token do QR; regenerável).

## Serviço (`ComigoMesaService`)
- `ensureToken(orgId)` / `orgByToken(token)` / `regenerate(orgId)`.
- `menu(orgId)` → produtos ativos (id, nome, preço do servidor).
- `placeOrder(orgId, { items, sessionAlias, consumo })` → cria pedido mesa (preço do servidor) + cobrança Pix dinâmica; devolve `{ orderId, txid, qrPayload, total }`.
- `orderStatus(orgId, orderId)` → `{ status, paid, fulfilled }` (polling do cliente).
- `prepQueue(orgId)` → pedidos pagos a preparar (com itens).
- `markFulfilled(orgId, orderId)`.

## Rotas
- Públicas: `GET /api/public/comigo/:token/menu`, `POST /api/public/comigo/:token/order`, `GET /api/public/comigo/:token/order/:orderId/status`.
- Autenticadas: `GET /api/comigo/mesa/link`, `POST /api/comigo/mesa/regenerate`, `GET /api/comigo/mesa/queue`, `POST /api/comigo/orders/:id/fulfill`.
- Página do cliente: `/mesa/:token` no SPA (`ComigoMesaPage`).

## Consequências
**Positivas:** fecha as 3 superfícies do ADR-088 (Balcão/Mesa/Comigo); pay-first sem atendente (agora fiel, via Pix dinâmico); o cliente itemiza (menos trabalho pro operador); reusa catálogo + Pix dinâmico + padrão de rota pública.
**Trade-offs:** depende do Pix dinâmico em produção (PSP configurado — ADR-118); pedidos mesa não pagos ficam pendentes (limpeza/expiração é refino futuro).

## Guardas
- **Preço sempre do servidor** (nunca do cliente); valida item ativo/da org.
- Pay-first: nada entra na fila sem pagamento confirmado.
- Token de mesa aleatório e regenerável; isolamento por `organization_id`.
- Rota pública sem JWT, mas escopada pelo token; sempre valida a org.

## Testes
`test:comigo-mesa` — token resolve a org; `placeOrder` usa preço do servidor (ignora o do cliente) e cria pedido mesa + cobrança; pedido NÃO aparece na fila de preparo até pagar; após confirmar o Pix, aparece; `markFulfilled` tira da fila; isolamento entre orgs.
