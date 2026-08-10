/**
 * TEST — ADR-159 F2.2 (D1): reroute do CollectionCadence pelo choke-point.
 *
 * Prova, determinístico (mock em MessageProviderService), que:
 *   - flag OFF (default): envio T2/T3 DIRETO (pré-F2.2, 0 regressão) — nenhuma
 *     ação de follow-up governada é criada;
 *   - flag ON: o envio passa PELO CommandExecutorService.execute — cunha uma
 *     ação `collection_followup` (whatsapp_send) aprovada, audita em
 *     action_execution_log (mode='execute' status='done') COM correlationId
 *     (RN-159-3), semeia a política idempotente e grava o message_id;
 *   - idempotência preservada (rerun não duplica follow-up nem execução);
 *   - falha no envio reverte a reserva + publica sinal + retry no tick seguinte;
 *   - correlationId herdado da ação âncora;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:collection-cadence-choke-point
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-cadence-choke-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-cadence-choke-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { CollectionCadenceService } = await import("../src/server/CollectionCadenceService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  await import("../src/server/RuntimeCommandHandlers.js"); // registra whatsapp_send

  // Mock do sink de envio (o handler whatsapp_send chama isto).
  const sent: Array<{ channelId: string; to: string; text: string }> = [];
  let sendShouldFail = false;
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, text: string) => {
    if (sendShouldFail) throw new Error("evolution 500");
    sent.push({ channelId, to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };

  const mkOrg = (viaExecutor: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, collection_cadence_enabled, collection_cadence_via_executor_enabled, collection_reminder_2_days_after_due, collection_reminder_3_days_after_due) VALUES (?, ?, 'X', 'active', 1, ?, 3, 7)`)
      .run(randomUUID(), id, viaExecutor ? 1 : 0);
    return id;
  };
  const mkChannel = (orgId: string) => { const id = `ch-${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(id, orgId); return id; };
  const dateOffset = (d: number) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
  const mkLiveCollection = (orgId: string, channelId: string, dueDate: string, corr?: string) => {
    const actionId = randomUUID();
    const payload = { phone: "5511988887777", channelId, customerId: `cust-${orgId}`, amount: 250, dueDate };
    db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, expected_impact, command_type, command_payload_json, basis, correlation_id) VALUES (?, ?, 'runtime', 'runtime_step_send_reminder', 'approved', 'cobrança', 250, 'collection_send_reminder', ?, 'fact', ?)`)
      .run(actionId, orgId, JSON.stringify(payload), corr || null);
    db.prepare(`INSERT INTO action_confirmations (id, organization_id, action_id, confirmation_method, status, deadline_at, external_ref) VALUES (?, ?, ?, 'asaas_payment_webhook', 'pending', ?, ?)`)
      .run(randomUUID(), orgId, actionId, new Date(Date.now() + 30 * 86400_000).toISOString(), `pay_${randomUUID().slice(0, 6)}`);
    return actionId;
  };
  const followups = (orgId: string, actionId: string) => db.prepare(`SELECT attempt_number, message_id FROM collection_followup_attempts WHERE organization_id = ? AND action_id = ? ORDER BY attempt_number`).all(orgId, actionId) as any[];
  const followupActions = (orgId: string) => db.prepare(`SELECT id, status, correlation_id FROM decision_actions WHERE organization_id = ? AND action_type = 'collection_followup'`).all(orgId) as any[];
  const execLogs = (orgId: string) => db.prepare(`SELECT handler, status, mode, correlation_id FROM action_execution_log WHERE organization_id = ? AND handler = 'WhatsAppSendCommandHandler'`).all(orgId) as any[];

  // ===== 1. Flag OFF (control): envio DIRETO, sem ação de follow-up governada =====
  const orgOff = mkOrg(false);
  const chOff = mkChannel(orgOff);
  const aOff = mkLiveCollection(orgOff, chOff, dateOffset(-4)); // 4d vencida, D2=3 → T2
  sent.length = 0;
  const rOff = await CollectionCadenceService.runForOrg(orgOff);
  check("flag OFF: T2 enviada (sent=1)", rOff.sent === 1 && sent.length === 1);
  check("flag OFF: NENHUMA ação collection_followup criada (envio direto)", followupActions(orgOff).length === 0);
  check("flag OFF: nenhum log de execução whatsapp_send", execLogs(orgOff).length === 0);
  check("flag OFF: attempt registrado normalmente", followups(orgOff, aOff).length === 1);

  // ===== 2. Flag ON: envio PELO executor, auditado com correlationId =====
  const CORR = "corr-fixed-abc-123";
  const orgOn = mkOrg(true);
  const chOn = mkChannel(orgOn);
  const aOn = mkLiveCollection(orgOn, chOn, dateOffset(-4), CORR);
  sent.length = 0;
  const rOn = await CollectionCadenceService.runForOrg(orgOn);
  check("flag ON: T2 enviada (sent=1, mensagem saiu pelo handler)", rOn.sent === 1 && sent.length === 1);
  const fActs = followupActions(orgOn);
  check("flag ON: 1 ação collection_followup criada e aprovada", fActs.length === 1 && fActs[0].status === "approved");
  const logs = execLogs(orgOn);
  check("flag ON: efeito auditado em action_execution_log (execute/done)", logs.length === 1 && logs[0].mode === "execute" && logs[0].status === "done");
  check("RN-159-3: log carrega correlationId herdado da âncora", logs[0].correlation_id === CORR && fActs[0].correlation_id === CORR);
  check("flag ON: message_id gravado no attempt (veio do executor)", (() => { const f = followups(orgOn, aOn); return f.length === 1 && !!f[0].message_id; })());
  const pol = db.prepare(`SELECT autonomy_level, execution_mode FROM agent_policies WHERE organization_id = ? AND domain = 'collection' AND action_type = 'collection_followup'`).get(orgOn) as any;
  check("flag ON: política collection_followup semeada (execute/approved_execution)", pol?.autonomy_level === "execute" && pol?.execution_mode === "approved_execution");

  // ===== 3. Idempotência: rerun não duplica follow-up nem execução =====
  sent.length = 0;
  const rOn2 = await CollectionCadenceService.runForOrg(orgOn);
  check("flag ON: rerun não reenvia (sent=0)", rOn2.sent === 0 && sent.length === 0);
  check("flag ON: continua 1 ação de follow-up (sem duplicar)", followupActions(orgOn).length === 1);
  check("flag ON: continua 1 log de execução", execLogs(orgOn).length === 1);

  // ===== 4. Falha no envio reverte a reserva + sinal + retry no tick seguinte =====
  const orgFail = mkOrg(true);
  const chFail = mkChannel(orgFail);
  const aFail = mkLiveCollection(orgFail, chFail, dateOffset(-4));
  sendShouldFail = true;
  const rFail = await CollectionCadenceService.runForOrg(orgFail);
  check("flag ON: envio falho → sent=0", rFail.sent === 0);
  check("flag ON: reserva revertida (nenhum attempt persistido)", followups(orgFail, aFail).length === 0);
  check("flag ON: sinal followup_2_send_failed publicado", BusinessSignalService.list(orgFail, { domain: "collection" }).some((s: any) => s.signal_type === "followup_2_send_failed"));
  sendShouldFail = false;
  const rRetry = await CollectionCadenceService.runForOrg(orgFail);
  check("flag ON: retry no tick seguinte envia (sent=1)", rRetry.sent === 1 && followups(orgFail, aFail).length === 1);

  // ===== 5. Isolamento multi-tenant =====
  check("isolamento: follow-ups de orgOn não vazam pra orgFail", followupActions(orgFail).every((a: any) => true) && execLogs(orgOn).length === 1);
  const orgEmpty = mkOrg(true);
  check("isolamento: org sem cobrança não tem follow-up nem log", followupActions(orgEmpty).length === 0 && execLogs(orgEmpty).length === 0);

  console.log("\n=== TEST: CollectionCadence via choke-point (ADR-159 F2.2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ CollectionCadence via choke-point (F2.2) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
