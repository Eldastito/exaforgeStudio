/**
 * TEST — ADR-159 F2.3 (D1): reroute da FAMÍLIA COBRANÇA pelo choke-point.
 *
 * Estende a F2.2 (cadência) aos outros dois bypasses de dunning, sob a MESMA
 * flag `collection_cadence_via_executor_enabled`:
 *   - CollectionPromiseService.markBroken (follow-up de promessa quebrada);
 *   - CollectionResendPixService.sendNow (reenvio de PIX ao cliente).
 * Ambos passam a cunhar uma ação governada (whatsapp_send) via a costura
 * compartilhada `CommandExecutorService.sendGovernedMessage`, auditada em
 * action_execution_log com correlationId (RN-159-3). Flag OFF = envio direto
 * (0 regressão). Preserva idempotência/rollback/sinais de cada fluxo.
 *
 * Uso: npm run test:collection-family-choke-point
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-coll-family-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-coll-family-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CollectionPromiseService } = await import("../src/server/CollectionPromiseService.js");
  const { CollectionResendPixService } = await import("../src/server/CollectionResendPixService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { AsaasService } = await import("../src/server/AsaasService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  await import("../src/server/RuntimeCommandHandlers.js"); // registra whatsapp_send

  const sent: Array<{ to: string; text: string }> = [];
  let sendShouldFail = false;
  (MessageProviderService as any).sendMessage = async (_ch: string, to: string, text: string) => {
    if (sendShouldFail) throw new Error("evolution 500");
    sent.push({ to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };
  (AsaasService as any).getPayment = async (id: string) => ({ id, invoiceUrl: "https://asaas.com/i/" + id, value: 250, dueDate: "2026-08-01", status: "PENDING" });

  const mkOrg = (viaExecutor: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, collection_cadence_enabled, collection_cadence_via_executor_enabled, collection_promise_grace_days) VALUES (?, ?, 'X', 'active', 1, ?, 0)`)
      .run(randomUUID(), id, viaExecutor ? 1 : 0);
    return id;
  };
  const mkChannel = (orgId: string) => { const id = `ch-${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(id, orgId); return id; };
  const dateOffset = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
  const mkAnchor = (orgId: string, channelId: string, corr: string) => {
    const actionId = randomUUID();
    const payload = { phone: "5511988887777", channelId, customerId: `cust-${orgId}`, amount: 250, dueDate: dateOffset(-5) };
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, expected_impact, command_type, command_payload_json, basis, correlation_id) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'approved', 'cobrança', 250, 'collection_send_reminder', ?, 'fact', ?)`)
      .run(actionId, orgId, JSON.stringify(payload), corr);
    db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, external_ref) VALUES (?, ?, ?, 'asaas_payment_webhook', 'pending', ?)`)
      .run(randomUUID(), orgId, actionId, `pay_${randomUUID().slice(0, 6)}`);
    return actionId;
  };
  const mkPromise = (orgId: string, actionId: string, channelId: string, receivableId: string | null) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO collection_payment_promises (id, organization_id, action_id, receivable_id, contact_id, phone, channel_id, amount, due_date, promised_date, status, source) VALUES (?, ?, ?, ?, null, '5511988887777', ?, 250, ?, ?, 'pending', 'test')`)
      .run(id, orgId, actionId, receivableId, channelId, dateOffset(-5), dateOffset(-1));
    return id;
  };
  const governed = (orgId: string, actionType: string) => db.prepare(`SELECT status, correlation_id FROM decision_actions WHERE organization_id = ? AND action_type = ?`).all(orgId, actionType) as any[];
  const execLogs = (orgId: string) => db.prepare(`SELECT status, mode, correlation_id FROM action_execution_log WHERE organization_id = ? AND handler = 'WhatsAppSendCommandHandler'`).all(orgId) as any[];
  const promiseStatus = (orgId: string, id: string) => (db.prepare(`SELECT status FROM collection_payment_promises WHERE id = ? AND organization_id = ?`).get(id, orgId) as any)?.status;

  // ════════════ A) CollectionPromiseService.markBroken ════════════
  const CORR_P = "corr-promise-1";
  // A1. Flag ON → envio via executor, auditado com correlationId.
  const pOn = mkOrg(true);
  const chP = mkChannel(pOn);
  const aP = mkAnchor(pOn, chP, CORR_P);
  const prom = mkPromise(pOn, aP, chP, null);
  sent.length = 0;
  const rP = await CollectionPromiseService.runForOrg(pOn, { graceDays: 0 });
  check("promise ON: promessa quebrada (broken=1) + msg enviada", rP.broken === 1 && sent.length === 1);
  check("promise ON: ação collection_promise_followup criada e aprovada", (() => { const g = governed(pOn, "collection_promise_followup"); return g.length === 1 && g[0].status === "approved"; })());
  check("promise ON: efeito auditado (execute/done) com correlationId herdado", (() => { const l = execLogs(pOn); return l.length === 1 && l[0].mode === "execute" && l[0].status === "done" && l[0].correlation_id === CORR_P; })());
  check("promise ON: promessa marcada broken", promiseStatus(pOn, prom) === "broken");

  // A2. Flag OFF → envio direto, sem ação governada.
  const pOff = mkOrg(false);
  const chPo = mkChannel(pOff);
  const aPo = mkAnchor(pOff, chPo, "corr-x");
  const promo = mkPromise(pOff, aPo, chPo, null);
  sent.length = 0;
  const rPo = await CollectionPromiseService.runForOrg(pOff, { graceDays: 0 });
  check("promise OFF: quebrada + msg direta (broken=1)", rPo.broken === 1 && sent.length === 1);
  check("promise OFF: NENHUMA ação governada / log de execução", governed(pOff, "collection_promise_followup").length === 0 && execLogs(pOff).length === 0);

  // A3. Flag ON + falha no envio → promessa segue pending (retry) + sinal.
  const pFail = mkOrg(true);
  const chPf = mkChannel(pFail);
  const aPf = mkAnchor(pFail, chPf, "corr-f");
  const promf = mkPromise(pFail, aPf, chPf, null);
  sendShouldFail = true;
  const rPf = await CollectionPromiseService.runForOrg(pFail, { graceDays: 0 });
  sendShouldFail = false;
  check("promise ON falha: broken=0, promessa segue pending (retry)", rPf.broken === 0 && promiseStatus(pFail, promf) === "pending");
  check("promise ON falha: sinal promise_followup_send_failed publicado", BusinessSignalService.list(pFail, { domain: "collection" }).some((s: any) => s.signal_type === "promise_followup_send_failed"));

  // ════════════ B) CollectionResendPixService.sendNow ════════════
  const CORR_R = "corr-resend-1";
  // B1. Flag ON → reenvio via executor, auditado com correlationId.
  const rOn = mkOrg(true);
  const chR = mkChannel(rOn);
  const aR = mkAnchor(rOn, chR, CORR_R);
  sent.length = 0;
  const resB1 = await CollectionResendPixService.sendNow(rOn, { actionId: aR, paymentId: "pay_zzz", channelId: chR, phone: "5511988887777", amount: 250, dueDate: dateOffset(-1) });
  check("resend ON: sent=true + messageId", resB1.sent === true && !!resB1.messageId);
  check("resend ON: ação collection_resend_pix criada e aprovada", (() => { const g = governed(rOn, "collection_resend_pix"); return g.length === 1 && g[0].status === "approved"; })());
  check("resend ON: efeito auditado (execute/done) com correlationId herdado", (() => { const l = execLogs(rOn); return l.length === 1 && l[0].status === "done" && l[0].correlation_id === CORR_R; })());
  check("resend ON: mensagem contém a URL do PIX", sent.length === 1 && /asaas\.com\/i\/pay_zzz/.test(sent[0].text));

  // B2. Flag OFF → reenvio direto, sem ação governada.
  const rOff = mkOrg(false);
  const chRo = mkChannel(rOff);
  const aRo = mkAnchor(rOff, chRo, "corr-y");
  sent.length = 0;
  const resB2 = await CollectionResendPixService.sendNow(rOff, { actionId: aRo, paymentId: "pay_off", channelId: chRo, phone: "5511988887777", amount: 250, dueDate: dateOffset(-1) });
  check("resend OFF: sent=true direto, sem ação governada", resB2.sent === true && governed(rOff, "collection_resend_pix").length === 0 && execLogs(rOff).length === 0);

  // B3. Flag ON + falha → sendNow NÃO lança, retorna sent=false + sinal.
  const rFail = mkOrg(true);
  const chRf = mkChannel(rFail);
  const aRf = mkAnchor(rFail, chRf, "corr-rf");
  sendShouldFail = true;
  const resB3 = await CollectionResendPixService.sendNow(rFail, { actionId: aRf, paymentId: "pay_fail", channelId: chRf, phone: "5511988887777", amount: 250, dueDate: dateOffset(-1) });
  sendShouldFail = false;
  check("resend ON falha: sent=false + error (nunca lança)", resB3.sent === false && resB3.error === "sendMessage_error");
  check("resend ON falha: sinal resend_pix_failed publicado", BusinessSignalService.list(rFail, { domain: "collection" }).some((s: any) => s.signal_type === "resend_pix_failed"));

  // ════════════ C) Isolamento ════════════
  check("isolamento: logs de execução não vazam entre orgs", execLogs(pOn).length === 1 && execLogs(rOn).length === 1);

  console.log("\n=== TEST: Família cobrança via choke-point (ADR-159 F2.3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Família cobrança via choke-point (F2.3) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
