/**
 * TEST — ADR-152 Fatia 4c.4: atribuição de revenue_recovered real
 * quando ticket vira `ganho` após approval de recuperação.
 *
 * Cobre:
 *
 * A) computeTicketValue (precedência de fonte):
 *   1. `orders` pagos → source='orders' + basis='fact'.
 *   2. Sem orders pagos + quote aceito → source='quotes' + basis='estimate'.
 *   3. Sem orders/quotes + contacts.avg_ticket → source='contacts_avg_ticket'.
 *   4. Nada disponível → value=0 + source='zero'.
 *   5. Orders com status não-pago (novo/cancelado) NÃO conta.
 *
 * B) attributeOne (unit-level):
 *   6. Touch elegível + orders → atribui + outcome F3.1 revenueRecovered.
 *   7. Sem touch em janela → skip com reason='no_touch_in_window'.
 *   8. Touch com reply_intent='remove_me' → skip inelegível.
 *   9. Touch com reply_intent='interested' → atribui.
 *  10. Touch com reply_intent='meeting_request' → atribui.
 *  11. Touch com reply_intent=null → atribui (cliente pode ter ganho
 *      sem responder no canal).
 *  12. Ticket value=0 → skip com reason='orders_zero_paid'.
 *
 * C) runForOrg + Scheduler:
 *  13. Ticket vira ganho + touch há 7d (janela=30) → atribui.
 *  14. Rerodar → dedupe (UNIQUE constraint), skip com already_attributed.
 *  15. Sem opt-in → tickAll pula org.
 *  16. Ganho fora da janela (60d atrás, janela=30) → NÃO atribui.
 *  17. Isolamento cross-tenant.
 *  18. Reversão: ganho → aberto → ganho de novo = 2 atribuições
 *      (eventos distintos).
 *  19. Audit RUNTIME_SALES_RECOVERY_ATTRIBUTED registrado.
 *  20. Ledger F3.1 acumula revenueRecovered no total categorias.
 *
 * D) Integração ponta-a-ponta (F4c MVP + 4c.2 + 4c.4):
 *  21. approve() cria touch → 15d depois cliente vira ganho no CRM →
 *      attributionPass grava outcome F3.1 com revenue real do order.
 *
 * Uso: npm run test:sales-recovery-attribution
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sales-attr-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sales-attr-1234567890";
process.env.OPENAI_API_KEY = "sk-fake-test-key";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SalesRecoveryAttributionService } = await import("../src/server/SalesRecoveryAttributionService.js");
  const { SalesRecoveryPlaybookService } = await import("../src/server/SalesRecoveryPlaybook.js");
  const { SalesStalledDealDetectorService } = await import("../src/server/SalesStalledDealDetectorService.js");
  const { OutcomeMeasurementService } = await import("../src/server/OutcomeMeasurementService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { __setGeneratorChatForTests } = await import("../src/server/SalesRecoveryMessageGenerator.js");

  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => `msg_${randomUUID().slice(0, 8)}`;
  __setGeneratorChatForTests(async () => '{"text":"Oi mock"}');

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkOrg = (opts: { attrOn?: boolean; windowDays?: number } = {}) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled, sales_recovery_enabled, sales_recovery_attribution_enabled, sales_recovery_attribution_window_days) VALUES (?, ?, 'X', 'active', 1, 1, ?, ?)`)
      .run(randomUUID(), id, opts.attrOn ? 1 : 0, opts.windowDays ?? 30);
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'runtime_step_propose', 'execute', 'approved_execution', 1)`).run(randomUUID(), id);
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'sales_recovery_propose_message', 'execute', 'approved_execution', 1)`).run(randomUUID(), id);
    return id;
  };
  const mkChannel = (orgId: string) => {
    const id = `ch-${orgId}-${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(id, orgId);
    return id;
  };
  const mkContact = (orgId: string, channelId: string, name: string, phone: string, avgTicket?: number) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, avg_ticket) VALUES (?, ?, ?, ?, ?, ?)`).run(id, orgId, channelId, name, phone, avgTicket ?? null);
    return id;
  };
  const mkTicket = (orgId: string, contactId: string, opts: { updatedDaysAgo?: number; stage?: string } = {}) => {
    const id = randomUUID();
    const updatedIso = new Date(Date.now() - (opts.updatedDaysAgo ?? 15) * 86400_000).toISOString();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage, updated_at) VALUES (?, ?, ?, 'open', ?, ?)`)
      .run(id, orgId, contactId, opts.stage || "proposta", updatedIso);
    return id;
  };
  const mkOrder = (orgId: string, ticketId: string, total: number, status: string = "pago", contactId?: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, ticket_id, contact_id, total_amount, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, ticketId, contactId || null, total, status);
    return id;
  };
  const mkQuote = (orgId: string, ticketId: string, total: number, status: string = "accepted") => {
    const id = randomUUID();
    db.prepare(`INSERT INTO quotes (id, organization_id, ticket_id, total_amount, status, accepted_at) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
      .run(id, orgId, ticketId, total, status);
    return id;
  };
  const insertTouchRaw = (orgId: string, opts: { ticketId: string; contactId: string; phone: string; channelId: string; sentDaysAgo?: number; replyIntent?: string | null; proposedSignalId?: string | null; }) => {
    const id = randomUUID();
    const sentIso = new Date(Date.now() - (opts.sentDaysAgo ?? 5) * 86400_000).toISOString();
    db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, sent_at, reply_intent, proposed_signal_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, opts.ticketId, opts.contactId, opts.phone, opts.channelId, sentIso, opts.replyIntent || null, opts.proposedSignalId || null);
    return id;
  };
  const logWonStage = (orgId: string, ticketId: string, daysAgo: number = 0, changedBy: string = "user1") => {
    const id = randomUUID();
    const iso = new Date(Date.now() - daysAgo * 86400_000).toISOString();
    db.prepare(`INSERT INTO ticket_stage_logs (id, organization_id, ticket_id, from_stage, to_stage, changed_by, created_at) VALUES (?, ?, ?, 'proposta', 'ganho', ?, ?)`)
      .run(id, orgId, ticketId, changedBy, iso);
    return { id, stageChangeAt: iso };
  };
  // Insere DecisionAction + business_signal amarrado (necessário pra
  // resolveActionId funcionar).
  const setupAction = (orgId: string, ticketId: string, contactId: string) => {
    const actionId = randomUUID();
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, command_type, command_payload_json, basis) VALUES (?, ?, 'runtime', 'runtime_step_propose', 'approved', 'test', 'sales_recovery_propose_message', ?, 'estimate')`)
      .run(actionId, orgId, JSON.stringify({ ticketId, contactId }));
    const sigId = randomUUID();
    db.prepare(`INSERT INTO business_signals (id, organization_id, domain, signal_type, severity, basis, confidence, source_service, source_entity_type, source_entity_id, evidence_json, dedupe_key, status) VALUES (?, ?, 'sales', 'sales_recovery_proposed', 'attention', 'estimate', 0.8, 'SalesRecoveryPlaybook', 'ticket', ?, ?, ?, 'open')`)
      .run(sigId, orgId, ticketId, JSON.stringify({ actionId, ticketId }), `sales_recovery:proposed:${ticketId}:test`);
    return { actionId, sigId };
  };
  const auditCount = (orgId: string, eventType: string) => (db.prepare(`SELECT COUNT(*) as n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgId, eventType) as any).n;
  const listAttrs = (orgId: string, ticketId?: string) => (ticketId
    ? db.prepare(`SELECT * FROM sales_recovery_attributions WHERE organization_id = ? AND ticket_id = ? ORDER BY stage_change_at ASC`).all(orgId, ticketId)
    : db.prepare(`SELECT * FROM sales_recovery_attributions WHERE organization_id = ? ORDER BY stage_change_at ASC`).all(orgId)) as any[];

  // ============================================================
  // A) computeTicketValue
  // ============================================================
  const orgA = mkOrg({ attrOn: true });
  const chA = mkChannel(orgA);

  // ===== 1. orders pagos =====
  const c1 = mkContact(orgA, chA, "C1", "5511000001111");
  const t1 = mkTicket(orgA, c1);
  mkOrder(orgA, t1, 150, "pago");
  mkOrder(orgA, t1, 50, "entregue");
  const v1 = SalesRecoveryAttributionService.computeTicketValue(orgA, t1);
  check("computeTicketValue orders: value=200 source=orders basis=fact", v1.value === 200 && v1.source === "orders" && v1.basis === "fact");

  // ===== 2. Sem orders + quote accepted =====
  const c2 = mkContact(orgA, chA, "C2", "5511000002222");
  const t2 = mkTicket(orgA, c2);
  mkQuote(orgA, t2, 500, "accepted");
  const v2 = SalesRecoveryAttributionService.computeTicketValue(orgA, t2);
  check("computeTicketValue quotes: value=500 source=quotes basis=estimate", v2.value === 500 && v2.source === "quotes" && v2.basis === "estimate");

  // ===== 3. Sem orders + sem quote aceito + avg_ticket =====
  const c3 = mkContact(orgA, chA, "C3", "5511000003333", 300);
  const t3 = mkTicket(orgA, c3);
  const v3 = SalesRecoveryAttributionService.computeTicketValue(orgA, t3);
  check("computeTicketValue avg: value=300 source=contacts_avg_ticket basis=estimate", v3.value === 300 && v3.source === "contacts_avg_ticket" && v3.basis === "estimate");

  // ===== 4. Nada disponível =====
  const c4 = mkContact(orgA, chA, "C4", "5511000004444");
  const t4 = mkTicket(orgA, c4);
  const v4 = SalesRecoveryAttributionService.computeTicketValue(orgA, t4);
  check("computeTicketValue vazio: value=0 source=zero", v4.value === 0 && v4.source === "zero");

  // ===== 5. Orders com status não pago (novo/cancelado) NÃO conta =====
  const c5 = mkContact(orgA, chA, "C5", "5511000005555");
  const t5 = mkTicket(orgA, c5);
  mkOrder(orgA, t5, 999, "cancelado");
  mkOrder(orgA, t5, 999, "novo");
  const v5 = SalesRecoveryAttributionService.computeTicketValue(orgA, t5);
  check("orders não-pagos: NÃO contam", v5.value === 0 && v5.source === "zero");

  // ============================================================
  // B) attributeOne
  // ============================================================

  // ===== 6. Touch elegível + orders → atribui =====
  const c6 = mkContact(orgA, chA, "C6", "5511000006666");
  const t6 = mkTicket(orgA, c6);
  mkOrder(orgA, t6, 800, "pago");
  const touch6 = insertTouchRaw(orgA, { ticketId: t6, contactId: c6, phone: "5511000006666", channelId: chA, sentDaysAgo: 5, replyIntent: null });
  const { actionId: action6 } = setupAction(orgA, t6, c6);
  const won6 = logWonStage(orgA, t6, 0);
  const r6 = SalesRecoveryAttributionService.attributeOne({ orgId: orgA, event: { logId: won6.id, ticketId: t6, stageChangeAt: won6.stageChangeAt, changedBy: "u1" }, windowDays: 30 });
  check("attributeOne: attributed=true + source=orders + basis=fact", r6.attributed === true && r6.source === "orders" && r6.basis === "fact" && r6.ticketValue === 800);
  check("attributeOne: outcome F3.1 gravado com revenueRecovered", (() => {
    const outs = OutcomeMeasurementService.forAction(orgA, action6);
    return outs.some((o: any) => Number(o.revenue_recovered) === 800 && o.basis === "fact");
  })());
  check("attributeOne: linha em sales_recovery_attributions", listAttrs(orgA, t6).length === 1);
  void touch6;

  // ===== 7. Sem touch em janela → skip =====
  const c7 = mkContact(orgA, chA, "C7", "5511000007777");
  const t7 = mkTicket(orgA, c7);
  mkOrder(orgA, t7, 100, "pago");
  const won7 = logWonStage(orgA, t7, 0);
  const r7 = SalesRecoveryAttributionService.attributeOne({ orgId: orgA, event: { logId: won7.id, ticketId: t7, stageChangeAt: won7.stageChangeAt, changedBy: "u1" }, windowDays: 30 });
  check("attributeOne sem touch: skip com reason no_touch_in_window", r7.attributed === false && r7.reason === "no_touch_in_window");

  // ===== 8. Touch com reply_intent=remove_me → skip inelegível =====
  const c8 = mkContact(orgA, chA, "C8", "5511000008888");
  const t8 = mkTicket(orgA, c8);
  mkOrder(orgA, t8, 100, "pago");
  insertTouchRaw(orgA, { ticketId: t8, contactId: c8, phone: "5511000008888", channelId: chA, sentDaysAgo: 5, replyIntent: "remove_me" });
  const won8 = logWonStage(orgA, t8, 0);
  const r8 = SalesRecoveryAttributionService.attributeOne({ orgId: orgA, event: { logId: won8.id, ticketId: t8, stageChangeAt: won8.stageChangeAt, changedBy: "u1" }, windowDays: 30 });
  check("attributeOne remove_me: skip inelegível", r8.attributed === false && String(r8.reason).startsWith("ineligible_reply_intent"));

  // ===== 9. reply_intent=interested → atribui =====
  const c9 = mkContact(orgA, chA, "C9", "5511000009999");
  const t9 = mkTicket(orgA, c9);
  mkOrder(orgA, t9, 200, "pago");
  insertTouchRaw(orgA, { ticketId: t9, contactId: c9, phone: "5511000009999", channelId: chA, sentDaysAgo: 5, replyIntent: "interested" });
  setupAction(orgA, t9, c9);
  const won9 = logWonStage(orgA, t9, 0);
  const r9 = SalesRecoveryAttributionService.attributeOne({ orgId: orgA, event: { logId: won9.id, ticketId: t9, stageChangeAt: won9.stageChangeAt, changedBy: "u1" }, windowDays: 30 });
  check("attributeOne interested: attributed", r9.attributed === true && r9.ticketValue === 200);

  // ===== 10. reply_intent=meeting_request → atribui =====
  const c10 = mkContact(orgA, chA, "C10", "5511000010000");
  const t10 = mkTicket(orgA, c10);
  mkOrder(orgA, t10, 300, "pago");
  insertTouchRaw(orgA, { ticketId: t10, contactId: c10, phone: "5511000010000", channelId: chA, sentDaysAgo: 5, replyIntent: "meeting_request" });
  setupAction(orgA, t10, c10);
  const won10 = logWonStage(orgA, t10, 0);
  const r10 = SalesRecoveryAttributionService.attributeOne({ orgId: orgA, event: { logId: won10.id, ticketId: t10, stageChangeAt: won10.stageChangeAt, changedBy: "u1" }, windowDays: 30 });
  check("attributeOne meeting_request: attributed", r10.attributed === true);

  // ===== 11. reply_intent=null → atribui (cliente ganhou sem responder) =====
  // (já testado no 6 — reply_intent null)
  check("attributeOne reply_intent=null: já provado em teste 6", r6.attributed === true);

  // ===== 12. Ticket value=0 → skip =====
  const c12 = mkContact(orgA, chA, "C12", "5511000012222");
  const t12 = mkTicket(orgA, c12);
  // Sem orders, sem quote, sem avg → value 0.
  insertTouchRaw(orgA, { ticketId: t12, contactId: c12, phone: "5511000012222", channelId: chA, sentDaysAgo: 5 });
  const won12 = logWonStage(orgA, t12, 0);
  const r12 = SalesRecoveryAttributionService.attributeOne({ orgId: orgA, event: { logId: won12.id, ticketId: t12, stageChangeAt: won12.stageChangeAt, changedBy: "u1" }, windowDays: 30 });
  check("attributeOne value=0: skip com reason zero_value_no_source", r12.attributed === false && r12.reason === "zero_value_no_source");

  // ============================================================
  // C) runForOrg + Scheduler
  // ============================================================

  // ===== 13. runForOrg pega todos ganhos elegíveis =====
  const orgB = mkOrg({ attrOn: true });
  const chB = mkChannel(orgB);
  const cB = mkContact(orgB, chB, "B1", "5522111112222");
  const tB = mkTicket(orgB, cB);
  mkOrder(orgB, tB, 400, "pago");
  insertTouchRaw(orgB, { ticketId: tB, contactId: cB, phone: "5522111112222", channelId: chB, sentDaysAgo: 7 });
  setupAction(orgB, tB, cB);
  logWonStage(orgB, tB, 0);
  const rB = await SalesRecoveryAttributionService.runForOrg(orgB);
  check("runForOrg: 1 atribuição pra ganho 7d + touch em janela", rB.attributed === 1);

  // ===== 14. Rerodar → dedupe =====
  const rB2 = await SalesRecoveryAttributionService.runForOrg(orgB);
  check("runForOrg rerodar: 0 atribuições (dedupe UNIQUE)", rB2.attributed === 0);

  // ===== 15. Sem opt-in → tickAll pula =====
  const orgOff = mkOrg({ attrOn: false });
  const chOff = mkChannel(orgOff);
  const cOff = mkContact(orgOff, chOff, "Off", "5533111112222");
  const tOff = mkTicket(orgOff, cOff);
  mkOrder(orgOff, tOff, 500, "pago");
  insertTouchRaw(orgOff, { ticketId: tOff, contactId: cOff, phone: "5533111112222", channelId: chOff, sentDaysAgo: 5 });
  setupAction(orgOff, tOff, cOff);
  logWonStage(orgOff, tOff, 0);
  await SalesRecoveryAttributionService.tickAll();
  check("opt-in=off: nenhuma atribuição", listAttrs(orgOff, tOff).length === 0);

  // ===== 16. Ganho fora da janela → NÃO atribui =====
  const orgC = mkOrg({ attrOn: true, windowDays: 14 });
  const chC = mkChannel(orgC);
  const cC = mkContact(orgC, chC, "C", "5544111112222");
  const tC = mkTicket(orgC, cC);
  mkOrder(orgC, tC, 600, "pago");
  insertTouchRaw(orgC, { ticketId: tC, contactId: cC, phone: "5544111112222", channelId: chC, sentDaysAgo: 5 });
  setupAction(orgC, tC, cC);
  // Ganho 30d atrás, janela 14d → fora.
  logWonStage(orgC, tC, 30);
  const rC = await SalesRecoveryAttributionService.runForOrg(orgC, { windowDays: 14 });
  check("ganho 30d + janela 14 → NÃO atribui", rC.attributed === 0);

  // ===== 17. Isolamento cross-tenant =====
  const orgD = mkOrg({ attrOn: true });
  const rDIso = await SalesRecoveryAttributionService.runForOrg(orgD);
  check("isolamento: orgD sem tickets → 0 atribuições", rDIso.attributed === 0);

  // ===== 18. Reversão: ganho→open→ganho → 2 atribuições =====
  const orgE = mkOrg({ attrOn: true });
  const chE = mkChannel(orgE);
  const cE = mkContact(orgE, chE, "E", "5555111112222");
  const tE = mkTicket(orgE, cE);
  mkOrder(orgE, tE, 700, "pago");
  insertTouchRaw(orgE, { ticketId: tE, contactId: cE, phone: "5555111112222", channelId: chE, sentDaysAgo: 5 });
  setupAction(orgE, tE, cE);
  logWonStage(orgE, tE, 5);  // 1º ganho
  logWonStage(orgE, tE, 0);  // 2º ganho (reversão)
  const rE = await SalesRecoveryAttributionService.runForOrg(orgE);
  check("reversão: 2 stage_logs distintos → 2 atribuições", rE.attributed === 2 && listAttrs(orgE, tE).length === 2);

  // ===== 19. Audit registrado =====
  check("audit RUNTIME_SALES_RECOVERY_ATTRIBUTED registrado", auditCount(orgA, "RUNTIME_SALES_RECOVERY_ATTRIBUTED") >= 1);

  // ===== 20. Ledger F3.1 acumula revenueRecovered =====
  const ledgerA = OutcomeMeasurementService.ledger(orgA, {});
  check("ledger F3.1: revenueRecovered acumula (≥ 800 do teste 6)", Number(ledgerA.totals?.categories?.revenueRecovered || 0) >= 800);

  // ============================================================
  // D) Integração ponta-a-ponta
  // ============================================================
  const orgP = mkOrg({ attrOn: true });
  const chP = mkChannel(orgP);
  const cJoao = mkContact(orgP, chP, "João Deal", "5566111112222");
  const tJoao = mkTicket(orgP, cJoao, { updatedDaysAgo: 15 });
  SalesRecoveryPlaybookService.seed(orgP);
  const dealJoao = SalesStalledDealDetectorService.detect(orgP).find((d) => d.ticketId === tJoao)!;
  await SalesRecoveryPlaybookService.proposeForTicket(orgP, dealJoao, "u-test");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const proposedP = BusinessSignalService.list(orgP, { domain: "sales" }).find((s: any) => s.evidence?.ticketId === tJoao)!;
  await SalesRecoveryPlaybookService.approve(orgP, proposedP.id, { actorId: "u-owner" });
  // Cliente responde interested (F4c.2 registra reply_intent):
  db.prepare(`UPDATE sales_recovery_touches SET reply_intent = 'interested' WHERE ticket_id = ?`).run(tJoao);
  // 10d depois cliente ganha (via CRM):
  mkOrder(orgP, tJoao, 1200, "pago");
  logWonStage(orgP, tJoao, 0, "vendedor-a");
  // Scheduler pass:
  const rP = await SalesRecoveryAttributionService.runForOrg(orgP);
  check("E2E: attribution 1× após approve → touch interested → ganho", rP.attributed === 1);
  const attrP = listAttrs(orgP, tJoao)[0];
  check("E2E: ticket_value=1200 source=orders", Number(attrP?.ticket_value) === 1200 && attrP?.source === "orders");
  check("E2E: ledger revenueRecovered inclui 1200", Number(OutcomeMeasurementService.ledger(orgP, {}).totals?.categories?.revenueRecovered || 0) >= 1200);

  // ============================================================
  // Resultado
  // ============================================================
  console.log("\n=== ADR-152 Fatia 4c.4 (Atribuição de revenue_recovered real) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
