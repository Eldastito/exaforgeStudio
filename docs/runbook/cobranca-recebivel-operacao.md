# Runbook — Cobrança de recebível (PIX) no Eixo B (ADR-183)

Operação da cobrança **lojista → cliente** de um `receivable` por PIX, com reconciliação por
webhook **e** por polling de fallback. Fecha o "F4b pendente" da ADR-152. Aditivo/reversível.

> **Os dois eixos (não confundir):**
> - **Eixo A — plataforma cobra o LOJISTA** (o lojista paga o ZapFlow): UMA chave ASAAS de
>   plataforma via env (`AsaasService`). NÃO é este runbook.
> - **Eixo B — LOJISTA cobra o CLIENTE dele**: token de gateway **POR-ORG** cifrado
>   (`organization_settings.pay_gateway_token`), via `PaymentService`. **É este runbook.**

---

## 1. Mapa dos serviços / pontos de código

| Peça | Onde | Papel |
| --- | --- | --- |
| `PaymentService.chargeForReceivable` | `src/server/PaymentService.ts` | **F1** — cria a cobrança de recebível pelo gateway POR-ORG (`_mpPix`/`_stoneLink`), reference `rcv:<id>` + idem `rcv-<id>`. Degrada honesto sem gateway. |
| `createPixCharge` (helpers) | `RuntimeCommandHandlers.ts` · `CollectionPlaybook.ts` | **F2** — os dois handlers de PIX de recebível roteiam por `chargeForReceivable`. **Nunca** usam `AsaasService._req` (chave de plataforma). |
| `PaymentService.onReceivablePaid` | `src/server/PaymentService.ts` | **F3** — pagamento confirmado → baixa na system-of-record (`receivables.status='received'` via `FinancialLedgerService.receiveReceivable`) + confirma a expectativa do runtime (`gateway_payment_webhook`). |
| ramo `rcv:` nos webhooks | `syncMercadoPagoPayment` / `syncStonePayment` | **F3** — o webhook re-consultado casa `rcv:<id>` → `onReceivablePaid`. |
| `Scheduler.receivableReconciliationPass` | `src/server/Scheduler.ts` | **F4** — polling de fallback: re-consulta as cobranças `pending` e dá baixa quando o gateway confirma pago (webhook perdido não prende a baixa). |

## 2. Fluxo (detectar → cobrar → confirmar → baixar)

1. **Cobrar** — uma `decision_action` (`asaas_pix_charge` no Runtime, ou `collection_send_reminder`
   com `subjectType:"receivable"` no CollectionPlaybook) executa → `createPixCharge` →
   `PaymentService.chargeForReceivable(orgId, { receivableId, amount, ... })`. Sai PIX pelo
   **gateway do lojista** (token por-org), reference `rcv:<id>`. A confirmação é armada com método
   `gateway_payment_webhook` + `externalRef = paymentId`.
2. **Cliente paga** → o gateway chama `POST /api/webhooks/payment` (org resolvida pelo segredo) →
   `syncMercadoPagoPayment`/`syncStonePayment` **RE-CONSULTA** a API (nunca confia no payload) →
   ramo `rcv:` → `onReceivablePaid`.
3. **Baixa** — `onReceivablePaid` marca `receivables.status='received'` (o que o
   `BusinessOutcomeResolver` lê) **e** confirma a expectativa do runtime pela `externalRef`.
4. **Fallback (webhook perdido)** — de hora em hora, `receivableReconciliationPass` re-consulta as
   cobranças `rcv:` ainda `pending` (Mercado Pago) e, se o gateway diz pago, dá baixa pelo **mesmo
   caminho** do passo 3. Guarda anti-trabalho: recebível já `received` → só alinha a cobrança.

## 3. Guardrails RN-COB (duros — testados em `test:cobranca-eixo-b-hardening`)

1. **Eixo B nunca usa a chave de plataforma.** Cobrança lojista→cliente sempre por token
   POR-ORG (`pay_gateway_token`); a chave ASAAS de plataforma é exclusiva do Eixo A.
2. **Sem gateway → degrada honesto.** `not_enabled` / `manual_required` / `gateway_error` —
   nunca cai na plataforma, nunca finge cobrança.
3. **Idempotência + correlação.** `external_reference = rcv:<id>` + `X-Idempotency-Key = rcv-<id>`;
   reusa a cobrança `pending` da mesma reference (nunca cobra 2×).
4. **Baixa pela system-of-record.** Pagamento confirmado marca `receivables.status='received'`
   (via `receiveReceivable`), não só confirma a `decision_action`.
5. **Webhook re-consultado + polling.** Nunca confia no payload (re-consulta a API); o polling de
   fallback re-consulta os PIX de recebível pendentes — webhook perdido não deixa baixa presa.
6. **Money-critical fail-closed; isolamento por org.** Falha do gateway → não confirma, não baixa.

## 4. Escopo / limites conscientes

- **Polling é Mercado Pago.** É o caminho totalmente instrumentado (`payment_charges.id` **é** o id
  do pagamento MP, re-consultável direto). **Stone segue webhook-only**: o id guardado é o do
  payment-link, não o do pedido re-consultável — não há polling fingido (honesto).
- **Janela de 14 dias** no polling: PIX expirado sai sozinho (o MP devolve `cancelled`/`expired` e
  a cobrança deixa de ser `pending`).
- **`pix_manual`** (chave estática) não tem auto-baixa: volta mensagem sem `paymentId` (honesto —
  não há como conciliar por webhook).

## 5. Troubleshooting

| Sintoma | Provável causa | Ação |
| --- | --- | --- |
| Cobrança volta `manual_required`/`not_enabled` | org sem gateway configurado / `pay_enabled=0` | Configurar Mercado Pago/Stone em Configurações → Pagamentos (token por-org). **Nunca** é pra cair na plataforma. |
| Cliente pagou mas `receivable` segue `open` | webhook perdido | Aguardar o pass horário (`receivableReconciliationPass`) OU disparar o Scheduler; ele re-consulta e dá baixa. Só Mercado Pago. |
| Cobrança Stone paga mas presa | Stone é webhook-only (sem polling) | Verificar entrega do webhook do Pagar.me; re-enviar o evento. |
| `receivable` baixado 2× | — | Não ocorre: `receiveReceivable`/`confirm` são idempotentes; o pass tem guarda anti-trabalho por status. |

## 6. Testes

- `test:charge-for-receivable` (F1) — roteamento por-org, reference/idem `rcv:`, degradação, zero ASAAS.
- `test:receivable-pix-routing` (F2/F3) — webhook `rcv:` baixa a system-of-record + confirma a ação.
- `test:receivable-reconciliation-poll` (F4) — polling do webhook perdido, filtros, isolamento.
- `test:cobranca-eixo-b-hardening` (F5) — RN-COB-1..6 + fiação de produção.

## 7. Como adicionar um gateway ao polling

Hoje o polling cobre Mercado Pago. Para um novo provider com re-consulta por id estável:
1. Garantir que `payment_charges.id` guardado é o id **re-consultável** do pagamento.
2. Adicionar o ramo `rcv:` no `sync<Provider>Payment` → `onReceivablePaid` (já feito p/ MP e Stone).
3. Estender o filtro de `receivableReconciliationPass` para o novo `pay_provider` e re-consultar por
   `charge.id`. Manter a guarda anti-trabalho e a janela.
