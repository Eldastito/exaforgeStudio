/**
 * TESTE — Módulo Clínica Fase N: parser SIM/NÃO na resposta a lembrete
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - parseIntent reconhece variantes de SIM/NÃO com acento, caixa,
 *     pontuação, emoji;
 *   - texto ambíguo → intent null (fluxo normal segue);
 *   - tryHandle SEM lembrete recente → not_handled (a msg pode ser
 *     qualquer coisa; deixa a IA cuidar);
 *   - tryHandle FORA da janela (> 26h) → not_handled;
 *   - tryHandle SIM na janela → patient_confirmed_at setado + reply certo;
 *   - tryHandle NÃO na janela → status='cancelled' + cancelled_by='patient'
 *     + reason='patient_reply' + reply certo;
 *   - Idempotência: SIM 2× não muda timestamp, reply amigável;
 *   - Idempotência: NÃO 2× não recancela, reply amigável;
 *   - SIM sobre consulta já cancelada → reply "está cancelada"; NÃO age;
 *   - Cancelar libera horário → novo appointment no MESMO slot passa
 *     validação de conflito (sanity check da Fatia 3);
 *   - Reply de outro paciente NÃO afeta a consulta desta org;
 *   - Isolamento multi-tenant;
 *   - Auditoria (CONFIRMED_BY_PATIENT, CANCELLED com cancelledBy='patient').
 *
 * Uso:  npm run test:clinic-reminder-reply
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-reply-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-reply-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicReminderService } = await import("../src/server/ClinicReminderService.js");
  const { ClinicReminderReplyService } = await import("../src/server/ClinicReminderReplyService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, `55${tag}${Math.floor(Math.random() * 1e8)}`);
      return id;
    };
    return { orgId, channelId, actorId: `user_${tag}`, patient: mkContact("Ana"), other: mkContact("Bruno") };
  }

  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. B" }, A.actorId);
  const now = Date.now();
  const nowDate = new Date(now);

  // ── 1. parseIntent — variantes ───────────────────────────────────────
  const p = (t: string) => ClinicReminderReplyService.parseIntent(t);
  check("SIM → confirmed", p("SIM") === "confirmed");
  check("sim → confirmed", p("sim") === "confirmed");
  check("Sim! → confirmed", p("Sim!") === "confirmed");
  check("s → confirmed", p("s") === "confirmed");
  check("Confirmo → confirmed", p("Confirmo") === "confirmed");
  check("Confirmado. → confirmed", p("Confirmado.") === "confirmed");
  check("OK → confirmed", p("OK") === "confirmed");
  check("Yes → confirmed", p("Yes") === "confirmed");
  check("NÃO → cancelled", p("NÃO") === "cancelled");
  check("nao → cancelled", p("nao") === "cancelled");
  check("Não. → cancelled", p("Não.") === "cancelled");
  check("N → cancelled", p("N") === "cancelled");
  check("cancela → cancelled", p("cancela") === "cancelled");
  check("Cancelar → cancelled", p("Cancelar") === "cancelled");
  check("texto ambíguo → null", p("estarei aí") === null);
  check("string vazia → null", p("") === null);
  check("emoji só (👍) → confirmed", p("👍") === "confirmed");

  // ── 2. Sem lembrete recente → not_handled ─────────────────────────────
  const r1 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "SIM", now);
  check("SIM sem lembrete → not_handled", !r1.handled);

  // Cria consulta futura + lembrete
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta", scheduledStart: new Date(now + 24 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "comunicacoes", { actorId: A.actorId });
  const senderOk = async () => "wamid.mock";
  await ClinicReminderService.sendForAppointment(A.orgId, apt.id, { sender: senderOk });

  // ── 3. Fora da janela: força sent_at antigo ─────────────────────────
  db.prepare(`UPDATE clinical_appointment_reminders SET sent_at = datetime('now', '-30 hours') WHERE appointment_id = ?`).run(apt.id);
  const rOld = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "SIM", now);
  check("SIM fora da janela (30h) → not_handled", !rOld.handled);
  // Restaura sent_at pra dentro da janela
  db.prepare(`UPDATE clinical_appointment_reminders SET sent_at = CURRENT_TIMESTAMP WHERE appointment_id = ?`).run(apt.id);

  // ── 4. SIM confirma ──────────────────────────────────────────────────
  const rConfirm = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "Sim!", now);
  check("SIM handled + action=confirmed", rConfirm.handled && rConfirm.action === "confirmed");
  check("SIM reply contém 'Perfeito'", (rConfirm.reply || "").includes("Perfeito"));
  const aptAfter = db.prepare(`SELECT patient_confirmed_at FROM appointments WHERE id = ?`).get(apt.id) as any;
  check("patient_confirmed_at setado", !!aptAfter.patient_confirmed_at);

  // Idempotência SIM 2×
  const before = aptAfter.patient_confirmed_at;
  const rConfirm2 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "sim", now);
  const aptAfter2 = db.prepare(`SELECT patient_confirmed_at FROM appointments WHERE id = ?`).get(apt.id) as any;
  check("SIM 2× → reply 'Já está confirmado'", rConfirm2.handled && (rConfirm2.reply || "").includes("Já está confirmado"));
  check("patient_confirmed_at NÃO muda", aptAfter2.patient_confirmed_at === before);

  // ── 5. NÃO cancela ──────────────────────────────────────────────────
  // Nova consulta pra não colidir com a confirmada
  const apt2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta 2", scheduledStart: new Date(now + 25 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  await ClinicReminderService.sendForAppointment(A.orgId, apt2.id, { sender: senderOk });
  const rCancel = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "Não", now);
  check("NÃO handled + action=cancelled", rCancel.handled && rCancel.action === "cancelled");
  check("NÃO reply contém 'cancelada'", (rCancel.reply || "").toLowerCase().includes("cancelada"));
  const apt2After = db.prepare(`SELECT status, cancelled_by, cancellation_reason, cancelled_at FROM appointments WHERE id = ?`).get(apt2.id) as any;
  check("status virou 'cancelled'", apt2After.status === "cancelled");
  check("cancelled_by='patient'", apt2After.cancelled_by === "patient");
  check("cancellation_reason='patient_reply'", apt2After.cancellation_reason === "patient_reply");
  check("cancelled_at setado", !!apt2After.cancelled_at);

  // Idempotência NÃO 2×
  const rCancel2 = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "cancela", now);
  check("NÃO 2× → reply 'já estava cancelada'", rCancel2.handled && (rCancel2.reply || "").includes("já estava cancelada"));

  // ── 6. SIM após cancelamento (edge case) ─────────────────────────────
  const rSimCanc = ClinicReminderReplyService.tryHandle(A.orgId, A.patient, "SIM", now);
  // Como o lembrete mais recente é o do apt2 (cancelado), o SIM cai nele:
  check("SIM sobre appt cancelado → reply amigável", rSimCanc.handled && (rSimCanc.reply || "").toLowerCase().includes("cancelada"));

  // ── 7. Cancelar libera horário ───────────────────────────────────────
  // Consulta apt2 cancelou; tentar criar outra no mesmo slot deve funcionar
  const aptNew = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.other, title: "Outro paciente", scheduledStart: new Date(now + 25 * 3600_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  check("cancelar liberou horário: novo appt no mesmo slot sem conflito", !!aptNew.id);

  // ── 8. Isolamento multi-tenant ───────────────────────────────────────
  const B = seedOrg("B");
  const rCross = ClinicReminderReplyService.tryHandle(B.orgId, A.patient, "SIM", now);
  check("org B tentando confirmar via reply do paciente de A → not_handled", !rCross.handled);

  // ── 9. Contatos diferentes na mesma org ──────────────────────────────
  const rOther = ClinicReminderReplyService.tryHandle(A.orgId, A.other, "SIM", now);
  check("outro contato SEM lembrete recente → not_handled", !rOther.handled);

  // ── 10. Auditoria ────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type IN ('CLINIC_APPOINTMENT_CONFIRMED_BY_PATIENT','CLINIC_APPOINTMENT_CANCELLED')
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CONFIRMED_BY_PATIENT ≥ 1", (map.CLINIC_APPOINTMENT_CONFIRMED_BY_PATIENT || 0) >= 1);
  check("audit CANCELLED ≥ 1", (map.CLINIC_APPOINTMENT_CANCELLED || 0) >= 1);

  console.log("\n=== Parser SIM/NÃO WhatsApp (ADR-080 Fase N) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
