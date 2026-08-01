# ADR-149 — Comigo: Pix dinâmico com PSP real (Mercado Pago)

- **Status:** Merged — 2026-08-01
- **Origem:** Gap G do levantamento "Autônomos — o que ainda falta". Fecha ADR-088 D3 nível 2 "real" (o `mock` da ADR-118 era pra dev/teste; produção precisava do PSP).
- **Relacionadas:** ADR-088 D3 (Pix em degraus), ADR-118 (mock + estrutura idempotente), `PaymentService._mpPix` (integração MP já testada pra orders/reservations/subscriptions).

## Contexto

A ADR-118 entregou o motor Comigo Pix inteiro — `comigo_pix_charges`, `createCharge`, `confirmByTxid`, webhook `/api/webhooks/comigo-pix`, idempotência por pedido — mas só com provider `mock` (payload determinístico). Em produção, ninguém paga um QR falso. Faltava plugar o **PSP real** que gera o Pix e confirma sozinho.

O `PaymentService._mpPix` já tem a integração completa do Mercado Pago (fetch, idempotency-key, notification_url, extração de `qr_code`/`qr_code_base64`, `syncMercadoPagoPayment` no webhook `/api/webhooks/payment` roteando por prefixo `res:`/`sub:` na `external_reference`). Fatia G = **ligar Comigo nesse mesmo pipeline** — sem duplicar integração, sem exigir novo webhook do lojista.

## Decisões

### D1 — Provider `mercadopago` dentro do `ComigoPixService`

`createCharge(orgId, orderId)` passa a ser **async** e checa `COMIGO_PIX_PROVIDER`:

- `mock` (default) → payload determinístico, comportamento intacto (retrocompat 100%).
- `mercadopago` → chama `POST https://api.mercadopago.com/v1/payments` com `Authorization: Bearer <pay_gateway_token>` (reusa o token que a org já configura pra MP em outros fluxos), `X-Idempotency-Key: cmg-<orderId>`, e body incluindo `external_reference: "cmg:<orderId>"` (assinatura pro webhook rotear) + `notification_url` apontando pro webhook geral da org.

Se o MP falhar (sem token / HTTP 4xx-5xx / rede caiu / resposta sem qr_code), devolve `{ok:false, error:'provider_failed'}` — **NÃO cai pro mock silenciosamente**. Enganar o operador com QR falso quando o real quebrou é pior que mostrar "reintentar".

### D2 — Um webhook só pra tudo do MP (`/api/webhooks/payment`)

O webhook `/api/webhooks/payment` já existe e já roda `PaymentService.syncMercadoPagoPayment`, que consulta MP `/v1/payments/{id}` e roteia por prefixo em `external_reference`:

- `res:<id>` → reserva
- `sub:<id>` → assinatura
- (senão) → `PaymentService.markPaid` em `orders`

Adicionamos **novo prefixo `cmg:<orderId>` → `ComigoPixService.confirmByReference(orgId, orderId, mpPaymentId)`** via import dinâmico (evita ciclo). O lojista configura **1 webhook só** no painel do MP, cobrindo assinatura, reserva, e-com e Balcão do Comigo.

O webhook antigo `/api/webhooks/comigo-pix` continua servindo — é para providers custom que devolvem `txid` explícito. Sem breaking change.

### D3 — Aditivos em `comigo_pix_charges` (não breaking)

- `qr_code_base64 TEXT` — imagem PNG do QR já pronta pra exibir na UI (`<img src="data:image/png;base64,...">`), sem precisar de lib de QR no front. Mock não usa (NULL).
- `external_id TEXT` — payment ID do MP; usado pra auditoria e conciliação (o `txid` do Comigo passa a ser o próprio payment ID quando `provider=mercadopago`, pra ficar curto ≤ 35 e único).

### D4 — Injeção de `fetchFn` pra teste

