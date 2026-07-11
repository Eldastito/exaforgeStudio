/**
 * TESTE — Prospect AI Fase B: execução e medição (ADR-079)
 * ---------------------------------------------------------
 * Prova, offline (provedor de WhatsApp mockado) e em banco temporário, que:
 *   - abordagem aprovada é ENVIADA de verdade e vira status 'sent' + evento message.sent;
 *   - o envio re-checa guardrails (conta bloqueada não envia; provedor nem é chamado);
 *   - resposta do lead é correlacionada por telefone (formatos diferentes) → lead.replied;
 *   - reunião registrada → meeting.created;
 *   - conversão para CRM cria contato + ticket no Kanban, escopados por org e idempotentes;
 *   - nada disso vaza entre tenants.
 *
 * Uso:  npm run test:prospect-execution
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-prospect-exec-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-prospect-execucao-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ProspectService } = await import("../src/server/ProspectService.js");
  const { ProspectExecutionService } = await import("../src/server/ProspectExecutionService.js");
  const { MessageProviderService } = await import("../src/server/MessageProviderService.js");

  // Mock do provedor: registra chamadas, não toca a rede.
  const sends: any[] = [];
  (MessageProviderService as any).sendMessage = async (channelId: string, to: string, content: string) => {
    sends.push({ channelId, to, content });
    // sendMessage passou a devolver o id do provedor (wamid) como string.
    return "wamid.MOCK123";
  };

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Empresa ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const actorId = `user_${tag}`;
    const camp = ProspectService.createCampaign(orgId, { name: `Campanha ${tag}` }, actorId);
    ProspectService.importRecords(orgId, {
      campaignId: camp.id, sourceRef: `csv-${tag}`,
      records: [{ company: `Alfa ${tag}`, domain: `alfa-${tag}.com.br`, contactName: `Contato ${tag}`, phone: tag === "A" ? "5521998887766" : "5511911112222" }],
    }, actorId);
    const acc = ProspectService.listAccounts(orgId)[0];
    const contact = (ProspectService.getAccount(orgId, acc.id).contacts || [])[0];
    return { orgId, actorId, camp, acc, contact, channelId };
  }

  const A = seedOrg("A");
  const B = seedOrg("B");

  function insertOutreach(o: typeof A, status: string, channel = "whatsapp"): string {
    const id = randomUUID();
    db.prepare(`INSERT INTO prospect_outreach (id, organization_id, campaign_id, prospect_account_id, contact_id, channel, subject, body, evidence_snapshot, status) VALUES (?, ?, ?, ?, ?, ?, 'Assunto', 'Olá! Posso ajudar?', '{}', ?)`)
      .run(id, o.orgId, o.camp.id, o.acc.id, o.contact.id, channel, status);
    return id;
  }

  // ---- 1. Envio real (WhatsApp mockado) ----
  const o1 = insertOutreach(A, "approved");
  await ProspectExecutionService.sendOutreach(A.orgId, o1, A.actorId);
  const sent = db.prepare("SELECT * FROM prospect_outreach WHERE id = ?").get(o1) as any;
  check("Abordagem aprovada foi enviada (status sent)", sent.status === "sent");
  check("Envio usou o canal WhatsApp da org A", sends.length === 1 && sends[0].channelId === A.channelId);
  check("sent_via e provider_message_id gravados", sent.sent_via === "whatsapp" && sent.provider_message_id === "wamid.MOCK123");
  const evSent = db.prepare("SELECT * FROM prospect_events WHERE organization_id = ? AND event_type = 'message.sent'").all(A.orgId) as any[];
  check("Evento message.sent registrado", evSent.length === 1 && evSent[0].outreach_id === o1);

  // Rascunho (não aprovado) não envia.
  const o2 = insertOutreach(A, "draft");
  let threw = "";
  try { await ProspectExecutionService.sendOutreach(A.orgId, o2, A.actorId); } catch (e: any) { threw = e.message; }
  check("Rascunho não aprovado é recusado no envio", threw.includes("APROVADA"));

  // Conta bloqueada: provedor nem é chamado.
  const o3 = insertOutreach(A, "approved");
  ProspectService.setAccountBlocked(A.orgId, A.acc.id, true, A.actorId);
  const sendsBefore = sends.length;
  threw = "";
  try { await ProspectExecutionService.sendOutreach(A.orgId, o3, A.actorId); } catch (e: any) { threw = e.message; }
  check("Conta bloqueada: envio recusado ANTES do provedor", threw.includes("bloqueada") && sends.length === sendsBefore);
  ProspectService.setAccountBlocked(A.orgId, A.acc.id, false, A.actorId);

  // ---- 2. Correlação de resposta por telefone (formato diferente) ----
  const hit = ProspectExecutionService.correlateInboundReply(A.orgId, "(21) 9 9888-7766");
  check("Resposta correlacionada apesar do formato do telefone", hit === true);
  const replied = db.prepare("SELECT replied_at FROM prospect_outreach WHERE id = ?").get(o1) as any;
  check("replied_at marcado na abordagem enviada", !!replied.replied_at);
  check("Evento lead.replied registrado", (db.prepare("SELECT COUNT(*) n FROM prospect_events WHERE organization_id = ? AND event_type = 'lead.replied'").get(A.orgId) as any).n === 1);
  check("Telefone de A não correlaciona na org B", ProspectExecutionService.correlateInboundReply(B.orgId, "(21) 9 9888-7766") === false);
  check("Segunda mensagem do mesmo lead não duplica lead.replied", ProspectExecutionService.correlateInboundReply(A.orgId, "21998887766") === false);

  // ---- 3. Reunião ----
  ProspectExecutionService.registerMeeting(A.orgId, A.acc.id, { notes: "Reunião quinta 10h" }, A.actorId);
  const accAfterMeeting = db.prepare("SELECT meeting_at FROM prospect_accounts WHERE id = ?").get(A.acc.id) as any;
  check("meeting_at gravado na conta", !!accAfterMeeting.meeting_at);
  check("Evento meeting.created registrado", (db.prepare("SELECT COUNT(*) n FROM prospect_events WHERE organization_id = ? AND event_type = 'meeting.created'").get(A.orgId) as any).n === 1);

  // ---- 4. Conversão para CRM/Kanban ----
  const conv = ProspectExecutionService.convertToCrm(A.orgId, A.acc.id, A.actorId);
  check("Conversão criou ticket no Kanban", !!conv.ticketId && !conv.alreadyConverted);
  const ticket = db.prepare("SELECT * FROM tickets WHERE id = ?").get(conv.ticketId) as any;
  check("Ticket escopado na org A e em estágio válido", ticket.organization_id === A.orgId && ["novo_lead", "qualificado"].includes(ticket.stage));
  const crmContact = db.prepare("SELECT * FROM contacts WHERE id = ?").get(conv.crmContactId) as any;
  check("Contato CRM escopado na org A", crmContact.organization_id === A.orgId);
  const conv2 = ProspectExecutionService.convertToCrm(A.orgId, A.acc.id, A.actorId);
  check("Reconversão é idempotente (reaproveita o ticket)", conv2.alreadyConverted === true && conv2.ticketId === conv.ticketId);
  threw = "";
  try { ProspectExecutionService.convertToCrm(B.orgId, A.acc.id, B.actorId); } catch (e: any) { threw = e.message; }
  check("Conversão cross-tenant falha", threw.includes("não encontrada"));

  // ---- 5. Isolamento dos eventos ----
  check("Org B não vê eventos da org A", ProspectExecutionService.listEvents(B.orgId).length === 0);
  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r: any) => r.event_type);
  for (const ev of ["PROSPECT_OUTREACH_STATUS", "PROSPECT_LEAD_REPLIED", "PROSPECT_MEETING_CREATED", "PROSPECT_CONVERTED_TO_CRM"]) {
    check(`Auditoria registrou ${ev}`, audited.includes(ev));
  }

  console.log("\n=== Prospect AI — execução e medição (ADR-079, Fase B) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
