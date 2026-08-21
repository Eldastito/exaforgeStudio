# ADR-183 — Cobrança de recebível (PIX) no Eixo B correto + reconciliação (fecha o "F4b")

**Estado:** **FECHADO.** F0 (#1280) · F1 (#1281) · F2+F3 (#1282) · F4 (#1283) MERGEADAS ·
**F5 EM PR** — hardening (`test:cobranca-eixo-b-hardening`, RN-COB-1..6) + runbook. ADR completo.
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
- **F2 (funde F2+F3) — Handlers roteiam Eixo B + reconciliação por webhook (EM PR).** Os dois
  helpers `createPixCharge` (`RuntimeCommandHandlers` + `CollectionPlaybook`) passam a chamar
  `PaymentService.chargeForReceivable` — **mata o `AsaasService._req`** (a chave de plataforma);
  sem gateway → degradação honesta (`permission`/`external_unavailable`, nunca cobra na
  plataforma). Confirmação armada com método novo `gateway_payment_webhook`. Reconciliação:
  `syncMercadoPagoPayment`/`syncStonePayment` ganham ramo `rcv:<id>` → `PaymentService.
  onReceivablePaid` = `FinancialLedgerService.receiveReceivable` (system-of-record, RN-COB-4) +
  `ConfirmationEngine.confirm` pela externalRef (idempotente). **F2 e F3 vieram juntos** porque
  o e2e acopla charge+confirmação (rotear sem reconciliar deixaria a cobrança sem baixa).
  `test:receivable-pix-routing` (9) + `test:runtime-execute-e2e` reescrito pro fluxo Eixo B
  (29, prova: cobra no MP do lojista/nunca ASAAS, webhook baixa o recebível + fecha a ação).
- **F4 — Polling de fallback (webhook-perdido) (EM PR).** `Scheduler.receivableReconciliationPass`
  re-consulta as cobranças de recebível `pending` (Mercado Pago, o caminho totalmente
  instrumentado — `payment_charges.id` É o id do pagamento MP) pelo gateway POR-ORG (RN-COB-1) e,
  quando aprovado, dá baixa via o MESMO caminho do webhook (`syncMercadoPagoPayment` →
  `onReceivablePaid`, RN-COB-4/5). Espelha o `billingDunningPass` do Eixo A. Guarda anti-trabalho
  (recebível já `received` → só alinha a cobrança, não re-consulta); janela de 14 dias limita a
  varredura (PIX expirado sai sozinho); best-effort/idempotente; isolado por org. Stone segue
  webhook-only (o id guardado é o do payment-link, não o do pedido re-consultável — sem polling
  fingido). `test:receivable-reconciliation-poll` (18, fetch stubado — prova baixa por polling,
  pending fica pending, já-recebido não re-consulta, provider/janela/token filtram, isolamento).
- **F5 — Hardening + runbook (EM PR).** `test:cobranca-eixo-b-hardening` (23) — doc-of-record
  executável de dupla função: (A) codifica RN-COB-1..6 como REGRESSÃO sobre os serviços/handlers
  REAIS F1–F4 (Eixo B nunca a plataforma · degrada honesto · idem/reference `rcv:` · baixa pela
  system-of-record · webhook re-consultado + polling · fail-closed + isolamento); (B) verifica a
  FIAÇÃO de produção (helpers roteiam via `PaymentService.chargeForReceivable` e não `_req.call` ·
  `gateway_payment_webhook` em `CONFIRMATION_METHODS` · `receivableReconciliationPass` no Scheduler ·
  4 testes wired · ADR/runbook presentes). Runbook `docs/runbook/cobranca-recebivel-operacao.md`
  (mapa dos serviços, fluxo detectar→cobrar→confirmar→baixar, guardrails RN-COB, escopo/limites,
  troubleshooting, como adicionar gateway ao polling). **Fecha a ADR-183.**

**Critério de sucesso:** a cobrança de recebível (PIX) sai pela conta do LOJISTA (token por-org),
com idempotência e reference `rcv:`; o pagamento dá baixa em `receivables.status='received'` por
webhook re-consultado E por polling de fallback; nunca cai na conta da plataforma; sem gateway,
degrada honesto.
