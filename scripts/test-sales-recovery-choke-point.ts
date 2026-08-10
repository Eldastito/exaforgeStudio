/**
 * TEST — ADR-159 F2.4 (D1): reroute do SalesRecoveryPlaybook.approve pelo choke-point.
 *
 * O envio da mensagem de recuperação comercial (hoje MessageProviderService.
 * sendMessage direto) passa PELO CommandExecutorService.sendGovernedMessage sob
 * a flag `sales_recovery_via_executor_enabled` — ação governada whatsapp_send
 * auditada com correlationId herdado da âncora. Flag OFF = envio direto (0
 * regressão). Os guards (opt-out LGPD, ticket-state) e side-effects
 * (touch/resolve/audit) ficam INTACTOS — só o sink muda.
 *
 * Uso: npm run test:sales-recovery-choke-point
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sales-choke-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sales-choke-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SalesRecoveryPlaybookService } = await import("../src/server/SalesRecoveryPlaybook.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  await import("../src/server/RuntimeCommandHandlers.js"); // registra whatsapp_send

  const sent: Array<{ to: string; text: string }> = [];
  let sendShouldFail = false;
  (MessageProviderService as any).sendMessage = async (_ch: string, to: string, text: string) => {
    if (sendShouldFail) throw new Error("evolution 500");
    sent.push({ to, text });
    return `msg_${randomUUID().slice(0, 8)}`;
  };

  const mkOrg = (viaExecutor: boolean) => {
    const id = `org_${randomUUID().slice(0, 8)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, execution_runtime_enabled, sales_recovery_enabled, sales_recovery_via_executor_enabled) VALUES (?, ?, 'X', 'active', 1, 1, ?)`)
      .run(randomUUID(), id, viaExecutor ? 1 : 0);
    return id;
  };
  const mkChannel = (orgId: string) => { const id = `ch-${randomUUID().slice(0, 6)}`; db.prepare(`INSERT INTO channels (id, organization_id, name, provider, status, kind) VALUES (?, ?, 'Canal', 'whatsapp_cloud', 'active', 'client')`).run(id, orgId); return id; };
  const mkContact = (orgId: string, channelId: string, optOut = 0) => { const id = randomUUID(); db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier, marketing_opt_out) VALUES (?, ?, ?, 'Cliente', '5511988887777', ?)`).run(id, orgId, channelId, optOut); return id; };
  const mkTicket = (orgId: string, contactId: string) => { const id = randomUUID(); db.prepare(`INSERT INTO tickets (id, organization_id, contact_id, status, stage, updated_at) VALUES (?, ?, ?, 'open', 'proposta', ?)`).run(id, orgId, contactId, new Date(Date.now() - 15 * 86400_000).toISOString()); return id; };
  const mkAnchor = (orgId: string, corr: string) => { const id = randomUUID(); db.prepare(`INSERT INTO decision_actions (id, organization_id, domain, action_type, status, title, command_type, basis, correlation_id) VALUES (?, ?, 'sales', 'sales_recovery_propose_message', 'approved', 'proposta', 'sales_recovery_propose_message', 'fact', ?)`).run(id, orgId, corr); return id; };
  const mkProposedSignal = (orgId: string, ticketId: string, channelId: string, contactId: string, actionId: string | null) =>
    BusinessSignalService.publish(orgId, {
      domain: "sales", signalType: "sales_recovery_proposed", severity: "attention", basis: "estimate", confidence: 0.8,
      sourceService: "test", sourceEntityType: "ticket", sourceEntityId: ticketId,
      evidence: { ticketId, phone: "5511988887777", channelId, contactId, proposedText: "Oi! Vamos retomar sua proposta? 😊", actionId },
      dedupeKey: `sales_recovery:proposed:${ticketId}`,
    }).id;

  const governed = (orgId: string) => db.prepare(`SELECT status, correlation_id FROM decision_actions WHERE organization_id = ? AND action_type = 'sales_recovery_send'`).all(orgId) as any[];
  const execLogs = (orgId: string) => db.prepare(`SELECT status, mode, correlation_id FROM action_execution_log WHERE organization_id = ? AND handler = 'WhatsAppSendCommandHandler'`).all(orgId) as any[];
  const sigStatus = (id: string) => (db.prepare(`SELECT status FROM business_signals WHERE id = ?`).get(id) as any)?.status;
  const auditCount = (orgId: string, ev: string) => (db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE organization_id = ? AND event_type = ?`).get(orgId, ev) as any).n;

  // ===== 1. Flag ON → envio via executor, auditado com correlationId herdado =====
  const CORR = "corr-sales-1";
  const oOn = mkOrg(true);
  const chOn = mkChannel(oOn);
  const ctOn = mkContact(oOn, chOn);
  const tkOn = mkTicket(oOn, ctOn);
  const anOn = mkAnchor(oOn, CORR);
  const sigOn = mkProposedSignal(oOn, tkOn, chOn, ctOn, anOn);
  const beforeTouch = (db.prepare(`SELECT updated_at FROM tickets WHERE id = ?`).get(tkOn) as any)?.updated_at;
  sent.length = 0;
  const rOn = await SalesRecoveryPlaybookService.approve(oOn, sigOn, { actorId: "u-owner" });
  check("ON: sent=true + messageId + signalStatus resolved", rOn.sent === true && !!rOn.messageId && rOn.signalStatus === "resolved");
  check("ON: mensagem saiu pelo handler", sent.length === 1);
  check("ON: ação sales_recovery_send criada e aprovada", (() => { const g = governed(oOn); return g.length === 1 && g[0].status === "approved"; })());
  check("ON: efeito auditado (execute/done) com correlationId herdado da âncora", (() => { const l = execLogs(oOn); return l.length === 1 && l[0].mode === "execute" && l[0].status === "done" && l[0].correlation_id === CORR; })());
  check("ON: sinal proposto vira resolved", sigStatus(sigOn) === "resolved");
  const pol = db.prepare(`SELECT autonomy_level, execution_mode FROM agent_policies WHERE organization_id = ? AND domain = 'sales' AND action_type = 'sales_recovery_send'`).get(oOn) as any;
  check("ON: política sales_recovery_send semeada", pol?.autonomy_level === "execute" && pol?.execution_mode === "approved_execution");
  const afterTouch = (db.prepare(`SELECT updated_at FROM tickets WHERE id = ?`).get(tkOn) as any)?.updated_at;
  check("ON: side-effects intactos (ticket touch + audit RUNTIME_SALES_RECOVERY_APPROVED)", afterTouch !== beforeTouch && auditCount(oOn, "RUNTIME_SALES_RECOVERY_APPROVED") >= 1);

  // ===== 2. Flag OFF → envio direto, sem ação governada =====
  const oOff = mkOrg(false);
  const chOff = mkChannel(oOff);
  const ctOff = mkContact(oOff, chOff);
  const tkOff = mkTicket(oOff, ctOff);
  const sigOff = mkProposedSignal(oOff, tkOff, chOff, ctOff, mkAnchor(oOff, "corr-x"));
  sent.length = 0;
  const rOff = await SalesRecoveryPlaybookService.approve(oOff, sigOff, { actorId: "u-owner" });
  check("OFF: sent=true direto, sinal resolved", rOff.sent === true && sigStatus(sigOff) === "resolved");
  check("OFF: NENHUMA ação governada / log de execução", governed(oOff).length === 0 && execLogs(oOff).length === 0);

  // ===== 3. Flag ON + falha no envio → kept_open + sinal (executor lança, catch trata) =====
  const oFail = mkOrg(true);
  const chF = mkChannel(oFail);
  const ctF = mkContact(oFail, chF);
  const tkF = mkTicket(oFail, ctF);
  const sigF = mkProposedSignal(oFail, tkF, chF, ctF, mkAnchor(oFail, "corr-f"));
  sendShouldFail = true;
  const rF = await SalesRecoveryPlaybookService.approve(oFail, sigF, { actorId: "u-owner" });
  sendShouldFail = false;
  check("ON falha: sent=false + signalStatus kept_open", rF.sent === false && rF.signalStatus === "kept_open");
  check("ON falha: sinal proposto continua open", sigStatus(sigF) === "open");
  check("ON falha: publica sales_recovery_send_failed", BusinessSignalService.list(oFail, { domain: "sales" }).some((s: any) => s.signal_type === "sales_recovery_send_failed"));

  // ===== 4. Guard LGPD intacto: opt-out barra ANTES do envio (mesmo com flag ON) =====
  const oOpt = mkOrg(true);
  const chO = mkChannel(oOpt);
  const ctO = mkContact(oOpt, chO, 1); // opt-out
  const tkO = mkTicket(oOpt, ctO);
  const sigO = mkProposedSignal(oOpt, tkO, chO, ctO, mkAnchor(oOpt, "corr-o"));
  sent.length = 0;
  let threwOpt = false;
  try { await SalesRecoveryPlaybookService.approve(oOpt, sigO, { actorId: "u-owner" }); } catch { threwOpt = true; }
  check("opt-out (LGPD): approve lança e NÃO envia", threwOpt && sent.length === 0);
  check("opt-out: nenhuma ação governada criada (guard antes do sink)", governed(oOpt).length === 0 && execLogs(oOpt).length === 0);

  // ===== 5. Isolamento + a falha TAMBÉM é auditada (RN-159-3) =====
  check("isolamento: cada org audita seu efeito (oOn done, oFail failed)",
    execLogs(oOn).length === 1 && execLogs(oOn)[0].status === "done" &&
    execLogs(oFail).length === 1 && execLogs(oFail)[0].status === "failed");

  console.log("\n=== TEST: Sales Recovery via choke-point (ADR-159 F2.4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Sales Recovery via choke-point (F2.4) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
