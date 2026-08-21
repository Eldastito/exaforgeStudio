# ADR-183 — Cobrança de recebível (PIX) no Eixo B correto + reconciliação (fecha o "F4b")

**Estado:** **F0 MERGEADA (PR #1280)** · **F1 EM PR** — `chargeForReceivable`. Fatias seguintes
fatia-por-PR.
**Data:** 2026-08-21.
**Contexto:** conclui o "F4b pendente" da ADR-152 (Execution Runtime / Receivable Collection MVP).
Aditivo/reversível. Convenções: isolamento multi-tenant, money-critical fail-closed, webhook
re-consultado (nunca confia no payload), idempotência, `business_signals` quando aplicável.

---

## 1. O bug (money-critical, latente no piloto de cobrança de recebível)

O ZapFlow separa RIGOROSAMENTE dois eixos de cobrança:

- **Eixo A — plataforma cobra o LOJISTA** (o lojista paga o ZapFlow): UMA chave ASAAS de
  **plataforma** via env (`AsaasService`, docstring `AsaasService.ts:5-23`; `_req` injeta
  `access_token = process.env.ASAAS_API_KEY`, `:31-40`).
- **Eixo B — LOJISTA cobra o CLIENTE dele**: token de gateway **POR-ORG** cifrado
  (`organization_settings.pay_gateway_token`), via `PaymentService` (Mercado Pago `_mpPix`
  `:148-214` / Stone `_stoneLink` `:344-394`).

### 1.1. O defeito exato

Os dois handlers de PIX avulso — `AsaasPixChargeCommandHandler` (`RuntimeCommandHandlers.ts:83-130`)
e `CollectionSendReminderHandler` (`CollectionPlaybook.ts:87-167`, cobrança do LOJISTA sobre o
cliente dele, `subjectType:"receivable"`) — chamam um helper `createPixCharge` **duplicado**
(`RuntimeCommandHandlers.ts:243-257` e `CollectionPlaybook.ts:266-285`) que:

1. tenta `AsaasService.createPixCharge(orgId, p)` — método que **NÃO EXISTE**;
2. cai no fallback `AsaasService._req.call(svc, "POST", "/payments", body)`;
3. tem um `throwHandler("permission", "...F4b...")` final que é **código morto**.

Como `_req` é `static` e **sempre definido**, o fallback é **incondicional**. Efeito real:
**100% das cobranças de recebível são emitidas na conta ASAAS da PLATAFORMA** (chave Eixo A) —
uma cobrança que é do LOJISTA→CLIENTE. Consequências: (a) o dinheiro cairia na conta do ZapFlow,
não do lojista; (b) a org sequer é reconhecível no webhook ASAAS (`orgByExternalIds:129-133` não
resolve → `handleWebhook` devolve `ignored`); (c) o body enviado não carrega `externalReference`
nem idempotencyKey (`:250-252`), então não há como conciliar depois.

> Latente: esses handlers só rodam no piloto de cobrança de recebível (ADR-152 F4b), então o bug
> não afeta produção geral hoje — mas precisa ser corrigido antes de ligar o fluxo.

### 1.2. Correção à auditoria anterior

Não basta "trocar a chamada pra chave certa". O Eixo B **não tem** hoje: (a) método público de
recebível no `PaymentService` (o switch de reference em `syncMercadoPagoPayment:308-324` conhece
`res:`/`sub:`/`cmg:`/order, **não** `rcv:`); (b) baixa do recebível na system-of-record. A F4b
precisa **criar** esse caminho, não só religar.

## 2. Reconciliação (o segundo pedido)

- A baixa do Eixo B (loja) vai por webhook único `POST /api/webhooks/payment` (org por segredo)
  → `syncMercadoPagoPayment`/`syncStonePayment` (re-consulta a API, fail-closed) → `markPaid`.
- Mas **nada marca `receivables.status='received'`** — o único ponto é o manual
  `FinancialLedgerService.receiveReceivable:125-130`. E `BusinessOutcomeResolver.ts:44-62` define
  o system-of-record como `receivables.status='received'` → o outcome fica "não resolvido" mesmo
  com o cliente pagando.
- **Sem polling de fallback pro Eixo B:** o Eixo A tem `Scheduler.billingDunningPass` (re-consulta
  ASAAS — "webhook perdido nunca bloqueia lojista que pagou"); o Eixo B só tem
  `confirmationTimeoutPass` que **marca `timed_out`**, não re-consulta. Webhook perdido → baixa presa.

## 3. Guardrails RN-COB (duros — no header dos services + testados)

1. **Eixo B nunca usa a chave de plataforma.** Cobrança lojista→cliente sempre por token
   POR-ORG (`pay_gateway_token`); a chave ASAAS de plataforma é exclusiva do Eixo A.
2. **Sem gateway → degrada honesto.** Org sem `pay_gateway_token`/provider → `manual_required`
   (nunca cai na plataforma, nunca finge cobrança).
3. **Idempotência + correlação.** Toda cobrança de recebível carrega `external_reference=rcv:<id>`
   + `X-Idempotency-Key`; reusa cobrança `pending` da mesma reference (nunca cobra 2×).
4. **Baixa pela system-of-record.** Pagamento confirmado marca `receivables.status='received'`
   (via `receiveReceivable`), não só confirma a `decision_action` — pro `BusinessOutcomeResolver`.
5. **Webhook re-consultado + polling.** Nunca confia no payload (re-consulta a API); job de
   fallback re-consulta PIX de recebível pendentes (espelha o Eixo A) — webhook perdido não
   deixa baixa presa.
6. **Money-critical fail-closed; isolamento por org.**

## 4. Reuso vs. novo

- **Reusar:** `PaymentService` (token por-org, `_mpPix`/`_stoneLink`, idempotência, `payment_charges`);
  `FinancialLedgerService.receiveReceivable` (baixa na system-of-record); os webhooks existentes
  (`syncMercadoPagoPayment`/`syncStonePayment`); `ConfirmationEngine` (a expectativa já é armada);
  o padrão de polling do `billingDunningPass`.
- **Criar (aditivo, mínimo):** `PaymentService.chargeForReceivable` (Eixo B, reference `rcv:`);
  ramo `rcv:` nos webhooks; um pass de reconciliação de recebível.
- **Corrigir:** os dois helpers `createPixCharge` (parar de usar `AsaasService._req`).

## 5. Plano por fatias (fatia = 1 PR draft, com teste/rollback)

- **F0 — auditoria + ADR (ESTA, doc-only).**
- **F1 — `PaymentService.chargeForReceivable(orgId, {receivableId, amount, ...})` (EM PR).**
  Roteia por `pay_provider`/token POR-ORG (reusa `_mpPix`/`_stoneLink`), reference `rcv:<id>` +
  idem `rcv-<id>`, idempotente (reusa pending); devolve `{ ok, paymentId, message, provider,
  reason }`. Sem gateway/config → degrada honesto (`not_enabled`/`gateway_error`/`manual_required`)
  — **NUNCA cai na chave de plataforma** (RN-COB-1/2); `pix_manual` sem `paymentId` (sem
  auto-baixa, honesto). `test:charge-for-receivable` (16, fetch stubado — prova roteamento MP
  por-org, reference/idem `rcv:`, idempotência, degradação, e **zero chamada ao ASAAS**).
- **F2 — Handlers deixam de usar a chave de plataforma.** `RuntimeCommandHandlers.createPixCharge`
  + `CollectionPlaybook.createPixCharge` passam a chamar `PaymentService.chargeForReceivable`
  (mata o `AsaasService._req`); sem gateway → degradação honesta (não cobra na plataforma).
  `test:receivable-pix-routing`.
- **F3 — Reconciliação: ramo `rcv:` nos webhooks.** `syncMercadoPagoPayment`/`syncStonePayment`
  reconhecem `rcv:<id>` → `FinancialLedgerService.receiveReceivable` (system-of-record) +
  `ConfirmationEngine.confirm`. `test:receivable-webhook-reconciliation`.
- **F4 — Polling de fallback (webhook-perdido).** Pass no Scheduler re-consulta PIX de recebível
  pendentes e dá baixa quando o gateway confirma pago (espelha `billingDunningPass`).
  `test:receivable-reconciliation-poll`.
- **F5 — Hardening + runbook.** `test:cobranca-eixo-b-hardening` codifica RN-COB-1..6 + runbook
  `docs/runbook/cobranca-recebivel-operacao.md`.

**Critério de sucesso:** a cobrança de recebível (PIX) sai pela conta do LOJISTA (token por-org),
com idempotência e reference `rcv:`; o pagamento dá baixa em `receivables.status='received'` por
webhook re-consultado E por polling de fallback; nunca cai na conta da plataforma; sem gateway,
degrada honesto.
