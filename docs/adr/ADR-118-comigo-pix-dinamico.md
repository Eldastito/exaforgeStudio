# ADR-118 — Comigo: Pix dinâmico com webhook (Fatia 2)

- **Status:** Proposto (escopo aprovado; implementação neste PR)
- **Data:** 2026-07
- **Origem:** Fatia 2 do Comigo (ADR-111). Implementa o ADR-088 D3 **nível 2**.
- **Relacionadas:** ADR-088 D3 (Pix em degraus; rejeita leitura de notificação de banco), PaymentService (Pix dinâmico via Mercado Pago já existe p/ `orders`), PR #3 (`comigo_orders`), ADR-091 Bloco B (padrão de webhook por segredo de org).

## Contexto

O Pix estático "recebi" (PR #3) funciona no dia 1, mas exige o operador confirmar na mão. O **nível 2** (ADR-088 D3): QR com **`txid` único** → o PSP confirma **automaticamente** por webhook → o pedido libera sozinho. Concilia por `txid`. É o que destrava o **Mesa/QR pay-first sem atendente** (próximo PR).

O ADR-088 D3 é explícito: **não construir sobre leitura de notificação do banco** (frágil, falso positivo, risco). Pix confiável = **PSP com webhook**.

## Decisões

### D1 — Provider plugável, testável com mock
O PSP (Mercado Pago/Efí/Asaas/Cora) entra como **provider** (`COMIGO_PIX_PROVIDER`, default `mock`). O `mock` gera `txid` + payload copia-e-cola determinístico para desenvolvimento/teste (padrão dos gateways do repo — ASAAS/Stone testados com mock). Ligar um PSP real em produção é config (chave/credencial), não reescrita.

### D2 — Cobrança por `txid`, conciliação idempotente
`createCharge` gera um `txid` único, grava `comigo_pix_charges` (pending) e devolve o copia-e-cola. O webhook do PSP casa pelo `txid`, marca a cobrança paga e **transiciona o pedido** para pago (`paid_via='pix_dyn'`). **Idempotente**: reentrega do webhook ou cobrança já paga não paga em dobro; só fecha pedido ainda `open`.

### D3 — Webhook autenticado pelo segredo da organização
Público (`/api/webhooks/comigo-pix`), autenticado pelo **segredo por org** (mesmo padrão do `/api/webhooks/payment` — `orgByWebhookSecret`). Sempre responde 200 (menos unauthorized) pra não travar a fila de reentrega do PSP. Não confia cegamente no payload — o `mock`/real confirma por `txid` dentro da org.

### D4 — Pix dinâmico é caixa (recebido)
`pix_dyn` é dinheiro recebido → entra no **caixa** do dia (ADR-112 D3), junto com dinheiro e Pix "recebi". O `daySummary` passa a contar `paid_via IN ('cash','pix_manual','pix_dyn')`.

## Modelo de dados
- `comigo_pix_charges` — `id, organization_id, order_id, txid, amount, status ('pending'|'paid'|'expired'|'canceled'), provider, qr_payload, e2e_id, created_at, paid_at`, `UNIQUE(organization_id, txid)`.

## Serviço (`ComigoPixService`)
- `createCharge(orgId, orderId)` → gera txid + payload, grava pending (reusa cobrança pendente do mesmo pedido — idempotente).
- `confirmByTxid(orgId, txid, e2eId?)` → marca cobrança paga + pedido pago (`pix_dyn`), só se ainda `open`; idempotente.
- `handleWebhook(secret, body)` → autentica org, concilia por txid.
- `statusOf(orgId, orderId)` → última cobrança (para polling do Balcão).
- Rotas: `POST /api/comigo/orders/:id/pix-dynamic`, `GET /api/comigo/orders/:id/pix-status`, webhook público.

## Consequências
**Positivas:** confirmação automática (fim do "recebi" manual); base do Mesa/QR pay-first; reusa o padrão de webhook/segredo do repo; concilia por txid (auditável).
**Trade-offs:** produção exige contratar/configurar um PSP (não-código, como o ASAAS); o `mock` não confirma sozinho no browser (é para dev/teste) — a confirmação real vem do PSP.

## Guardas
- **Não** ler notificação de banco (ADR-088 D3) — só PSP com webhook.
- Idempotência + dedup por txid; webhook sempre 200 (menos unauthorized).
- Isolamento por `organization_id`; segredo de webhook por org.

## Testes
`test:comigo-pix` — createCharge gera txid/payload e é idempotente por pedido; confirmByTxid fecha o pedido como `pix_dyn` e é idempotente (reentrega não paga 2×); webhook por segredo de org concilia; pix_dyn entra no caixa (daySummary); isolamento entre orgs.
