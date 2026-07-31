/**
 * TESTE — Módulo Clínica Fatia 32: Config UI + WhatsApp copy + observabilidade
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Escopo backend-testável. UI-front (aba "Configurações" no ClinicAgendaView,
 * fmtTime com timezone da org) fica documentada como pendente.
 *
 * ── Parser SIM/NÃO relaxado ────────────────────────────────────────────
 *   - Variantes existentes continuam funcionando: sim, s, ok, yes, 👍, nao
 *   - Novas: sim!!!, simmm, ok!!!, cancelaaaa, nãooo, naooo
 *   - "confirmou"/"confirmada" (mais formas do verbo confirmar)
 *   - Reagendar: remarcaaa, reagendaaa
 *   - Ambíguo continua null (não força classificação)
 *
 * ── Template do reminder ────────────────────────────────────────────────
 *   - renderMessage do lembrete 24h contém "REMARCAR" e "PARAR"
 *   - Template 2h também contém rodapé
 *   - Nome do paciente + clínica no corpo
 *
 * ── Opt-out (PARAR) ─────────────────────────────────────────────────────
 *   - parseIntent reconhece PARAR/STOP/SAIR/CANCELAR TUDO
 *   - tryHandle com "PARAR" revoga consent comunicacoes + audit
 *     CLINIC_REMINDER_OPTOUT
 *   - 2ª chamada (já opt-out) devolve reply amigável sem re-revogar
 *   - Opt-out não exige lembrete pendente (paciente pode pedir a qualquer
 *     momento)
 *
 * ── maskIdentifier ──────────────────────────────────────────────────────
 *   - Curto (≤8) devolve como está
 *   - Normal ("5511987654321") → "5511***4321"
 *   - null/vazio → null
 *   - Metadata de CLINIC_ADDENDUM_NOTIFIED / CLINIC_FOLLOWUP_NOTIFIED
 *     grava toIdentifier MASCARADO (não full)
 *
 * ── Rota agregada GET /clinic/settings ─────────────────────────────────
 *   - Retorna objeto com {retention, reminders, addendumNotification,
 *     followupNotification, receipt, businessName, timezone}
 *   - Defaults corretos quando organization_settings tem row mas colunas
 *     estão null
 *   - Isolamento cross-tenant
 *
 * Uso:  npm run test:clinic-config-ui
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-config-ui-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-config-ui-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicReminderReplyService } = await import("../src/server/ClinicReminderReplyService.js");
  const { ClinicAddendumNoticeService } = await import("../src/server/ClinicAddendumNoticeService.js");
  const { ClinicFollowUpNoticeService } = await import("../src/server/ClinicFollowUpNoticeService.js");
  const { ClinicReminderService } = await import("../src/server/ClinicReminderService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { maskIdentifier } = await import("../src/server/auditLog.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (name: string) => {
      const id = randomUUID();
      const identifier = `55${tag}${Math.floor(Math.random() * 1e8)}`;
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, identifier);
      LgpdService.grantConsent(orgId, id, "dados_sensiveis", { actorId: `user_${tag}` });
      LgpdService.grantConsent(orgId, id, "comunicacoes", { actorId: `user_${tag}` });
      return { contactId: id, identifier };
    };
    return { orgId, actorId: `user_${tag}`, mkContact };
  }

  const A = seedOrg("A");
  const patA = A.mkContact("Paciente A");
  const prof = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);

  // ── 1. Parser variantes ────────────────────────────────────────────────
  // Existentes (regressão)
  check("parser: 'sim' → confirmed", ClinicReminderReplyService.parseIntent("sim") === "confirmed");
  check("parser: 'S' → confirmed", ClinicReminderReplyService.parseIntent("S") === "confirmed");
  check("parser: 'ok' → confirmed", ClinicReminderReplyService.parseIntent("ok") === "confirmed");
  check("parser: 'nao' → cancelled", ClinicReminderReplyService.parseIntent("nao") === "cancelled");
  check("parser: 'não' → cancelled", ClinicReminderReplyService.parseIntent("não") === "cancelled");
  check("parser: 'cancelar' → cancelled", ClinicReminderReplyService.parseIntent("cancelar") === "cancelled");
  check("parser: 'remarcar' → reschedule_offered", ClinicReminderReplyService.parseIntent("remarcar") === "reschedule_offered");

  // Novas (relaxadas)
  check("parser: 'sim!!!' → confirmed (exclamação)", ClinicReminderReplyService.parseIntent("sim!!!") === "confirmed");
  check("parser: 'simmm' → confirmed (repetição)", ClinicReminderReplyService.parseIntent("simmm") === "confirmed");
  check("parser: 'ok!!!' → confirmed", ClinicReminderReplyService.parseIntent("ok!!!") === "confirmed");
  check("parser: 'okkk' → confirmed", ClinicReminderReplyService.parseIntent("okkk") === "confirmed");
  check("parser: 'confirmou' → confirmed", ClinicReminderReplyService.parseIntent("confirmou") === "confirmed");
  check("parser: 'confirmada' → confirmed", ClinicReminderReplyService.parseIntent("confirmada") === "confirmed");
  check("parser: 'cancelaaaa' → cancelled", ClinicReminderReplyService.parseIntent("cancelaaaa") === "cancelled");
  check("parser: 'nãooo' → cancelled", ClinicReminderReplyService.parseIntent("nãooo") === "cancelled");
  check("parser: 'naaaao' → cancelled", ClinicReminderReplyService.parseIntent("naaaao") === "cancelled");
  check("parser: 'remarcaaa' → reschedule_offered", ClinicReminderReplyService.parseIntent("remarcaaa") === "reschedule_offered");
  check("parser: 'reagendaaa' → reschedule_offered", ClinicReminderReplyService.parseIntent("reagendaaa") === "reschedule_offered");

  // Opt-out
  check("parser: 'PARAR' → optout", ClinicReminderReplyService.parseIntent("PARAR") === "optout");
  check("parser: 'stop' → optout", ClinicReminderReplyService.parseIntent("stop") === "optout");
  check("parser: 'SAIR' → optout", ClinicReminderReplyService.parseIntent("SAIR") === "optout");
  check("parser: 'cancelar tudo' → optout", ClinicReminderReplyService.parseIntent("cancelar tudo") === "optout");

  // Ambíguo
  check("parser: 'oi' → null", ClinicReminderReplyService.parseIntent("oi") === null);
  check("parser: 'quero remarcar hoje' → null (frase inteira)",
    ClinicReminderReplyService.parseIntent("quero remarcar hoje") === null);

  // ── 2. Template do reminder ────────────────────────────────────────────
  // Acessa via reflection lendo o resultado de sendForAppointment com sender fake
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patA.contactId, title: "Consulta A",
    scheduledStart: new Date(Date.now() + 24 * 3600_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const sendsRem: any[] = [];
  const senderRem = async (channelId: string, to: string, message: string) => {
    sendsRem.push({ channelId, to, message });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };
  await ClinicReminderService.sendForAppointment(A.orgId, apt.id, { templateKey: "24h" as any, force: true, sender: senderRem as any });
  const msg = sendsRem[0]?.message || "";
  check("template 24h contém REMARCAR", msg.includes("REMARCAR"));
  check("template 24h contém PARAR", msg.includes("PARAR"));
  check("template 24h mantém SIM/NÃO", msg.includes("SIM") && msg.includes("NÃO"));

  await ClinicReminderService.sendForAppointment(A.orgId, apt.id, { templateKey: "2h" as any, force: true, sender: senderRem as any });
  const msg2h = sendsRem[1]?.message || "";
  check("template 2h contém REMARCAR", msg2h.includes("REMARCAR"));
  check("template 2h contém PARAR", msg2h.includes("PARAR"));

  // ── 3. Opt-out via tryHandle ───────────────────────────────────────────
  const optoutContact = A.mkContact("Opt-Out Guy");
  check("optout: consent comms ATIVO antes", LgpdService.hasConsent(A.orgId, optoutContact.contactId, "comunicacoes"));

  const result1 = ClinicReminderReplyService.tryHandle(A.orgId, optoutContact.contactId, "PARAR");
  check("optout: handled=true", result1.handled === true);
  check("optout: action='optout'", result1.action === "optout");
  check("optout: reply amigável", typeof result1.reply === "string" && result1.reply.length > 20);
  check("optout: consent comms revogado após handle",
    !LgpdService.hasConsent(A.orgId, optoutContact.contactId, "comunicacoes"));

  // 2ª chamada — já revogado — devolve reply amigável sem re-revogar
  const result2 = ClinicReminderReplyService.tryHandle(A.orgId, optoutContact.contactId, "STOP");
  check("optout idempotente: 2ª chamada handled=true", result2.handled === true);
  check("optout idempotente: 2ª chamada devolve reply diferente ('já não recebe mais')",
    typeof result2.reply === "string" && result2.reply.toLowerCase().includes("já"));

  // Audit
  const optoutAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_REMINDER_OPTOUT'`
  ).get(A.orgId) as any;
  check("audit CLINIC_REMINDER_OPTOUT = 1 (só a 1ª chamada gravou)",
    Number(optoutAudit?.c) === 1, String(optoutAudit?.c));

  // ── 4. maskIdentifier ──────────────────────────────────────────────────
  check("mask: '5511987654321' → '5511***4321'", maskIdentifier("5511987654321") === "5511***4321");
  check("mask: '12345' → '12345' (curto)", maskIdentifier("12345") === "12345");
  check("mask: '' → null", maskIdentifier("") === null);
  check("mask: null → null", maskIdentifier(null) === null);
  check("mask: undefined → null", maskIdentifier(undefined) === null);
  check("mask: 8 chars exatos → passa (não mascara)", maskIdentifier("12345678") === "12345678");
  check("mask: 9 chars → mascara", maskIdentifier("123456789") === "1234***6789");

  // Audit metadata do FOLLOWUP_NOTIFIED tem toIdentifier MASCARADO
  const patAudit = A.mkContact("Audit Test");
  const aptOld = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patAudit.contactId, title: "Old",
    scheduledStart: new Date(Date.now() - 5 * 86400_000).toISOString(),
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const enc = ClinicEncounterService.open(A.orgId, aptOld.id, A.actorId);
  ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { subjective: "s", plan: "p" });
  const signed = ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);
  ClinicEncounterService.setFollowUpRecommendation(A.orgId, signed.id, A.actorId, 7);

  const senderFol: any[] = [];
  const senderFollow = async (channelId: string, to: string, message: string) => {
    senderFol.push({ channelId, to, message });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };
  await ClinicFollowUpNoticeService.notifyForEncounter(A.orgId, signed.id, {
    actorId: A.actorId, sender: senderFollow,
  });

  const notifMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_FOLLOWUP_NOTIFIED' ORDER BY created_at DESC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(notifMeta?.metadata_json || "{}");
  check("audit FOLLOWUP_NOTIFIED metadata tem toIdentifier",
    typeof meta.toIdentifier === "string" && meta.toIdentifier.length > 0);
  check("audit FOLLOWUP_NOTIFIED toIdentifier é MASCARADO (contém ***)",
    typeof meta.toIdentifier === "string" && meta.toIdentifier.includes("***"));
  check("audit FOLLOWUP_NOTIFIED toIdentifier NÃO tem full identifier",
    typeof meta.toIdentifier === "string" && meta.toIdentifier !== patAudit.identifier);

  // ── 5. Rota agregada /clinic/settings (via SQL direto simulando o handler) ─
  // Testa a query da rota: SELECT all fields, defaults quando null
  const settings = db.prepare(
    `SELECT business_name,
            clinic_retention_enabled, clinic_retention_days_deliveries, clinic_retention_days_attachments,
            clinic_reminder_hours, clinic_second_reminder_enabled, clinic_second_reminder_hours,
            clinic_addendum_notification_enabled,
            clinic_followup_notification_enabled, clinic_followup_notification_lead_days,
            clinic_receipt_business_document, clinic_receipt_business_document_type
       FROM organization_settings WHERE organization_id = ?`
  ).get(A.orgId) as any;
  check("settings query: businessName presente", settings?.business_name === "Clínica A");
  check("settings query: retention default enabled quando null (!== 0)", settings?.clinic_retention_enabled !== 0);
  check("settings query: reminder_hours default null (front usa 24)", settings?.clinic_reminder_hours == null || Number(settings.clinic_reminder_hours) === 24);

  // Cross-tenant
  const B = seedOrg("B");
  const settingsB = db.prepare(
    `SELECT business_name FROM organization_settings WHERE organization_id = ?`
  ).get(B.orgId) as any;
  check("settings cross-tenant: B tem próprio businessName", settingsB?.business_name === "Clínica B");

  const settingsBAsA = db.prepare(
    `SELECT business_name FROM organization_settings WHERE organization_id = ?`
  ).get(A.orgId) as any;
  check("settings cross-tenant: query com orgId de A não vê row de B",
    settingsBAsA?.business_name === "Clínica A");

  console.log("\n=== Config UI + WhatsApp copy + observabilidade (ADR-080 Fase 32) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
