# ADR-124 — Comigo/Mesa: vitrine com imagem + fiado para cliente autorizado

- **Status:** Proposto (escopo aprovado; implementação neste PR)
- **Data:** 2026-07
- **Origem:** feedback de campo na tela "Faça seu pedido" (Mesa/QR, ADR-119): faltam imagens, o layout deveria parecer a loja virtual, e o pagamento deveria ter **fiado** — mas só para quem o dono cadastrou e liberou, com limite que não comprometa a operação.
- **Relacionadas:** ADR-119 (Mesa/QR pay-first), ADR-112/113 (fiado, limite, lista negra — `comigo_customer_credit`), storefrontPublic (vitrine com imagens), ADR-118 (Pix dinâmico).

## Contexto

A página pública do Mesa/QR hoje é uma lista sem imagem. O dono quer a cara da **loja virtual** (card com foto, nome, preço) e o **mesmo fluxo de pagamento**, com um adicional: **fiado**. Mas fiado no autoatendimento só pode existir sob controle — senão vira calote. A regra do dono: **fiado só para clientes que ele cadastrou e liberou**, cada um com um **limite** que não comprometa o caixa.

## Decisões

### D1 — Vitrine com imagem (esqueleto da loja)
O cardápio da Mesa passa a trazer a **imagem** do produto (primeira de `product_images`, como a vitrine) e o layout vira card com foto + nome + preço + adicionar, visualmente igual à loja virtual.

### D2 — Fiado só para cliente CADASTRADO e LIBERADO (autorização do dono)
Novo flag `comigo_customer_credit.store_fiado_enabled` (o dono liga por cliente, na Caderneta). Um cliente pode comprar fiado na loja **somente se**: existe em `contacts`, tem `store_fiado_enabled=1`, **não** está na lista negra e tem `credit_limit > 0`. A opção **só aparece** para quem satisfaz isso — ninguém mais vê "fiado".

### D3 — Limite que não compromete a operação (validado no servidor)
No checkout, o cliente se identifica pelo **telefone**. O servidor verifica a autorização e o **limite disponível** (`limite − saldo devedor`). O fiado só fecha se `saldo + total do carrinho ≤ limite`. Tudo revalidado no servidor (nunca confia no cliente). Estoura o limite → fiado indisponível para aquele pedido (paga por Pix).

### D4 — Pagamento: Pix dinâmico (já existe) + fiado autorizado
Mantém o **Pix dinâmico** (ADR-118) como pagamento pay-first. O **fiado autorizado** é a exceção controlada: registra a dívida no razão (como o Balcão, ADR-112) e o pedido entra direto na fila de preparo (a "quitação" é a autorização do dono dentro do limite). Card do adquirente (Stone/MP) fica como evolução, se o dono quiser.

## Modelo de dados
`comigo_customer_credit`: `store_fiado_enabled INTEGER DEFAULT 0`.

## Serviço / rotas
- `ComigoMesaService.menu` passa a incluir `image`.
- `ComigoMesaService.fiadoEligibility(orgId, phone, cartTotal)` → `{ authorized, name, limit, balance, available, fits }` (só clientes liberados; match por dígitos do telefone).
- `ComigoMesaService.placeOrder(..., payment)` → `payment='pix'` (fluxo atual) ou `payment='fiado'` (revalida autorização+limite, grava dívida, pedido entra na fila).
- `prepQueue`/`orderStatus` passam a incluir pedidos de mesa fiado (`status='done'`).
- Públicas: `POST /:token/fiado-check`; `POST /:token/order` aceita `payment` + `customer`.
- Autenticada: `POST /api/comigo/fiado/:contactId/store-fiado` (o dono libera/bloqueia o fiado na loja).
- UI Caderneta: toggle "pode comprar fiado na loja". UI Mesa: cards com foto + checkout com telefone → botão fiado só quando liberado e dentro do limite.

## Consequências
**Positivas:** a Mesa fica com a cara da loja; o dono controla exatamente quem fia e quanto; o cliente fiel compra sozinho sem calote (limite + autorização); reusa `comigo_customer_credit` e o Pix dinâmico.
**Trade-offs:** fiado no autoatendimento é exceção ao pay-first — mitigada por autorização explícita + limite + revalidação no servidor; identificação por telefone depende de o cadastro do cliente ter o mesmo número (match por dígitos tolera formatação).

## Guardas
- Fiado **só** para cadastrado+liberado+dentro do limite; **nunca** aparece para o resto.
- Preço e limite **sempre do servidor**; lista negra bloqueia; isolamento por `organization_id`.
- Autorização é do dono (ADR-091 §6: decisão do dono, não automática).

## Testes
`test:comigo-mesa` (estendido) — menu traz imagem; fiadoEligibility nega quem não é liberado/está na lista negra/estourou o limite e libera quem está autorizado e dentro do limite; placeOrder fiado grava dívida e entra na fila; Pix segue funcionando; isolamento.
