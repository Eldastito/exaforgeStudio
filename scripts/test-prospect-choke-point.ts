/**
 * TEST — ADR-159 F2.5 (D1): reroute do ProspectExecution pelo choke-point.
 *
 * ProspectExecutionService.sendOutreach tem DOIS sinks diretos (WhatsApp + Gmail)
 * e nenhuma ação âncora. Sob a flag `prospect_via_executor_enabled`, ambos passam
 * PELO choke-point: WhatsApp via `sendGovernedMessage` (handler whatsapp_send),
 * e-mail via `dispatchGoverned` (handler NOVO gmail_send). Sem âncora →
 * correlationId nova raiz. Flag OFF = envio direto (0 regressão). A ordenação
 * "provedor confirma ANTES de status='sent'" é preservada (executor lança na
 * falha → status não avança).
 *
 * Uso: npm run test:prospect-choke-point
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prospect-choke-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-prospect-choke-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");
  const { ProspectExecutionService } = await import("../src/server/ProspectExecutionService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");
  const { GoogleOAuthService } = await import("../src/server/GoogleOAuthService.js");
  await import("../src/server/RuntimeCommandHandlers.js"); // registra whatsapp_send + gmail_send

  const waSends: any[] = [];
  const emails: any[] = [];
  let gmailShouldFail = false;
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, content: string) => { waSends.push({ channelId, to, content }); return "wamid.MOCK"; };
  (GoogleOAuthService as any).gmailSend = async (_org: string, to: string, subject: string, body: string) => {
    if (gmailShouldFail) return { error: "Conta Google não conectada." };
    emails.push({ to, subject, body }); return { id: "gmail_MOCK" };
  };

  let seq = 0;
  const seedOrg = (viaExecutor: boolean) => {
    const tag = `t${seq++}`;
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, prospect_via_executor_enabled) VALUES (?, ?, ?, 'active', ?)`).run(randomUUID(), orgId, `E ${tag}`, viaExecutor ? 1 : 0);
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`).run(`ch_${tag}`, orgId, `Canal ${tag}`, `wa_${tag}`);
    const actorId = `user_${tag}`;
    const camp = ProspectService.createCampaign(orgId, { name: `C ${tag}` }, actorId);
    ProspectService.importRecords(orgId, { campaignId: camp.id, sourceRef: `csv-${tag}`, records: [{ company: `Alfa ${tag}`, domain: `alfa-${tag}.com.br`, contactName: `Contato ${tag}`, phone: "5521998887766" }] }, actorId);
    const acc = ProspectService.listAccounts(orgId)[0];
    const contact = (ProspectService.getAccount(orgId, acc.id).contacts || [])[0];
    // Garante e-mail no contato (o import só trouxe telefone).
    db.prepare(`UPDATE prospect_contacts SET email = ? WHERE id = ? AND organization_id = ?`).run(`lead-${tag}@ex.com`, contact.id, orgId);
    return { orgId, actorId, camp, acc, contact };
  };
  const mkOutreach = (o: any, channel: string) => {
    const id = randomUUID();
    db.prepare(`INSERT INTO prospect_outreach (id, organization_id, campaign_id, prospect_account_id, contact_id, channel, subject, body, evidence_snapshot, status) VALUES (?, ?, ?, ?, ?, ?, 'Oi', 'Olá! Posso ajudar?', '{}', 'approved')`)
      .run(id, o.orgId, o.camp.id, o.acc.id, o.contact.id, channel);
    return id;
  };
  const governed = (orgId: string, actionType: string) => db.prepare(`SELECT status, correlation_id FROM decision_actions WHERE organization_id = ? AND action_type = ?`).all(orgId, actionType) as any[];
  const execLogs = (orgId: string, handler: string) => db.prepare(`SELECT status, mode, correlation_id FROM action_execution_log WHERE organization_id = ? AND handler = ?`).all(orgId, handler) as any[];
  const outreachRow = (id: string) => db.prepare(`SELECT status, sent_via, provider_message_id FROM prospect_outreach WHERE id = ?`).get(id) as any;

  // ═══════ A) WhatsApp sink ═══════
  // A1. ON → via executor (whatsapp_send).
  const waOn = seedOrg(true);
  const oWaOn = mkOutreach(waOn, "whatsapp");
  waSends.length = 0;
  await ProspectExecutionService.sendOutreach(waOn.orgId, oWaOn, waOn.actorId);
  check("wa ON: outreach sent + sent_via=whatsapp + providerMessageId", (() => { const r = outreachRow(oWaOn); return r.status === "sent" && r.sent_via === "whatsapp" && r.provider_message_id === "wamid.MOCK"; })());
  check("wa ON: ação prospect_outreach_whatsapp criada e aprovada", (() => { const g = governed(waOn.orgId, "prospect_outreach_whatsapp"); return g.length === 1 && g[0].status === "approved"; })());
  check("wa ON: efeito auditado (execute/done) com correlationId (raiz nova)", (() => { const l = execLogs(waOn.orgId, "WhatsAppSendCommandHandler"); return l.length === 1 && l[0].mode === "execute" && l[0].status === "done" && !!l[0].correlation_id; })());

  // A2. OFF → direto.
  const waOff = seedOrg(false);
  const oWaOff = mkOutreach(waOff, "whatsapp");
  waSends.length = 0;
  await ProspectExecutionService.sendOutreach(waOff.orgId, oWaOff, waOff.actorId);
  check("wa OFF: enviado direto (sent) sem ação governada", outreachRow(oWaOff).status === "sent" && governed(waOff.orgId, "prospect_outreach_whatsapp").length === 0 && execLogs(waOff.orgId, "WhatsAppSendCommandHandler").length === 0);

  // ═══════ B) Gmail sink (handler NOVO) ═══════
  // B1. ON → via executor (gmail_send).
  const emOn = seedOrg(true);
  const oEmOn = mkOutreach(emOn, "email");
  emails.length = 0;
  await ProspectExecutionService.sendOutreach(emOn.orgId, oEmOn, emOn.actorId);
  check("email ON: outreach sent + sent_via=email + providerMessageId=gmail", (() => { const r = outreachRow(oEmOn); return r.status === "sent" && r.sent_via === "email" && r.provider_message_id === "gmail_MOCK"; })());
  check("email ON: e-mail realmente enviado pelo handler gmail_send", emails.length === 1 && /^lead-.*@ex\.com$/.test(emails[0].to));
  check("email ON: ação prospect_outreach_email criada e aprovada", (() => { const g = governed(emOn.orgId, "prospect_outreach_email"); return g.length === 1 && g[0].status === "approved"; })());
  check("email ON: efeito auditado pelo GmailSendCommandHandler (execute/done)", (() => { const l = execLogs(emOn.orgId, "GmailSendCommandHandler"); return l.length === 1 && l[0].status === "done" && !!l[0].correlation_id; })());

  // B2. OFF → direto.
  const emOff = seedOrg(false);
  const oEmOff = mkOutreach(emOff, "email");
  emails.length = 0;
  await ProspectExecutionService.sendOutreach(emOff.orgId, oEmOff, emOff.actorId);
  check("email OFF: enviado direto sem ação governada", outreachRow(oEmOff).status === "sent" && governed(emOff.orgId, "prospect_outreach_email").length === 0 && execLogs(emOff.orgId, "GmailSendCommandHandler").length === 0);

  // B3. ON + Gmail falha → executor lança; status NÃO avança (fica approved).
  const emFail = seedOrg(true);
  const oEmFail = mkOutreach(emFail, "email");
  gmailShouldFail = true;
  let threw = false;
  try { await ProspectExecutionService.sendOutreach(emFail.orgId, oEmFail, emFail.actorId); } catch { threw = true; }
  gmailShouldFail = false;
  check("email ON falha: sendOutreach lança + outreach NÃO vira sent (segue approved)", threw && outreachRow(oEmFail).status === "approved");
  check("email ON falha: tentativa auditada como failed (RN-159-3)", (() => { const l = execLogs(emFail.orgId, "GmailSendCommandHandler"); return l.length === 1 && l[0].status === "failed"; })());

  // ═══════ C) Guard preservado: conta bloqueada barra ANTES do sink (flag ON) ═══════
  const blk = seedOrg(true);
  const oBlk = mkOutreach(blk, "whatsapp");
  ProspectService.setAccountBlocked(blk.orgId, blk.acc.id, true, blk.actorId);
  waSends.length = 0;
  let threwBlk = false;
  try { await ProspectExecutionService.sendOutreach(blk.orgId, oBlk, blk.actorId); } catch { threwBlk = true; }
  check("bloqueada: lança ANTES do sink (nada enviado, nenhuma ação governada)", threwBlk && waSends.length === 0 && governed(blk.orgId, "prospect_outreach_whatsapp").length === 0);

  console.log("\n=== TEST: Prospect via choke-point (ADR-159 F2.5) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Prospect via choke-point (F2.5) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
