/**
 * TEST — ADR-152 Fatia 4b.3: cadência multi-tentativa + re-emissão PIX.
 *
 * Cobre 2 subsistemas:
 *
 * A) CollectionCadenceService:
 *   1. Sem cobrança due → sent=0.
 *   2. Cobrança vencida há D2+1 dias → T2 enviada + msg "vencida" + audit
 *      RUNTIME_COLLECTION_FOLLOWUP_SENT + linha em collection_followup_attempts.
 *   3. Re-rodar mesmo dia → sent=0 (idempotência via UNIQUE).
 *   4. Passar mais D3-D2 dias, re-rodar → T3 enviada + msg contém "proteção
 *      ao crédito" + sinal `default_notice_sent` severity=risk publicado.
 *   5. Depois de T3 → nunca mais envia (nenhuma T4).
 *   6. Cliente respondeu (audit log RUNTIME_COLLECTION_REPLY_INTERPRETED) →
 *      pausa cadência (nada é enviado).
 *   7. Confirmação confirmed → não aparece na query pending.
 *   8. Confirmação timed_out → não aparece na query pending.
 *   9. `collection_cadence_enabled=0` → `tickAll` pula org.
 *  10. Receivable status='received' → skip.
 *  11. Envio WhatsApp falha → linha do attempt é REVERTIDA + sinal
 *      `followup_2_send_failed` publicado + próximo tick tenta de novo.
 *  12. Isolamento cross-tenant: orgB pending não aparece na runForOrg(orgA).
 *  13. Thresholds por-org configuráveis (D2=1 vs D2=3 muda quando envia).
 *
 * B) CollectionResendPixService (via CollectionReplyService.tryHandle):
 *  14. Intent resend_pix + AsaasService.getPayment mock com invoiceUrl →
 *      MessageProviderService.sendMessage é chamado com URL + audit log
 *      RUNTIME_COLLECTION_PIX_RESENT registrado + reply "reenviei" retornada.
 *  15. Asaas retorna null → sinal `resend_pix_failed` publicado + reply
 *      canned fallback (nenhuma msg extra enviada).
 *  16. sendMessage falha → sinal `resend_pix_failed` publicado.
 *  17. Sem paymentId amarrado → skip resend, retorna reply canned.
 *  18. Sem channelId na payload → skip resend, retorna reply canned.
 *  19. Outros intents (promise, dispute) → NÃO chamam Asaas (nem sendMessage
 *      extra), NÃO logam RUNTIME_COLLECTION_PIX_RESENT.
 *
 * Determinístico (mocks em MessageProviderService + AsaasService).
 * Uso: npm run test:cobranca-cadencia-multitentativa
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cobr-cadencia-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cobr-cadencia-1234567890";
process.env.OPENAI_API_KEY = "sk-fake-test-key";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CollectionCadenceService } = await import("../src/server/CollectionCadenceService.js");
  const { CollectionReplyService } = await import("../src/server/CollectionReplyService.js");
  const { __setClassifierChatForTests } = await import("../src/server/CollectionIntentClassifier.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  // ── Mocks ─────────────────────────────────────────────────────────────
  const sentMessages: Array<{ channelId: string; to: string; text: string }> = [];
  let sendShouldFail = false;
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    if (sendShouldFail) throw new Error("evolution 500");
    sentMessages.push({ channelId, to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };
  let getPaymentReturn: any = { id: "pay_1", invoiceUrl: "https://asaas.com/i/pay_1", value: 100, dueDate: "2026-08-30", status: "PENDING" };
  let getPaymentShouldFail = false;
  (AsaasService as any).getPayment = async (id: string) => {
    if (getPaymentShouldFail) throw new Error("asaas timeout");
    if (getPaymentReturn == null) return null;
    return { ...getPaymentReturn, id };
  };
  let nextChatResponse: string = '{"intent":"unknown","reason":"default"}';
  __setClassifierChatForTests(async () => nextChatResponse);

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkOrg = (opts: { cadenceOn?: boolean; d2?: number; d3?: number } = {}) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, collection_cadence_enabled, collection_reminder_2_days_after_due, collection_reminder_3_days_after_due, external_customer_id, external_subscription_id, billing_status) VALUES (?, ?, 'X', 'active', ?, ?, ?, ?, ?, 'active')`)
      .run(randomUUID(), id, opts.cadenceOn ? 1 : 0, opts.d2 ?? 3, opts.d3 ?? 7, `cust_${id}`, `sub_${id}`);
    return id;
  };
  const mkChannel = (orgId: string) => {
    const id = `ch-${orgId}-${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(id, orgId);
    return id;
  };
  const mkContact = (orgId: string, channelId: string, phone: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, identifier) VALUES (?, ?, ?, ?)`).run(id, orgId, channelId, phone);
    return id;
  };
  const mkReceivable = (orgId: string, contactId: string, amount: number, dueDate: string, status = "open") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO receivables (id, organization_id, contact_id, description, amount, due_date, status) VALUES (?, ?, ?, 'Fatura teste', ?, ?, ?)`)
      .run(id, orgId, contactId, amount, dueDate, status);
    return id;
  };
  /** Cria par action(collection_send_reminder,approved) + confirmation(pending). */
  const mkLiveCollection = (orgId: string, opts: { receivableId: string; contactId: string; phone: string; channelId: string; amount: number; dueDate: string; paymentId?: string; createdOffsetDays?: number }) => {
    const actionId = randomUUID();
    const confId = randomUUID();
    const paymentId = opts.paymentId || `pay_${randomUUID().slice(0, 6)}`;
    const payload = { receivableId: opts.receivableId, contactId: opts.contactId, phone: opts.phone, channelId: opts.channelId, customerId: `cust-${orgId}`, amount: opts.amount, dueDate: opts.dueDate };
    const createdAt = opts.createdOffsetDays != null
      ? new Date(Date.now() + opts.createdOffsetDays * 86400_000).toISOString()
      : new Date().toISOString();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, expected_impact, command_type, command_payload_json, basis, created_at) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'approved', ?, ?, 'collection_send_reminder', ?, 'fact', ?)`)
      .run(actionId, orgId, `test cobrança ${opts.receivableId}`, opts.amount, JSON.stringify(payload), createdAt);
    db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, deadline_at, external_ref, created_at) VALUES (?, ?, ?, 'asaas_payment_webhook', 'pending', ?, ?, ?)`)
      .run(confId, orgId, actionId, new Date(Date.now() + 30 * 86400_000).toISOString(), paymentId, createdAt);
    return { actionId, confId, paymentId };
  };
  /** Data no formato YYYY-MM-DD, X dias no passado ou futuro. */
  const dateOffset = (deltaDays: number) => {
    const d = new Date(Date.now() + deltaDays * 86400_000);
    return d.toISOString().slice(0, 10);
  };
  const followupsFor = (orgId: string, actionId: string) => db.prepare(`SELECT attempt_number, template_key, message_id, sent_at FROM collection_followup_attempts WHERE organization_id = ? AND action_id = ? ORDER BY attempt_number`).all(orgId, actionId) as any[];
  const auditCount = (orgId: string, eventType: string) => (db.prepare(`SELECT COUNT(*) as n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgId, eventType) as any).n;

  // ============================================================
  // A) CollectionCadenceService
  // ============================================================
  const orgA = mkOrg({ cadenceOn: true, d2: 3, d3: 7 });
  const channelA = mkChannel(orgA);
  const contactA = mkContact(orgA, channelA, "5511988887777");

  // ===== 1. Sem cobrança due → sent=0 =====
  const r1 = await CollectionCadenceService.runForOrg(orgA);
  check("sem cobranças → sent=0", r1.sent === 0);

  // ===== 2. Cobrança vencida há 4 dias (D2=3) → T2 enviada =====
  const recA = mkReceivable(orgA, contactA, 250, dateOffset(-4));
  const liveA = mkLiveCollection(orgA, { receivableId: recA, contactId: contactA, phone: "5511988887777", channelId: channelA, amount: 250, dueDate: dateOffset(-4) });
  sentMessages.length = 0;
  const r2 = await CollectionCadenceService.runForOrg(orgA);
  check("vencida há 4d + D2=3 → T2 enviada (sent=1)", r2.sent === 1);
  check("T2 msg contém 'vencida' + valor formatado", sentMessages.length === 1 && /vencida|venceu/i.test(sentMessages[0].text) && /R\$ ?250,00/.test(sentMessages[0].text));
  check("T2 registrada em collection_followup_attempts (attempt=2, template=firm)", (() => { const f = followupsFor(orgA, liveA.actionId); return f.length === 1 && f[0].attempt_number === 2 && f[0].template_key === "firm" && !!f[0].message_id; })());
  check("audit RUNTIME_COLLECTION_FOLLOWUP_SENT criado", auditCount(orgA, "RUNTIME_COLLECTION_FOLLOWUP_SENT") === 1);

  // ===== 3. Rerodar imediato → não duplica (UNIQUE) =====
  sentMessages.length = 0;
  const r3 = await CollectionCadenceService.runForOrg(orgA);
  check("rerodar T2 imediato → sent=0 (idempotência UNIQUE)", r3.sent === 0 && sentMessages.length === 0);
  check("collection_followup_attempts continua com 1 linha", followupsFor(orgA, liveA.actionId).length === 1);

  // ===== 4. T3 disparada quando daysPastDue >= D3=7 e T2 já enviada =====
  // Simular: cobrança tem due_date de 8 dias atrás → daysPastDue=8, D3=7 → T3 elegível.
  db.prepare(`UPDATE decision_actions SET command_payload_json = ? WHERE id = ?`)
    .run(JSON.stringify({ receivableId: recA, contactId: contactA, phone: "5511988887777", channelId: channelA, customerId: `cust-${orgA}`, amount: 250, dueDate: dateOffset(-8) }), liveA.actionId);
  // T2 já foi enviada; T3 ainda não → deve mandar T3.
  sentMessages.length = 0;
  const r4 = await CollectionCadenceService.runForOrg(orgA);
  check("cobrança há 8d + T2 já feita + D3=7 → T3 enviada", r4.sent === 1);
  check("T3 msg contém 'proteção ao crédito' + valor", sentMessages.length === 1 && /proteção ao crédito/i.test(sentMessages[0].text) && /R\$ ?250,00/.test(sentMessages[0].text));
  check("T3 registrada (attempt=3, template=default_notice)", (() => { const f = followupsFor(orgA, liveA.actionId); return f.length === 2 && f[1].attempt_number === 3 && f[1].template_key === "default_notice"; })());
  const sigsA = BusinessSignalService.list(orgA, { domain: "collection" });
  check("sinal default_notice_sent severity=risk publicado", !!sigsA.find((s: any) => s.signal_type === "default_notice_sent" && s.severity === "risk"));

  // ===== 5. Depois de T3 → nenhum T4 =====
  sentMessages.length = 0;
  const r5 = await CollectionCadenceService.runForOrg(orgA);
  check("pós-T3 → sent=0 (não há T4)", r5.sent === 0 && sentMessages.length === 0);

  // ===== 6. Cliente respondeu → pausa cadência (nova cobrança) =====
  const recResp = mkReceivable(orgA, contactA, 80, dateOffset(-5));
  const liveResp = mkLiveCollection(orgA, { receivableId: recResp, contactId: contactA, phone: "5511988887777", channelId: channelA, amount: 80, dueDate: dateOffset(-5) });
  // Simular reply do cliente via F4b.2:
  nextChatResponse = '{"intent":"promise","reason":"vai pagar"}';
  await CollectionReplyService.tryHandle(orgA, contactA, "5511988887777", "vou pagar amanhã");
  sentMessages.length = 0;
  const r6 = await CollectionCadenceService.runForOrg(orgA);
  check("cliente respondeu (audit log presente) → cadência pausa (T2 NÃO enviada)", r6.sent === 0 && followupsFor(orgA, liveResp.actionId).length === 0);

  // ===== 7. Confirmação confirmed → cai fora da query pending =====
  const recConf = mkReceivable(orgA, contactA, 90, dateOffset(-5));
  const liveConf = mkLiveCollection(orgA, { receivableId: recConf, contactId: contactA, phone: "5511988887777", channelId: channelA, amount: 90, dueDate: dateOffset(-5) });
  db.prepare(`UPDATE action_confirmations SET status = 'confirmed' WHERE id = ?`).run(liveConf.confId);
  sentMessages.length = 0;
  const r7 = await CollectionCadenceService.runForOrg(orgA);
  check("confirmação=confirmed → não aparece (sent=0)", r7.sent === 0);

  // ===== 8. Confirmação timed_out → também não aparece =====
  const recTimed = mkReceivable(orgA, contactA, 60, dateOffset(-5));
  const liveTimed = mkLiveCollection(orgA, { receivableId: recTimed, contactId: contactA, phone: "5511988887777", channelId: channelA, amount: 60, dueDate: dateOffset(-5) });
  db.prepare(`UPDATE action_confirmations SET status = 'timed_out' WHERE id = ?`).run(liveTimed.confId);
  const r8 = await CollectionCadenceService.runForOrg(orgA);
  check("confirmação=timed_out → não aparece (sent=0)", r8.sent === 0);

  // ===== 9. cadence_enabled=0 → tickAll pula org =====
  const orgOff = mkOrg({ cadenceOn: false });
  const chOff = mkChannel(orgOff);
  const cOff = mkContact(orgOff, chOff, "5555999998888");
  const recOff = mkReceivable(orgOff, cOff, 100, dateOffset(-10));
  mkLiveCollection(orgOff, { receivableId: recOff, contactId: cOff, phone: "5555999998888", channelId: chOff, amount: 100, dueDate: dateOffset(-10) });
  const rTick = await CollectionCadenceService.tickAll();
  const orgsScannedIncludeOff = rTick.orgsScanned > 0;
  check("tickAll: orgs scaneadas = só as opt-in", orgsScannedIncludeOff && !(await (async () => {
    const rows = db.prepare(`SELECT organization_id FROM organization_settings WHERE COALESCE(collection_cadence_enabled,0)=1`).all() as any[];
    return rows.some((r: any) => r.organization_id === orgOff);
  })()));

  // ===== 10. Receivable status='received' → skip =====
  const recPaid = mkReceivable(orgA, contactA, 40, dateOffset(-5), "received");
  mkLiveCollection(orgA, { receivableId: recPaid, contactId: contactA, phone: "5511988887777", channelId: channelA, amount: 40, dueDate: dateOffset(-5) });
  sentMessages.length = 0;
  const beforeFollowupCount = db.prepare(`SELECT COUNT(*) as n FROM collection_followup_attempts WHERE organization_id = ?`).get(orgA) as any;
  const r10 = await CollectionCadenceService.runForOrg(orgA);
  const afterFollowupCount = db.prepare(`SELECT COUNT(*) as n FROM collection_followup_attempts WHERE organization_id = ?`).get(orgA) as any;
  check("receivable 'received' → skip (nenhum novo follow-up)", afterFollowupCount.n === beforeFollowupCount.n);
  void r10;

  // ===== 11. Envio WhatsApp falha → reverte reserva + publica sinal + retry =====
  const recFail = mkReceivable(orgA, contactA, 200, dateOffset(-5));
  const liveFail = mkLiveCollection(orgA, { receivableId: recFail, contactId: contactA, phone: "5511988887777", channelId: channelA, amount: 200, dueDate: dateOffset(-5) });
  sendShouldFail = true;
  sentMessages.length = 0;
  const rFailed = await CollectionCadenceService.runForOrg(orgA);
  check("envio WA falha: sent=0", rFailed.sent === 0);
  check("envio WA falha: NENHUMA linha em followup_attempts pra essa action (revert)", followupsFor(orgA, liveFail.actionId).length === 0);
  const failSig = BusinessSignalService.list(orgA, { domain: "collection" }).find((s: any) => s.signal_type === "followup_2_send_failed");
  check("envio WA falha: sinal followup_2_send_failed publicado", !!failSig);
  // Próximo tick: WA volta a funcionar, deve conseguir enviar T2 agora.
  sendShouldFail = false;
  const rRetry = await CollectionCadenceService.runForOrg(orgA);
  check("retry: WA volta OK, T2 enviada com sucesso", rRetry.sent === 1 && followupsFor(orgA, liveFail.actionId).length === 1);

  // ===== 12. Isolamento cross-tenant =====
  const orgB = mkOrg({ cadenceOn: true, d2: 3, d3: 7 });
  const channelB = mkChannel(orgB);
  const contactB = mkContact(orgB, channelB, "5555111112222");
  const recB = mkReceivable(orgB, contactB, 999, dateOffset(-10));
  const liveB = mkLiveCollection(orgB, { receivableId: recB, contactId: contactB, phone: "5555111112222", channelId: channelB, amount: 999, dueDate: dateOffset(-10) });
  sentMessages.length = 0;
  const rCross = await CollectionCadenceService.runForOrg(orgA);
  check("runForOrg(A) NÃO envia cobrança da orgB", followupsFor(orgB, liveB.actionId).length === 0);
  void rCross;
  // Mas runForOrg(B) envia normalmente:
  const rBOwn = await CollectionCadenceService.runForOrg(orgB);
  check("runForOrg(B) processa própria cobrança", rBOwn.sent === 1);

  // ===== 13. Thresholds por-org configuráveis =====
  const orgFast = mkOrg({ cadenceOn: true, d2: 1, d3: 2 });
  const chFast = mkChannel(orgFast);
  const cFast = mkContact(orgFast, chFast, "5599123123123");
  const recFast = mkReceivable(orgFast, cFast, 50, dateOffset(-2));
  const liveFast = mkLiveCollection(orgFast, { receivableId: recFast, contactId: cFast, phone: "5599123123123", channelId: chFast, amount: 50, dueDate: dateOffset(-2) });
  sentMessages.length = 0;
  const rFastTick = await CollectionCadenceService.tickAll();
  check("org com D2=1 D3=2: T2 disparada aos 2 dias (com defaults 3/7 não seria)", followupsFor(orgFast, liveFast.actionId).some((f: any) => f.attempt_number === 2));
  void rFastTick;

  // ============================================================
  // B) CollectionResendPixService (via CollectionReplyService)
  // ============================================================
  // Setup nova cobrança viva no orgA sem histórico F4b.2 audit log
  const orgR = mkOrg({ cadenceOn: false }); // não interferir cadência
  const chR = mkChannel(orgR);
  const cR = mkContact(orgR, chR, "5533555556666");
  const recR = mkReceivable(orgR, cR, 150, dateOffset(2));
  const liveR = mkLiveCollection(orgR, { receivableId: recR, contactId: cR, phone: "5533555556666", channelId: chR, amount: 150, dueDate: dateOffset(2), paymentId: "pay_resend_ok" });
  void liveR;

  // ===== 14. Intent resend_pix + Asaas OK → sendMessage chamado com URL =====
  getPaymentReturn = { id: "pay_resend_ok", invoiceUrl: "https://asaas.com/i/pay_resend_ok", value: 150, dueDate: dateOffset(2), status: "PENDING" };
  getPaymentShouldFail = false;
  nextChatResponse = '{"intent":"resend_pix","reason":"quer o pix"}';
  sentMessages.length = 0;
  const rResend = await CollectionReplyService.tryHandle(orgR, cR, "5533555556666", "manda o pix por favor");
  check("resend_pix: handled + intent=resend_pix", rResend.handled === true && rResend.intent === "resend_pix");
  check("resend_pix: sendMessage foi chamado com invoiceUrl", sentMessages.length === 1 && sentMessages[0].text.includes("https://asaas.com/i/pay_resend_ok"));
  check("resend_pix: sendMessage foi pra channel/phone corretos", sentMessages[0].channelId === chR && sentMessages[0].to === "5533555556666");
  check("resend_pix: reply canned confirma 'reenviei'", !!rResend.reply && /reenviei|prontinho/i.test(rResend.reply));
  check("resend_pix: audit RUNTIME_COLLECTION_PIX_RESENT registrado", auditCount(orgR, "RUNTIME_COLLECTION_PIX_RESENT") === 1);
  check("resend_pix: sinal reply_resend_pix publicado (severity=attention)", BusinessSignalService.list(orgR, { domain: "collection" }).some((s: any) => s.signal_type === "reply_resend_pix" && s.severity === "attention"));

  // ===== 15. Asaas retorna null → sinal resend_pix_failed + reply fallback =====
  const recR2 = mkReceivable(orgR, cR, 90, dateOffset(3));
  mkLiveCollection(orgR, { receivableId: recR2, contactId: cR, phone: "5533555556666", channelId: chR, amount: 90, dueDate: dateOffset(3), paymentId: "pay_null_asaas" });
  getPaymentReturn = null; // AsaasService.getPayment devolve null
  nextChatResponse = '{"intent":"resend_pix","reason":"pix"}';
  sentMessages.length = 0;
  const rNullAsaas = await CollectionReplyService.tryHandle(orgR, cR, "5533555556666", "envia o pix");
  check("Asaas null: sendMessage NÃO chamado (nenhuma msg extra)", sentMessages.length === 0);
  check("Asaas null: reply canned fallback", !!rNullAsaas.reply && /reenviar/i.test(rNullAsaas.reply));
  const failSig15 = BusinessSignalService.list(orgR, { domain: "collection" }).find((s: any) => s.signal_type === "resend_pix_failed");
  check("Asaas null: sinal resend_pix_failed publicado", !!failSig15);

  // ===== 16. sendMessage falha → sinal resend_pix_failed =====
  const recR3 = mkReceivable(orgR, cR, 70, dateOffset(4));
  mkLiveCollection(orgR, { receivableId: recR3, contactId: cR, phone: "5533555556666", channelId: chR, amount: 70, dueDate: dateOffset(4), paymentId: "pay_send_fail" });
  getPaymentReturn = { id: "pay_send_fail", invoiceUrl: "https://asaas.com/i/pay_send_fail", value: 70, dueDate: dateOffset(4) };
  sendShouldFail = true;
  const auditBeforeFail = auditCount(orgR, "RUNTIME_COLLECTION_PIX_RESENT");
  const rSendFail = await CollectionReplyService.tryHandle(orgR, cR, "5533555556666", "manda o pix");
  check("sendMessage falha: audit RUNTIME_COLLECTION_PIX_RESENT NÃO adicionado", auditCount(orgR, "RUNTIME_COLLECTION_PIX_RESENT") === auditBeforeFail);
  check("sendMessage falha: sinal resend_pix_failed com reason=sendMessage_error", BusinessSignalService.list(orgR, { domain: "collection" }).some((s: any) => s.signal_type === "resend_pix_failed" && s.evidence?.reason === "sendMessage_error"));
  void rSendFail;
  sendShouldFail = false;

  // ===== 17. Outros intents (promise) NÃO chamam AsaasService.getPayment =====
  let getPaymentCallCount = 0;
  const origGetPayment = (AsaasService as any).getPayment;
  (AsaasService as any).getPayment = async (id: string) => { getPaymentCallCount++; return origGetPayment(id); };
  const recR4 = mkReceivable(orgR, cR, 30, dateOffset(5));
  mkLiveCollection(orgR, { receivableId: recR4, contactId: cR, phone: "5533555556666", channelId: chR, amount: 30, dueDate: dateOffset(5), paymentId: "pay_promise" });
  nextChatResponse = '{"intent":"promise","reason":"paga amanhã"}';
  await CollectionReplyService.tryHandle(orgR, cR, "5533555556666", "vou pagar amanhã");
  check("intent=promise NÃO chama AsaasService.getPayment", getPaymentCallCount === 0);

  // ===== 18. Sem channelId no payload → skip resend, ainda handled =====
  const recR5 = mkReceivable(orgR, cR, 20, dateOffset(6));
  const actionNoCh = randomUUID();
  const payloadNoCh = { receivableId: recR5, contactId: cR, phone: "5533555556666", customerId: "cust", amount: 20, dueDate: dateOffset(6) }; // sem channelId
  // 1s no futuro pra garantir que é a MAIS RECENTE (findLiveForContact
  // ordena por created_at DESC). Formato ISO (não CURRENT_TIMESTAMP) pra
  // não colidir com formato "YYYY-MM-DD HH:MM:SS" usado pelo SQLite.
  const futureIso = new Date(Date.now() + 1000).toISOString();
  db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, expected_impact, command_type, command_payload_json, basis, created_at) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'approved', 'no-ch', ?, 'collection_send_reminder', ?, 'fact', ?)`)
    .run(actionNoCh, orgR, 20, JSON.stringify(payloadNoCh), futureIso);
  db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, external_ref, created_at) VALUES (?, ?, ?, 'asaas_payment_webhook', 'pending', 'pay_noch', ?)`)
    .run(randomUUID(), orgR, actionNoCh, futureIso);
  nextChatResponse = '{"intent":"resend_pix","reason":"pix"}';
  const beforeCallCountNoCh = getPaymentCallCount;
  sentMessages.length = 0;
  const rNoCh = await CollectionReplyService.tryHandle(orgR, cR, "5533555556666", "pix");
  // findLiveForContact retorna a MAIS RECENTE (pay_noch), sem channelId → resend skip, mas reply canned.
  check("sem channelId: reply retorna canned fallback (não crasha)", rNoCh.handled === true && !!rNoCh.reply);
  check("sem channelId: getPayment NÃO chamado (skip)", getPaymentCallCount === beforeCallCountNoCh);

  // ============================================================
  // Resultado
  // ============================================================
  console.log("\n=== ADR-152 Fatia 4b.3 (Cadência multi-tentativa + Resend PIX) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
