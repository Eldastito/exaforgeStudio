/**
 * TEST — ADR-152 Fatia 4c.2: reply router de recuperação comercial +
 * opt-out LGPD.
 *
 * 3 subsistemas em 1 fatia:
 *
 * A) SalesRecoveryReplyClassifier:
 *   1. Cada uma das 6 intents (interested, meeting_request, not_now,
 *      objection, remove_me, already_bought) mapeada corretamente.
 *   2. LLM devolve valor fora do enum → unknown.
 *   3. LLM devolve não-JSON → unknown.
 *   4. Sem OPENAI_API_KEY → unknown (sem chamar chat).
 *   5. LLM throw → unknown + rationale menciona erro.
 *
 * B) SalesRecoveryReplyService.tryHandle:
 *   6. Sem touch recente → {handled:false} (não engole).
 *   7. Touch recente + intent=interested → handled + sinal
 *      reply_interested severity=attention + reply canned + touch
 *      atualizado com reply_intent+reply_signal_id + audit.
 *   8. Touch recente + intent=meeting_request → severity=attention.
 *   9. Touch recente + intent=not_now → severity=info.
 *  10. Touch recente + intent=objection → severity=attention.
 *  11. Touch recente + intent=remove_me → severity=risk + SETA
 *      contacts.marketing_opt_out=1 + audit RUNTIME_SALES_RECOVERY_
 *      OPT_OUT + reply canned menciona "não te mando mais".
 *  12. Touch recente + intent=already_bought → severity=info.
 *  13. Touch recente + intent=unknown → severity=info + dedupe por hash.
 *  14. Janela expira: touch de 20d atrás com janela=14d → {handled:false}.
 *  15. Janela configurável por-org via `sales_recovery_reply_window_days`.
 *  16. Idempotência: 2 replies do mesmo intent no mesmo touch → sinal
 *      dedupado (mesmo id).
 *  17. Correlação por PHONE quando contactId diferente.
 *  18. Correlação: touch MAIS RECENTE quando contato tem múltiplos.
 *  19. Isolamento cross-tenant: touch da orgA + reply na orgB → {handled:false}.
 *
 * C) Integração ponta-a-ponta com F4c MVP (LGPD):
 *  20. SalesRecoveryPlaybookService.approve REGISTRA touch em
 *      sales_recovery_touches após envio bem-sucedido.
 *  21. Após intent=remove_me, próxima varredura do detector NÃO retorna
 *      esse contato (marketing_opt_out=1).
 *  22. SalesRecoveryPlaybookService.approve REJEITA envio se o contato
 *      já optou por opt-out (LGPD Art.8 §5) + audit RUNTIME_SALES_
 *      RECOVERY_BLOCKED_OPT_OUT.
 *  23. Touch sem envio bem-sucedido (falha WA) NÃO é registrado.
 *  24. `recordTouch` sem params obrigatórios throw.
 *
 * Uso: npm run test:sales-recovery-reply
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sales-reply-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sales-reply-1234567890";
process.env.OPENAI_API_KEY = "sk-fake-test-key";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { classify, __setSalesReplyChatForTests, SALES_REPLY_INTENT_LABELS } = await import("../src/server/SalesRecoveryReplyClassifier.js");
  const { SalesRecoveryReplyService } = await import("../src/server/SalesRecoveryReplyService.js");
  const { SalesRecoveryPlaybookService } = await import("../src/server/SalesRecoveryPlaybook.js");
  const { SalesStalledDealDetectorService } = await import("../src/server/SalesStalledDealDetectorService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { __setGeneratorChatForTests } = await import("../src/server/SalesRecoveryMessageGenerator.js");

  // ── Mocks ─────────────────────────────────────────────────────────────
  const sentMessages: Array<{ channelId: string; to: string; text: string }> = [];
  let sendShouldFail = false;
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    if (sendShouldFail) throw new Error("evolution 500");
    sentMessages.push({ channelId, to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };
  let nextChatResponse: string = '{"intent":"unknown","reason":"default"}';
  let chatShouldThrow = false;
  __setSalesReplyChatForTests(async () => {
    if (chatShouldThrow) throw new Error("openai timeout");
    return nextChatResponse;
  });
  // Generator LLM mock (não é foco, mas approve() usa quando propõe)
  __setGeneratorChatForTests(async () => '{"text":"Oi mock recovery 👋"}');

  // ── Helpers ────────────────────────────────────────────────────────────
  const mkOrg = (opts: { salesOn?: boolean; windowDays?: number } = {}) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled, sales_recovery_enabled, sales_recovery_stalled_days, sales_recovery_reply_window_days) VALUES (?, ?, 'X', 'active', 1, ?, 10, ?)`)
      .run(randomUUID(), id, opts.salesOn ? 1 : 0, opts.windowDays ?? 14);
    // Policies pro F4c handler
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'runtime_step_propose', 'execute', 'approved_execution', 1)`).run(randomUUID(), id);
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, 'runtime', 'sales_recovery_propose_message', 'execute', 'approved_execution', 1)`).run(randomUUID(), id);
    return id;
  };
  const mkChannel = (orgId: string) => {
    const id = `ch-${orgId}-${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(id, orgId);
    return id;
  };
  const mkContact = (orgId: string, channelId: string, name: string, phone: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, channelId, name, phone);
    return id;
  };
  const mkTicket = (orgId: string, contactId: string, opts: { updatedDaysAgo?: number; stage?: string } = {}) => {
    const id = randomUUID();
    const updatedIso = new Date(Date.now() - (opts.updatedDaysAgo ?? 15) * 86400_000).toISOString();
    db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage, updated_at) VALUES (?, ?, ?, 'open', ?, ?)`)
      .run(id, orgId, contactId, opts.stage || "proposta", updatedIso);
    return id;
  };
  const insertTouchRaw = (orgId: string, opts: { ticketId: string; contactId: string; phone: string; channelId: string; sentDaysAgo?: number; proposedSignalId?: string | null; }) => {
    const id = randomUUID();
    const sentIso = new Date(Date.now() - (opts.sentDaysAgo ?? 0) * 86400_000).toISOString();
    db.prepare(`INSERT INTO sales_recovery_touches (id, organization_id, ticket_id, contact_id, phone, channel_id, proposed_signal_id, sent_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, opts.ticketId, opts.contactId, opts.phone, opts.channelId, opts.proposedSignalId || null, sentIso);
    return id;
  };
  const auditCount = (orgId: string, eventType: string) => (db.prepare(`SELECT COUNT(*) as n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgId, eventType) as any).n;

  // ============================================================
  // A) Classifier
  // ============================================================
  const KNOWN = SALES_REPLY_INTENT_LABELS.filter((i) => i !== "unknown");
  for (const label of KNOWN) {
    nextChatResponse = JSON.stringify({ intent: label, reason: `test ${label}` });
    const r = await classify(`teste ${label}`);
    check(`classify(${label}): retorna ${label}`, r.intent === label && r.confidence > 0);
  }
  nextChatResponse = '{"intent":"fantasia","reason":"foi"}';
  const rFake = await classify("qualquer");
  check("intent fora do enum → unknown", rFake.intent === "unknown");
  nextChatResponse = "não é json";
  check("não-JSON → unknown", (await classify("x")).intent === "unknown");
  const savedKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const rNoKey = await classify("qualquer");
  check("sem OPENAI → unknown", rNoKey.intent === "unknown" && rNoKey.rationale.includes("LLM indisponível"));
  process.env.OPENAI_API_KEY = savedKey;
  chatShouldThrow = true;
  const rThrow = await classify("qualquer");
  check("throw → unknown + rationale menciona erro", rThrow.intent === "unknown" && rThrow.rationale.startsWith("LLM erro"));
  chatShouldThrow = false;

  // ============================================================
  // B) tryHandle
  // ============================================================
  const orgA = mkOrg({ salesOn: true });
  const chA = mkChannel(orgA);
  const contactA = mkContact(orgA, chA, "Ana", "5511999998888");
  const ticketA = mkTicket(orgA, contactA);

  // ===== 6. Sem touch recente → not_handled =====
  nextChatResponse = '{"intent":"interested","reason":"ok"}';
  const rNoTouch = await SalesRecoveryReplyService.tryHandle(orgA, contactA, "5511999998888", "sim vamos");
  check("sem touch → handled=false", rNoTouch.handled === false);

  // ===== 7. Touch + intent=interested → handled + sinal + touch atualizado =====
  const touch7 = insertTouchRaw(orgA, { ticketId: ticketA, contactId: contactA, phone: "5511999998888", channelId: chA, sentDaysAgo: 2 });
  nextChatResponse = '{"intent":"interested","reason":"quer conversar"}';
  const rInt = await SalesRecoveryReplyService.tryHandle(orgA, contactA, "5511999998888", "Sim! Manda os detalhes");
  check("interested: handled + intent=interested", rInt.handled === true && rInt.intent === "interested");
  check("interested: reply canned menciona 'próximos passos' ou 'time'", !!rInt.reply && /próximos passos|time|avisar/i.test(rInt.reply));
  const sig7 = BusinessSignalService.list(orgA, { domain: "sales" }).find((s: any) => s.signal_type === "reply_interested");
  check("interested: sinal reply_interested severity=attention", !!sig7 && sig7.severity === "attention");
  const touch7After = db.prepare(`SELECT reply_intent, reply_signal_id, reply_received_at FROM sales_recovery_touches WHERE id = ?`).get(touch7) as any;
  check("interested: touch atualizado com reply_intent + reply_signal_id", touch7After.reply_intent === "interested" && !!touch7After.reply_signal_id && !!touch7After.reply_received_at);

  // ===== 8. meeting_request → severity=attention =====
  const contact8 = mkContact(orgA, chA, "Bruno", "5511977776666");
  const ticket8 = mkTicket(orgA, contact8);
  insertTouchRaw(orgA, { ticketId: ticket8, contactId: contact8, phone: "5511977776666", channelId: chA });
  nextChatResponse = '{"intent":"meeting_request","reason":"pede reunião"}';
  await SalesRecoveryReplyService.tryHandle(orgA, contact8, "5511977776666", "podemos marcar uma call?");
  const sig8 = BusinessSignalService.list(orgA, { domain: "sales" }).find((s: any) => s.signal_type === "reply_meeting_request");
  check("meeting_request: sinal severity=attention", !!sig8 && sig8.severity === "attention");

  // ===== 9. not_now → severity=info =====
  const contact9 = mkContact(orgA, chA, "Carlos", "5511966665555");
  const ticket9 = mkTicket(orgA, contact9);
  insertTouchRaw(orgA, { ticketId: ticket9, contactId: contact9, phone: "5511966665555", channelId: chA });
  nextChatResponse = '{"intent":"not_now","reason":"adiou"}';
  await SalesRecoveryReplyService.tryHandle(orgA, contact9, "5511966665555", "agora não é hora");
  const sig9 = BusinessSignalService.list(orgA, { domain: "sales" }).find((s: any) => s.signal_type === "reply_not_now");
  check("not_now: severity=info", !!sig9 && sig9.severity === "info");

  // ===== 10. objection → attention =====
  const contact10 = mkContact(orgA, chA, "Diana", "5511955554444");
  const ticket10 = mkTicket(orgA, contact10);
  insertTouchRaw(orgA, { ticketId: ticket10, contactId: contact10, phone: "5511955554444", channelId: chA });
  nextChatResponse = '{"intent":"objection","reason":"preço"}';
  await SalesRecoveryReplyService.tryHandle(orgA, contact10, "5511955554444", "muito caro");
  const sig10 = BusinessSignalService.list(orgA, { domain: "sales" }).find((s: any) => s.signal_type === "reply_objection");
  check("objection: severity=attention", !!sig10 && sig10.severity === "attention");

  // ===== 11. remove_me → severity=risk + opt-out flag setada + audit =====
  const contactOpt = mkContact(orgA, chA, "Erica", "5511944443333");
  const ticketOpt = mkTicket(orgA, contactOpt);
  insertTouchRaw(orgA, { ticketId: ticketOpt, contactId: contactOpt, phone: "5511944443333", channelId: chA });
  nextChatResponse = '{"intent":"remove_me","reason":"opt-out"}';
  const rOpt = await SalesRecoveryReplyService.tryHandle(orgA, contactOpt, "5511944443333", "para de me mandar mensagem");
  check("remove_me: handled + optedOut=true", rOpt.handled === true && rOpt.intent === "remove_me" && rOpt.optedOut === true);
  const contactRow = db.prepare(`SELECT marketing_opt_out FROM contacts WHERE id = ?`).get(contactOpt) as any;
  check("remove_me: contacts.marketing_opt_out=1 setado atomicamente", Number(contactRow.marketing_opt_out) === 1);
  const sigOpt = BusinessSignalService.list(orgA, { domain: "sales" }).find((s: any) => s.signal_type === "reply_remove_me");
  check("remove_me: sinal severity=risk (LGPD é evento noticiável)", !!sigOpt && sigOpt.severity === "risk");
  check("remove_me: reply canned menciona 'não te mando mais'", !!rOpt.reply && /não te mando mais|obrigado/i.test(rOpt.reply));
  check("audit RUNTIME_SALES_RECOVERY_OPT_OUT registrado", auditCount(orgA, "RUNTIME_SALES_RECOVERY_OPT_OUT") >= 1);
  check("audit RUNTIME_SALES_RECOVERY_REPLY_INTERPRETED registrado", auditCount(orgA, "RUNTIME_SALES_RECOVERY_REPLY_INTERPRETED") >= 5);

  // ===== 12. already_bought → severity=info =====
  const contact12 = mkContact(orgA, chA, "Fernando", "5511933332222");
  const ticket12 = mkTicket(orgA, contact12);
  insertTouchRaw(orgA, { ticketId: ticket12, contactId: contact12, phone: "5511933332222", channelId: chA });
  nextChatResponse = '{"intent":"already_bought","reason":"fechou com concorrente"}';
  await SalesRecoveryReplyService.tryHandle(orgA, contact12, "5511933332222", "já comprei em outro lugar");
  const sig12 = BusinessSignalService.list(orgA, { domain: "sales" }).find((s: any) => s.signal_type === "reply_already_bought");
  check("already_bought: severity=info", !!sig12 && sig12.severity === "info");

  // ===== 13. unknown → severity=info + dedupe por hash =====
  const contact13 = mkContact(orgA, chA, "Gabi", "5511922221111");
  const ticket13 = mkTicket(orgA, contact13);
  insertTouchRaw(orgA, { ticketId: ticket13, contactId: contact13, phone: "5511922221111", channelId: chA });
  nextChatResponse = '{"intent":"algo_estranho","reason":"nada"}';
  await SalesRecoveryReplyService.tryHandle(orgA, contact13, "5511922221111", "aaa bbb");
  nextChatResponse = '{"intent":"tambem_estranho","reason":"nada"}';
  await SalesRecoveryReplyService.tryHandle(orgA, contact13, "5511922221111", "ccc ddd");
  const unkSigs = BusinessSignalService.list(orgA, { domain: "sales" }).filter((s: any) => s.signal_type === "reply_unknown");
  check("unknown: 2 msgs distintas → 2 sinais distintos (hash tiebreaker)", unkSigs.length >= 2);
  check("unknown: severity=info em todas", unkSigs.every((s: any) => s.severity === "info"));

  // ===== 14. Janela expira: touch 20d atrás com janela=14d → not_handled =====
  const contactOld = mkContact(orgA, chA, "Hugo", "5511911110000");
  const ticketOld = mkTicket(orgA, contactOld);
  insertTouchRaw(orgA, { ticketId: ticketOld, contactId: contactOld, phone: "5511911110000", channelId: chA, sentDaysAgo: 20 });
  nextChatResponse = '{"intent":"interested","reason":"ok"}';
  const rOld = await SalesRecoveryReplyService.tryHandle(orgA, contactOld, "5511911110000", "sim");
  check("janela expira: touch 20d + janela 14d → handled=false", rOld.handled === false);

  // ===== 15. Janela configurável (30 dias) =====
  const orgWide = mkOrg({ salesOn: true, windowDays: 30 });
  const chW = mkChannel(orgWide);
  const cW = mkContact(orgWide, chW, "Ivo", "5522111112222");
  const tW = mkTicket(orgWide, cW);
  insertTouchRaw(orgWide, { ticketId: tW, contactId: cW, phone: "5522111112222", channelId: chW, sentDaysAgo: 20 });
  nextChatResponse = '{"intent":"interested","reason":"ok"}';
  const rWide = await SalesRecoveryReplyService.tryHandle(orgWide, cW, "5522111112222", "sim");
  check("janela 30d: touch 20d ainda pega", rWide.handled === true);

  // ===== 16. Idempotência de sinal =====
  const before16 = BusinessSignalService.list(orgA, { domain: "sales" }).filter((s: any) => s.signal_type === "reply_meeting_request").length;
  nextChatResponse = '{"intent":"meeting_request","reason":"2ª"}';
  const r16 = await SalesRecoveryReplyService.tryHandle(orgA, contact8, "5511977776666", "podemos falar hoje?");
  const after16 = BusinessSignalService.list(orgA, { domain: "sales" }).filter((s: any) => s.signal_type === "reply_meeting_request").length;
  check("idempotência: 2ª reply meeting_request no mesmo touch → dedupada", after16 === before16 && r16.handled === true);

  // ===== 17. Correlação por PHONE =====
  const contactRenewed = mkContact(orgA, chA, "Novo", "5544333334444");
  const ticketRenewed = mkTicket(orgA, contactRenewed);
  // Insert touch com contactId "antigo" mas phone atual:
  insertTouchRaw(orgA, { ticketId: ticketRenewed, contactId: "contact-antigo-nao-existe", phone: "5544333334444", channelId: chA });
  nextChatResponse = '{"intent":"interested","reason":"ok"}';
  const rByPhone = await SalesRecoveryReplyService.tryHandle(orgA, contactRenewed, "5544333334444", "quero saber mais");
  check("correlação por phone: acha touch mesmo com contactId diferente", rByPhone.handled === true);

  // ===== 18. Touch MAIS RECENTE quando contato tem múltiplos =====
  const contactMulti = mkContact(orgA, chA, "Mult", "5555000111222");
  const t18a = mkTicket(orgA, contactMulti);
  const t18b = mkTicket(orgA, contactMulti);
  insertTouchRaw(orgA, { ticketId: t18a, contactId: contactMulti, phone: "5555000111222", channelId: chA, sentDaysAgo: 5 });
  const t18BMoreRecent = insertTouchRaw(orgA, { ticketId: t18b, contactId: contactMulti, phone: "5555000111222", channelId: chA, sentDaysAgo: 1 });
  nextChatResponse = '{"intent":"interested","reason":"ok"}';
  const rMulti = await SalesRecoveryReplyService.tryHandle(orgA, contactMulti, "5555000111222", "sim");
  check("correlação: touch MAIS RECENTE (t18b) é o casado", rMulti.handled === true && rMulti.ticketId === t18b);
  const touchB = db.prepare(`SELECT reply_intent FROM sales_recovery_touches WHERE id = ?`).get(t18BMoreRecent) as any;
  check("correlação: touch mais recente foi atualizado (não o antigo)", touchB.reply_intent === "interested");

  // ===== 19. Isolamento cross-tenant =====
  const orgB = mkOrg({ salesOn: true });
  const chB = mkChannel(orgB);
  const contactB = mkContact(orgB, chB, "OrgB", "5511999998888"); // mesmo phone que orgA (permitido cross-tenant)
  nextChatResponse = '{"intent":"interested","reason":"ok"}';
  const rCross = await SalesRecoveryReplyService.tryHandle(orgB, contactB, "5511999998888", "sim");
  check("isolamento: touch da orgA + reply na orgB → handled=false", rCross.handled === false);

  // ============================================================
  // C) Integração ponta-a-ponta F4c + F4c.2
  // ============================================================

  // ===== 20. approve() registra touch =====
  const orgC = mkOrg({ salesOn: true });
  const chC = mkChannel(orgC);
  const cAna = mkContact(orgC, chC, "Ana", "5599777776666");
  const tAna = mkTicket(orgC, cAna, { updatedDaysAgo: 15 });
  SalesRecoveryPlaybookService.seed(orgC);
  const dealAna = SalesStalledDealDetectorService.detect(orgC).find((d) => d.ticketId === tAna)!;
  await SalesRecoveryPlaybookService.proposeForTicket(orgC, dealAna, "u-test");
  const proposedSig20 = BusinessSignalService.list(orgC, { domain: "sales" }).find((s: any) => s.signal_type === "sales_recovery_proposed" && s.evidence?.ticketId === tAna)!;
  sentMessages.length = 0;
  const rApprove20 = await SalesRecoveryPlaybookService.approve(orgC, proposedSig20.id, { actorId: "u-owner" });
  check("approve: sent=true", rApprove20.sent === true);
  const touchesAna = db.prepare(`SELECT id, message_id, approved_by FROM sales_recovery_touches WHERE organization_id = ? AND contact_id = ?`).all(orgC, cAna) as any[];
  check("approve registra touch (message_id + approved_by)", touchesAna.length === 1 && !!touchesAna[0].message_id && touchesAna[0].approved_by === "u-owner");

  // ===== 21. Após remove_me, próxima varredura NÃO retorna o contato =====
  // Cliente responde remove_me → opt-out setado
  nextChatResponse = '{"intent":"remove_me","reason":"opt-out"}';
  const rOpt21 = await SalesRecoveryReplyService.tryHandle(orgC, cAna, "5599777776666", "para de me mandar");
  check("opt-out via remove_me: aplicado", rOpt21.optedOut === true);
  // Simula: passa mais tempo, ticket volta a ficar parado
  db.prepare(`UPDATE tickets SET updated_at = ? WHERE id = ?`).run(new Date(Date.now() - 20 * 86400_000).toISOString(), tAna);
  const dealsAfter = SalesStalledDealDetectorService.detect(orgC);
  check("detector: contato opt-out NÃO aparece", !dealsAfter.some((d) => d.contactId === cAna));

  // ===== 22. approve() rejeita se contato já optou por opt-out =====
  // Cria proposta ANTES do opt-out, depois marca opt-out, depois tenta
  // aprovar. Bem realista: proposta ficou na fila e cliente pediu
  // opt-out por outro canal antes do dono clicar aprovar.
  const cOptOut = mkContact(orgC, chC, "OptedOut", "5599123123123");
  const tOptOut = mkTicket(orgC, cOptOut, { updatedDaysAgo: 15 });
  const dealOpt = SalesStalledDealDetectorService.detect(orgC).find((d) => d.ticketId === tOptOut)!;
  await SalesRecoveryPlaybookService.proposeForTicket(orgC, dealOpt, "u-test");
  const proposedSigOpt = BusinessSignalService.list(orgC, { domain: "sales" }).find((s: any) => s.status === "open" && s.evidence?.ticketId === tOptOut)!;
  // Agora marca opt-out MANUALMENTE (simulando cliente pediu por outro
  // canal ou dono decidiu proteger o contato).
  db.prepare(`UPDATE contacts SET marketing_opt_out = 1 WHERE id = ?`).run(cOptOut);
  let threwOpt = false;
  try { await SalesRecoveryPlaybookService.approve(orgC, proposedSigOpt.id, { actorId: "u-owner" }); }
  catch (e: any) { threwOpt = /opt-out|LGPD/i.test(e?.message || ""); }
  check("approve rejeita se contato opt-out (LGPD Art.8 §5)", threwOpt);
  check("audit RUNTIME_SALES_RECOVERY_BLOCKED_OPT_OUT registrado", auditCount(orgC, "RUNTIME_SALES_RECOVERY_BLOCKED_OPT_OUT") >= 1);
  const sigOptAfter = db.prepare(`SELECT status FROM business_signals WHERE id = ?`).get(proposedSigOpt.id) as any;
  check("approve rejeita: sinal descartado automaticamente (resolved)", sigOptAfter.status === "resolved");

  // ===== 23. Touch NÃO é registrado se envio WA falha =====
  const cFail = mkContact(orgC, chC, "FailWA", "5599555554444");
  const tFail = mkTicket(orgC, cFail, { updatedDaysAgo: 15 });
  const dealFail = SalesStalledDealDetectorService.detect(orgC).find((d) => d.ticketId === tFail)!;
  await SalesRecoveryPlaybookService.proposeForTicket(orgC, dealFail, "u-test");
  const proposedFail = BusinessSignalService.list(orgC, { domain: "sales" }).find((s: any) => s.status === "open" && s.evidence?.ticketId === tFail)!;
  sendShouldFail = true;
  const rFail23 = await SalesRecoveryPlaybookService.approve(orgC, proposedFail.id, { actorId: "u-owner" });
  sendShouldFail = false;
  check("approve WA falha: sent=false", rFail23.sent === false);
  const touchesFail = db.prepare(`SELECT COUNT(*) AS n FROM sales_recovery_touches WHERE organization_id = ? AND contact_id = ?`).get(orgC, cFail) as any;
  check("WA falha: touch NÃO registrado", touchesFail.n === 0);

  // ===== 24. recordTouch sem params obrigatórios → throw =====
  let threwRecord = false;
  try { SalesRecoveryReplyService.recordTouch(orgA, { ticketId: "", contactId: contactA, phone: "5511999998888", channelId: chA }); }
  catch { threwRecord = true; }
  check("recordTouch sem ticketId → throw", threwRecord);

  // ============================================================
  // Resultado
  // ============================================================
  console.log("\n=== ADR-152 Fatia 4c.2 (Reply Router de Recuperação Comercial + opt-out LGPD) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks OK`);
  if (failures > 0) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