`_internals.setFetchFn(fn)` — mesmo padrão de `ComigoMenuSuggestService/ComigoAudioCatalogService`. CI roda offline, sem bater na API real do MP. Testes cobrem: URL, headers, body correto, idempotency-key, external_reference, 4xx→provider_failed, sem qr_code→provider_failed, network→provider_failed, reuso da cobrança pendente.

### D5 — UI: QR imagem quando disponível

`ComigoView.Balcao` renderiza `<img src="data:image/png;base64,{qrCodeBase64}">` acima do copia-e-cola quando a resposta trouxer. Mock segue mostrando só o payload (backward-compat).

## Serviço, rotas, DB

**Service:** `src/server/ComigoPixService.ts`
- `static async createCharge(orgId, orderId)` — agora async, retorna com `qrCodeBase64?` e `ticketUrl?` quando MP.
- `static confirmByReference(orgId, orderId, externalPaymentId?)` — usado pelo webhook geral.
- `static confirmByTxid(...)` — mantido pra webhook próprio.
- `_internals.setFetchFn(fn)` — injeção pra teste.

**PaymentService:** `syncMercadoPagoPayment` ganhou branch `ref.startsWith("cmg:")` → import dinâmico chama `ComigoPixService.confirmByReference`.

**Rota:** `POST /api/comigo/orders/:id/pix-dynamic` agora async; adiciona status HTTP 502 pra `provider_failed`.

**Rota (público):** `POST /api/public/comigo/:token/order` agora async (chain de await).

**DB (aditivo):** `comigo_pix_charges.qr_code_base64 TEXT`, `comigo_pix_charges.external_id TEXT`.

**UI:** `src/features/ComigoView.tsx` — `pix.qrCodeBase64` renderiza `<img>` quando presente.

## Testes

`test:comigo-pix-mp` — 28 checks offline com fetch mockado:
- Sem token → provider_failed.
- MP OK → todos os campos preservados (payment id, qr_code, qr_code_base64, ticket_url, provider).
- URL/headers/body verificados (Bearer, Idempotency-Key, external_reference=cmg:).
- Idempotente por pedido (2ª chamada não chama fetch).
- MP 400 / sem qr_code / fetch lança → provider_failed (sem cair pro mock).
- `confirmByReference` fecha pedido pix_dyn; idempotente.
- Isolamento cross-org.

`test:comigo-pix` (existente) continua passando — provider default `mock` intacto (15/15).

## Guardas RN

1. **Isolamento multi-tenant** — token da org lido por `organization_id`; `external_reference` casa por `orgId + orderId` no webhook.
2. **Nunca lê notificação de banco** (ADR-088 D3) — só PSP com webhook.
3. **Idempotente** — Idempotency-Key no MP + unique pendente em `comigo_pix_charges` + `confirmByReference` só fecha pedido `open`.
4. **Sem fallback silencioso** — provider real falha explícito com `provider_failed`; UI mostra retry.
5. **Governança IA (ADR-130)** — cobrança não é `PEOPLE_AFFECTING`; auditoria por `audit_logs` com `comigo_pix_create` + provider.

## Consequências

**Positivas:** cobrança confirma sozinha em produção. Reusa `pay_gateway_token` já cadastrado na org (nenhuma tela nova de config). Reusa `/api/webhooks/payment` (nenhum webhook novo pro lojista configurar). UI ganha QR image pronta do PSP. Motor de Mesa/QR pay-first (ADR-119) funciona de fato. Retrocompat 100% — quem estava rodando com mock segue.

**Trade-offs:** Produção exige a org ter `pay_gateway_token` MP configurado (é setup humano, não código — mesma exigência de assinatura/reserva). Sem UI de config MP nesta fatia; a `PaymentSettings` (que já existe pra outros fluxos) já cobre. Testes usam fetch mock — smoke real depende de credencial MP sandbox.

**Futuro (não nesta fatia):** provider `efi` (Efí, exige mTLS com certificado); provider `asaas` (mais simples que Efí, tem sandbox); UI de status por Socket.IO em vez de polling; conciliação diária MP↔`comigo_pix_charges` pra detectar cobrança órfã.
