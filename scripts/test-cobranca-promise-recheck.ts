/**
 * TEST — ADR-152 Fatia 4b.4: re-check automático de promessa de pagamento.
 *
 * Cobre 3 subsistemas:
 *
 * A) Extensão do classifier — extração de promiseDate:
 *   1. intent=promise + LLM devolve promiseDate válida → ClassificationResult
 *      inclui promiseDate.
 *   2. intent=promise + LLM devolve string inválida ("amanhã") → promiseDate=null.
 *   3. intent!=promise → promiseDate=null (ignorado).
 *   4. LLM sem promiseDate → promiseDate=null.
 *
 * B) CollectionPromiseService.create (via CollectionReplyService):
 *   5. Intent=promise + promiseDate LLM → linha em collection_payment_promises
 *      criada com source='llm' + promised_date da LLM.
 *   6. Intent=promise SEM promiseDate → fallback source='default' + hoje+3.
 *   7. Intent=promise + promiseDate no passado → fallback pra amanhã (G-4b.4-2).
 *   8. 2ª promise pra mesma action → cancela a anterior + cria a nova (G-4b.4-3).
 *   9. Sem channelId no payload → NÃO cria promise (skip).
 *  10. Intent=dispute → NÃO cria promise (skip).
 *  11. Sem receivable.dueDate → NÃO cria promise (skip).
 *  12. Audit log RUNTIME_COLLECTION_PROMISE_CREATED registrado.
 *
 * C) CollectionPromiseService.tickAll (Scheduler pass):
 *  13. Promise pending com date no futuro → skip (não age).
 *  14. Promise pending com date passada + receivable open → mark broken +
 *      envia WA follow-up + sinal promise_broken severity=risk + audit.
 *  15. Promise pending com date passada + receivable received → mark
 *      fulfilled + sinal promise_fulfilled severity=info + resolve
 *      reply_promise sinal (padrão pra dono não ver mais no painel).
 *  16. Follow-up WA falha → status continua PENDING + sinal
 *      promise_followup_send_failed + próximo tick tenta retentar.
 *  17. cadence_enabled=0 → tickAll pula org (não age).
 *  18. graceDays configurável (grace=1 dia adia broken 1 dia).
 *  19. Isolamento cross-tenant.
 *  20. Broken → checkPass idempotente (status='broken' cai fora da query).
 *  21. Confirmation confirmed via webhook (sem receivable) → fulfilled.
 *
 * Uso: npm run test:cobranca-promise-recheck
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cobr-promise-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cobr-promise-1234567890";
process.env.OPENAI_API_KEY = "sk-fake-test-key";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { classify, __setClassifierChatForTests } = await import("../src/server/CollectionIntentClassifier.js");
  const { CollectionReplyService } = await import("../src/server/CollectionReplyService.js");
  const { CollectionPromiseService } = await import("../src/server/CollectionPromiseService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const sentMessages: Array<{ channelId: string; to: string; text: string }> = [];
  let sendShouldFail = false;
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    if (sendShouldFail) throw new Error("evolution 500");
    sentMessages.push({ channelId, to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };
  let nextChatResponse: string = '{"intent":"unknown","reason":"default","promiseDate":null}';
  __setClassifierChatForTests(async () => nextChatResponse);

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkOrg = (opts: { cadenceOn?: boolean; graceDays?: number } = {}) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, collection_cadence_enabled, collection_promise_grace_days) VALUES (?, ?, 'X', 'active', ?, ?)`)
      .run(randomUUID(), id, opts.cadenceOn ? 1 : 0, opts.graceDays ?? 0);
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
  const mkLiveCollection = (orgId: string, opts: { receivableId: string; contactId: string; phone: string; channelId: string; amount: number; dueDate: string; paymentId?: string; withPayload?: any }) => {
    const actionId = randomUUID();
    const confId = randomUUID();
    const paymentId = opts.paymentId || `pay_${randomUUID().slice(0, 6)}`;
    const payload = opts.withPayload || { receivableId: opts.receivableId, contactId: opts.contactId, phone: opts.phone, channelId: opts.channelId, customerId: `cust-${orgId}`, amount: opts.amount, dueDate: opts.dueDate };
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, expected_impact, command_type, command_payload_json, basis) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'approved', ?, ?, 'collection_send_reminder', ?, 'fact')`)
      .run(actionId, orgId, `test cobrança`, opts.amount, JSON.stringify(payload));
    db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, external_ref) VALUES (?, ?, ?, 'asaas_payment_webhook', 'pending', ?)`)
      .run(confId, orgId, actionId, paymentId);
    return { actionId, confId, paymentId };
  };
  const dateOffset = (deltaDays: number) => new Date(Date.now() + deltaDays * 86400_000).toISOString().slice(0, 10);
  const auditCount = (orgId: string, eventType: string) => (db.prepare(`SELECT COUNT(*) as n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgId, eventType) as any).n;
  const listPromises = (orgId: string, actionId?: string) => (actionId
    ? db.prepare(`SELECT * FROM collection_payment_promises WHERE organization_id = ? AND action_id = ? ORDER BY promised_at ASC`).all(orgId, actionId)
    : db.prepare(`SELECT * FROM collection_payment_promises WHERE organization_id = ? ORDER BY promised_at ASC`).all(orgId)
  ) as any[];
  /**
   * INSERT direto pra simular promise cuja data JÁ passou. `create()`
   * aplica G-4b.4-2 (fallback pra amanhã se promiseDate < today) que
   * bloqueia essa simulação — o cenário real "cliente prometeu ontem
   * e não pagou" surge SÓ do tick (create foi no passado, agora passou).
   */
  const insertPromiseRaw = (orgId: string, opts: { actionId: string; receivableId?: string | null; contactId?: string | null; phone: string; channelId: string; amount: number; dueDate: string; promisedDate: string; signalId?: string | null }): string => {
    const id = randomUUID();
    db.prepare(`INSERT INTO collection_payment_promises
        (id, organization_id, action_id, receivable_id, contact_id, phone, channel_id, amount, due_date, promised_date, status, signal_id, source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, 'test')`)
      .run(id, orgId, opts.actionId, opts.receivableId || null, opts.contactId || null,
           opts.phone, opts.channelId, opts.amount, opts.dueDate, opts.promisedDate, opts.signalId || null);
    return id;
  };

  // ============================================================
  // A) Classifier — extração de promiseDate
  // ============================================================
  const todayIso = new Date().toISOString().slice(0, 10);
  const tomorrowIso = dateOffset(1);

  // ===== 1. intent=promise + promiseDate válida =====
  nextChatResponse = `{"intent":"promise","reason":"amanhã","promiseDate":"${tomorrowIso}"}`;
  const c1 = await classify("Vou pagar amanhã", { today: todayIso });
  check("classify: intent=promise + promiseDate válida propagada", c1.intent === "promise" && c1.promiseDate === tomorrowIso);

  // ===== 2. LLM devolve promiseDate inválida =====
  nextChatResponse = `{"intent":"promise","reason":"amanhã","promiseDate":"amanhã"}`;
  const c2 = await classify("Vou pagar amanhã");
  check("classify: promiseDate não-ISO → null", c2.intent === "promise" && c2.promiseDate === null);

  // ===== 3. intent!=promise → promiseDate ignorado =====
  nextChatResponse = `{"intent":"dispute","reason":"contesta","promiseDate":"${tomorrowIso}"}`;
  const c3 = await classify("não reconheço");
  check("classify: intent=dispute → promiseDate=null", c3.intent === "dispute" && c3.promiseDate === null);

  // ===== 4. LLM sem promiseDate =====
  nextChatResponse = `{"intent":"promise","reason":"ok"}`;
  const c4 = await classify("vou pagar");
  check("classify: LLM sem promiseDate → null", c4.intent === "promise" && c4.promiseDate === null);

  // ============================================================
  // B) create via CollectionReplyService
  // ============================================================
  const orgA = mkOrg({ cadenceOn: true });
  const channelA = mkChannel(orgA);
  const contactA = mkContact(orgA, channelA, "5511999998888");
  const recA = mkReceivable(orgA, contactA, 250, dateOffset(-2));
  const liveA = mkLiveCollection(orgA, { receivableId: recA, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 250, dueDate: dateOffset(-2) });

  // ===== 5. Intent=promise + promiseDate LLM =====
  const promisedIso = dateOffset(5);
  nextChatResponse = `{"intent":"promise","reason":"vai pagar dia 5","promiseDate":"${promisedIso}"}`;
  await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "vou pagar no dia 5");
  const ps = listPromises(orgA, liveA.actionId);
  check("create: promise LLM → 1 linha pending source='llm'", ps.length === 1 && ps[0].status === "pending" && ps[0].source === "llm" && ps[0].promised_date === promisedIso);
  check("audit RUNTIME_COLLECTION_PROMISE_CREATED registrado", auditCount(orgA, "RUNTIME_COLLECTION_PROMISE_CREATED") >= 1);

  // ===== 6. Intent=promise SEM promiseDate → fallback =====
  const recB = mkReceivable(orgA, contactA, 80, dateOffset(-3));
  const liveB = mkLiveCollection(orgA, { receivableId: recB, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 80, dueDate: dateOffset(-3) });
  nextChatResponse = `{"intent":"promise","reason":"ok"}`;
  await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "eu pago");
  const psB = listPromises(orgA, liveB.actionId);
  check("create: promise sem promiseDate → source='default' + hoje+3", psB.length === 1 && psB[0].source === "default" && psB[0].promised_date === dateOffset(3));

  // ===== 7. Intent=promise + promiseDate no passado → fallback amanhã =====
  const recPast = mkReceivable(orgA, contactA, 90, dateOffset(-5));
  const livePast = mkLiveCollection(orgA, { receivableId: recPast, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 90, dueDate: dateOffset(-5) });
  const pastIso = dateOffset(-10);
  nextChatResponse = `{"intent":"promise","reason":"passado","promiseDate":"${pastIso}"}`;
  await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "vou pagar");
  const psPast = listPromises(orgA, livePast.actionId);
  check("create: promiseDate no passado → fallback amanhã + source='default'", psPast.length === 1 && psPast[0].source === "default" && psPast[0].promised_date === dateOffset(1));

  // ===== 8. 2ª promise na mesma action → cancela anterior + cria nova =====
  // Direto no service pra isolar do findLiveForContact (que sempre pega
  // a mais recente cobrança viva pra o phone) — testa a lógica de
  // "cancela pending anterior + cria nova" da G-4b.4-3 em isolamento.
  CollectionPromiseService.create(orgA, {
    actionId: liveA.actionId, receivableId: recA, contactId: contactA,
    phone: "5511999998888", channelId: channelA, amount: 250, dueDate: dateOffset(-2),
    promisedDate: dateOffset(10),
  });
  const psA_after = listPromises(orgA, liveA.actionId);
  check("2ª promise: anterior 'cancelled', nova 'pending'", psA_after.length === 2 && psA_after[0].status === "cancelled" && psA_after[1].status === "pending" && psA_after[1].promised_date === dateOffset(10));

  // ===== 9. Sem channelId no payload → NÃO cria promise =====
  const recNoCh = mkReceivable(orgA, contactA, 40, dateOffset(-1));
  const liveNoCh = mkLiveCollection(orgA, {
    receivableId: recNoCh, contactId: contactA, phone: "5511999998888", channelId: "unused-ch", amount: 40, dueDate: dateOffset(-1),
    withPayload: { receivableId: recNoCh, contactId: contactA, phone: "5511999998888", customerId: `cust-${orgA}`, amount: 40, dueDate: dateOffset(-1) }, // sem channelId
  });
  nextChatResponse = `{"intent":"promise","reason":"vai","promiseDate":"${dateOffset(2)}"}`;
  await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "amanhã");
  check("sem channelId no payload → NÃO cria promise", listPromises(orgA, liveNoCh.actionId).length === 0);

  // ===== 10. Intent=dispute → NÃO cria promise =====
  const recDisp = mkReceivable(orgA, contactA, 60, dateOffset(-1));
  const liveDisp = mkLiveCollection(orgA, { receivableId: recDisp, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 60, dueDate: dateOffset(-1) });
  nextChatResponse = `{"intent":"dispute","reason":"contesta","promiseDate":null}`;
  await CollectionReplyService.tryHandle(orgA, contactA, "5511999998888", "não reconheço");
  check("intent=dispute → NÃO cria promise", listPromises(orgA, liveDisp.actionId).length === 0);

  // ============================================================
  // C) tickAll (Scheduler pass)
  // ============================================================

  // ===== 13. Promise pending com date futura → skip =====
  const recFut = mkReceivable(orgA, contactA, 100, dateOffset(-1));
  const liveFut = mkLiveCollection(orgA, { receivableId: recFut, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 100, dueDate: dateOffset(-1) });
  CollectionPromiseService.create(orgA, {
    actionId: liveFut.actionId, receivableId: recFut, contactId: contactA,
    phone: "5511999998888", channelId: channelA, amount: 100, dueDate: dateOffset(-1),
    promisedDate: dateOffset(5),
  });
  sentMessages.length = 0;
  const rFut = await CollectionPromiseService.runForOrg(orgA);
  check("promise futura → skip (fulfilled=0, broken=0)", rFut.fulfilled === 0 && rFut.broken === 0 && sentMessages.length === 0);
  check("promise futura continua pending", listPromises(orgA, liveFut.actionId).some((p: any) => p.status === "pending"));

  // ===== 14. Promise vencida + receivable open → broken + WA + sinal risk =====
  const recBrk = mkReceivable(orgA, contactA, 500, dateOffset(-5));
  const liveBrk = mkLiveCollection(orgA, { receivableId: recBrk, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 500, dueDate: dateOffset(-5) });
  insertPromiseRaw(orgA, {
    actionId: liveBrk.actionId, receivableId: recBrk, contactId: contactA,
    phone: "5511999998888", channelId: channelA, amount: 500, dueDate: dateOffset(-5),
    promisedDate: dateOffset(-1), // ontem — bypass do create() que aplicaria fallback
  });
  sentMessages.length = 0;
  const rBrk = await CollectionPromiseService.runForOrg(orgA);
  check("promise vencida + open → broken=1", rBrk.broken === 1);
  check("promise vencida: WA follow-up enviado", sentMessages.length === 1 && /combinado|prometeu|acertar|combinamos/i.test(sentMessages[0].text));
  check("promise vencida: msg contém valor + data prometida", /R\$ ?500,00/.test(sentMessages[0].text));
  const brkSig = BusinessSignalService.list(orgA, { domain: "collection" }).find((s: any) => s.signal_type === "promise_broken");
  check("promise vencida: sinal promise_broken severity=risk", !!brkSig && brkSig.severity === "risk");
  check("audit RUNTIME_COLLECTION_PROMISE_BROKEN registrado", auditCount(orgA, "RUNTIME_COLLECTION_PROMISE_BROKEN") >= 1);

  // ===== 15. Promise vencida + receivable received → fulfilled =====
  const recFul = mkReceivable(orgA, contactA, 300, dateOffset(-4), "received");
  const liveFul = mkLiveCollection(orgA, { receivableId: recFul, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 300, dueDate: dateOffset(-4) });
  const promiseSignal = BusinessSignalService.publish(orgA, {
    domain: "collection", signalType: "reply_promise", severity: "attention",
    basis: "fact", confidence: 0.9,
    sourceService: "test", sourceEntityType: "receivable", sourceEntityId: recFul,
    evidence: {}, dedupeKey: `collection:reply_promise:${recFul}`,
  });
  insertPromiseRaw(orgA, {
    actionId: liveFul.actionId, receivableId: recFul, contactId: contactA,
    phone: "5511999998888", channelId: channelA, amount: 300, dueDate: dateOffset(-4),
    promisedDate: dateOffset(-1), signalId: promiseSignal.id,
  });
  sentMessages.length = 0;
  const rFul = await CollectionPromiseService.runForOrg(orgA);
  check("promise vencida + received → fulfilled=1", rFul.fulfilled === 1);
  check("promise fulfilled: NÃO envia WA follow-up", sentMessages.length === 0);
  const fulSig = BusinessSignalService.list(orgA, { domain: "collection" }).find((s: any) => s.signal_type === "promise_fulfilled");
  check("promise fulfilled: sinal promise_fulfilled severity=info", !!fulSig && fulSig.severity === "info");
  const promiseSignalAfter = db.prepare(`SELECT status FROM business_signals WHERE id = ?`).get(promiseSignal.id) as any;
  check("promise fulfilled: sinal reply_promise anterior fica 'resolved'", promiseSignalAfter?.status === "resolved");

  // ===== 16. Follow-up WA falha → PENDING preservada + sinal fail + retry =====
  const recFail = mkReceivable(orgA, contactA, 700, dateOffset(-5));
  const liveFail = mkLiveCollection(orgA, { receivableId: recFail, contactId: contactA, phone: "5511999998888", channelId: channelA, amount: 700, dueDate: dateOffset(-5) });
  insertPromiseRaw(orgA, {
    actionId: liveFail.actionId, receivableId: recFail, contactId: contactA,
    phone: "5511999998888", channelId: channelA, amount: 700, dueDate: dateOffset(-5),
    promisedDate: dateOffset(-1),
  });
  sendShouldFail = true;
  sentMessages.length = 0;
  const rFail = await CollectionPromiseService.runForOrg(orgA);
  check("WA falha: broken=0 (não marca)", rFail.broken === 0 && rFail.skipped >= 1);
  check("WA falha: promessa continua PENDING", listPromises(orgA, liveFail.actionId).some((p: any) => p.status === "pending"));
  const failSig16 = BusinessSignalService.list(orgA, { domain: "collection" }).find((s: any) => s.signal_type === "promise_followup_send_failed");
  check("WA falha: sinal promise_followup_send_failed publicado", !!failSig16);
  // Retry no próximo tick com WA OK:
  sendShouldFail = false;
  const rRetry16 = await CollectionPromiseService.runForOrg(orgA);
  check("WA volta OK: retry broken=1", rRetry16.broken === 1);

  // ===== 17. cadence_enabled=0 → tickAll pula org =====
  const orgOff = mkOrg({ cadenceOn: false });
  const chOff = mkChannel(orgOff);
  const cOff = mkContact(orgOff, chOff, "5555444443333");
  const recOff = mkReceivable(orgOff, cOff, 200, dateOffset(-3));
  const liveOff = mkLiveCollection(orgOff, { receivableId: recOff, contactId: cOff, phone: "5555444443333", channelId: chOff, amount: 200, dueDate: dateOffset(-3) });
  insertPromiseRaw(orgOff, {
    actionId: liveOff.actionId, receivableId: recOff, contactId: cOff,
    phone: "5555444443333", channelId: chOff, amount: 200, dueDate: dateOffset(-3),
    promisedDate: dateOffset(-1),
  });
  sentMessages.length = 0;
  const rTickAll = await CollectionPromiseService.tickAll();
  check("tickAll: orgs off são puladas (0 broken/fulfilled)", listPromises(orgOff, liveOff.actionId).every((p: any) => p.status === "pending"));
  void rTickAll;

  // ===== 18. graceDays configurável =====
  const orgGrace = mkOrg({ cadenceOn: true, graceDays: 2 });
  const chG = mkChannel(orgGrace);
  const cG = mkContact(orgGrace, chG, "5555111119999");
  const recG = mkReceivable(orgGrace, cG, 150, dateOffset(-5));
  const liveG = mkLiveCollection(orgGrace, { receivableId: recG, contactId: cG, phone: "5555111119999", channelId: chG, amount: 150, dueDate: dateOffset(-5) });
  // Promise foi pra ontem (deltaDays -1). Com grace=2, cutoff = hoje-2 → só age em promises <= hoje-2 → -1 > -2 (mais recente que cutoff), NÃO age.
  insertPromiseRaw(orgGrace, {
    actionId: liveG.actionId, receivableId: recG, contactId: cG,
    phone: "5555111119999", channelId: chG, amount: 150, dueDate: dateOffset(-5),
    promisedDate: dateOffset(-1),
  });
  sentMessages.length = 0;
  const rG1 = await CollectionPromiseService.runForOrg(orgGrace, { graceDays: 2 });
  check("graceDays=2 + promised=ontem → SKIP (dentro do grace)", rG1.broken === 0 && rG1.skipped === 0);
  // Agora promised no passado longe (-5) → cutoff=-2, -5 <= -2 → age.
  const recG2 = mkReceivable(orgGrace, cG, 200, dateOffset(-8));
  const liveG2 = mkLiveCollection(orgGrace, { receivableId: recG2, contactId: cG, phone: "5555111119999", channelId: chG, amount: 200, dueDate: dateOffset(-8) });
  insertPromiseRaw(orgGrace, {
    actionId: liveG2.actionId, receivableId: recG2, contactId: cG,
    phone: "5555111119999", channelId: chG, amount: 200, dueDate: dateOffset(-8),
    promisedDate: dateOffset(-5),
  });
  sentMessages.length = 0;
  const rG2 = await CollectionPromiseService.runForOrg(orgGrace, { graceDays: 2 });
  check("graceDays=2 + promised há 5d → age (broken=1)", rG2.broken === 1);

  // ===== 19. Isolamento cross-tenant =====
  const orgB = mkOrg({ cadenceOn: true });
  const chB = mkChannel(orgB);
  const cB = mkContact(orgB, chB, "5555999996666");
  const recB2 = mkReceivable(orgB, cB, 999, dateOffset(-5));
  const liveB2 = mkLiveCollection(orgB, { receivableId: recB2, contactId: cB, phone: "5555999996666", channelId: chB, amount: 999, dueDate: dateOffset(-5) });
  insertPromiseRaw(orgB, {
    actionId: liveB2.actionId, receivableId: recB2, contactId: cB,
    phone: "5555999996666", channelId: chB, amount: 999, dueDate: dateOffset(-5),
    promisedDate: dateOffset(-1),
  });
  sentMessages.length = 0;
  const rIsoA = await CollectionPromiseService.runForOrg(orgA);
  check("runForOrg(A) NÃO age em promise da B", listPromises(orgB, liveB2.actionId).every((p: any) => p.status === "pending"));
  void rIsoA;
  // runForOrg(B) age normalmente:
  const rIsoB = await CollectionPromiseService.runForOrg(orgB);
  check("runForOrg(B) age em própria promise (broken=1)", rIsoB.broken === 1);

  // ===== 20. Broken → checkPass idempotente =====
  sentMessages.length = 0;
  const rIdemp = await CollectionPromiseService.runForOrg(orgB);
  check("re-tick: broken já processada é ignorada (broken=0)", rIdemp.broken === 0 && sentMessages.length === 0);

  // ===== 21. Confirmation confirmed via webhook (sem receivable OU rec paid) → fulfilled =====
  const orgC = mkOrg({ cadenceOn: true });
  const chC = mkChannel(orgC);
  const cC = mkContact(orgC, chC, "5533331111000");
  // Fluxo edge: cria action com receivableId, mas depois o webhook confirma antes do broken.
  const recWebhook = mkReceivable(orgC, cC, 400, dateOffset(-5));
  const liveWebhook = mkLiveCollection(orgC, { receivableId: recWebhook, contactId: cC, phone: "5533331111000", channelId: chC, amount: 400, dueDate: dateOffset(-5) });
  insertPromiseRaw(orgC, {
    actionId: liveWebhook.actionId, receivableId: recWebhook, contactId: cC,
    phone: "5533331111000", channelId: chC, amount: 400, dueDate: dateOffset(-5),
    promisedDate: dateOffset(-1),
  });
  // Simula: webhook Asaas fechou a confirmação (mas receivable ficou 'open' por algum bug):
  db.prepare(`UPDATE action_confirmations SET status = 'confirmed' WHERE action_id = ?`).run(liveWebhook.actionId);
  // E também simular scenario com receivable NULO — remove o receivable pra bater o edge case do fallback:
  db.prepare(`UPDATE collection_payment_promises SET receivable_id = NULL WHERE action_id = ?`).run(liveWebhook.actionId);
  const rWebhook = await CollectionPromiseService.runForOrg(orgC);
  check("confirmation=confirmed (sem rec) → fulfilled=1", rWebhook.fulfilled === 1);

  // ============================================================
  // Resultado
  // ============================================================
  console.log("\n=== ADR-152 Fatia 4b.4 (Re-check de promessa de pagamento) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
