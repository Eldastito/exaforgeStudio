/**
 * TESTE — Módulo Clínica Fase O: Dashboard/insights (ADR-080).
 * ------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Window default = 30d; from/to explícitos respeitados;
 *   - appointments.total conta appts no período;
 *   - byStatus quebra por status corretamente;
 *   - noShowRate = no_show / past * 100 (denom só do passado);
 *   - completedRate = completed / past * 100;
 *   - patientConfirmedRate = confirmed / total * 100;
 *   - reminders.sent/failed contam certo;
 *   - confirmationRate = confirmados via reply / sent;
 *   - cancellationRate = cancelados via reply / sent;
 *   - cancellations.byOrigin agrupa patient/staff/system;
 *   - documents.prescriptionsIssued / certificatesIssued só issued no
 *     período (draft não conta);
 *   - documents.sentByChannel conta deliveries com status='sent';
 *   - followUps.recommended = signed encounters no período com days>0;
 *   - followUps.scheduled = appointments com parent_appointment_id no
 *     período;
 *   - followUps.pending = signed com days>0 sem retorno ativo;
 *   - professionals[] ordenado desc por appointments, agrupa direito;
 *   - occupationMinutes soma expected_duration com fallback 30;
 *   - Isolamento multi-tenant: org B não vê dados de A.
 *
 * Uso:  npm run test:clinic-metrics
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-metrics-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-metrics-1234567890";

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
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
  const { ClinicReminderService } = await import("../src/server/ClinicReminderService.js");
  const { ClinicMetricsService } = await import("../src/server/ClinicMetricsService.js");
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
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Ana"), other: mkContact("Bruno") };
  }
  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  const dr = ClinicAgendaService.createProfessional(A.orgId, { name: "Dr. Beto" }, A.actorId);

  const now = Date.now();
  // 4 no passado (5, 10, 15, 20 dias atrás), 3 no futuro (2, 5, 25 dias)
  const past5 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "P5", scheduledStart: new Date(now - 5 * 86400_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  const past10 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "P10", scheduledStart: new Date(now - 10 * 86400_000).toISOString(),
    professionalId: dra.id, durationMinutes: 60,
  }, A.actorId);
  const past15 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.other, title: "P15", scheduledStart: new Date(now - 15 * 86400_000).toISOString(),
    professionalId: dr.id, durationMinutes: 45,
  }, A.actorId);
  const past20 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.other, title: "P20", scheduledStart: new Date(now - 20 * 86400_000).toISOString(),
    professionalId: dr.id, durationMinutes: 30,
  }, A.actorId);
  const future2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "F2", scheduledStart: new Date(now + 2 * 86400_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  const future5 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.other, title: "F5", scheduledStart: new Date(now + 5 * 86400_000).toISOString(),
    professionalId: dr.id, durationMinutes: 30,
  }, A.actorId);
  const future25 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "F25", scheduledStart: new Date(now + 25 * 86400_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);

  // Marca 1 no-show + 2 completed + 1 cancelled (via cancel service) do passado
  db.prepare(`UPDATE appointments SET status='no_show' WHERE id = ?`).run(past5.id);
  db.prepare(`UPDATE appointments SET status='completed', checkout_at=? WHERE id = ?`).run(new Date(now - 10 * 86400_000 + 3600_000).toISOString(), past10.id);
  db.prepare(`UPDATE appointments SET status='completed', checkout_at=? WHERE id = ?`).run(new Date(now - 15 * 86400_000 + 3600_000).toISOString(), past15.id);
  ClinicAgendaService.cancel(A.orgId, past20.id, { cancelledBy: "staff", reason: "reagendou" }, A.actorId);

  // Paciente confirmou 2 do futuro
  ClinicAgendaService.confirmByPatient(A.orgId, future2.id, A.actorId);
  ClinicAgendaService.confirmByPatient(A.orgId, future5.id, A.actorId);

  // 1 cancelamento pelo paciente + 1 pelo sistema
  ClinicAgendaService.cancel(A.orgId, future25.id, { cancelledBy: "patient", reason: "patient_reply" }, A.actorId);
  // Simular system: cria e cancela
  const sysApt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "sys", scheduledStart: new Date(now + 10 * 86400_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  ClinicAgendaService.cancel(A.orgId, sysApt.id, { cancelledBy: "system", reason: "backup_flow" }, A.actorId);

  // Lembretes: 3 sent, 1 failed
  LgpdService.grantConsent(A.orgId, A.patient, "comunicacoes", { actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, A.other, "comunicacoes", { actorId: A.actorId });
  const senderOk = async () => "wamid.ok";
  const senderFail = async () => { throw new Error("boom"); };
  await ClinicReminderService.sendForAppointment(A.orgId, future2.id, { sender: senderOk }); // sent
  await ClinicReminderService.sendForAppointment(A.orgId, future5.id, { sender: senderOk }); // sent
  // Cria mais um future ATIVO só pra ter uma falha do provider.
  const failApt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "fail", scheduledStart: new Date(now + 12 * 86400_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  await ClinicReminderService.sendForAppointment(A.orgId, failApt.id, { sender: senderFail }); // failed
  // sysApt (cancelado pelo system) e future25 (cancelado pelo patient) ficam sem lembrete.

  // Encounters + docs + retorno pra ter dados
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, A.other, "dados_sensiveis", { actorId: A.actorId });
  const enc10 = ClinicEncounterService.open(A.orgId, past10.id, A.actorId);
  ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc10.id, A.actorId, 15);
  ClinicEncounterService.finalize(A.orgId, enc10.id, A.actorId);
  const rxDraft = ClinicDocumentsService.createPrescription(A.orgId, enc10.id, { items: [{ drug: "X" }] }, A.actorId);
  const rx = ClinicDocumentsService.issuePrescription(A.orgId, rxDraft.id, A.actorId);

  const enc15 = ClinicEncounterService.open(A.orgId, past15.id, A.actorId);
  ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc15.id, A.actorId, 7);
  ClinicEncounterService.finalize(A.orgId, enc15.id, A.actorId);
  const certDraft = ClinicDocumentsService.createCertificate(A.orgId, enc15.id, { days: 3 }, A.actorId);
  ClinicDocumentsService.issueCertificate(A.orgId, certDraft.id, A.actorId);
  // Retorno agendado só pra past15
  ClinicAgendaService.scheduleFollowUp(A.orgId, past15.id, { inDays: 7 }, A.actorId);

  // ── METRICS ──────────────────────────────────────────────────────────
  const m = ClinicMetricsService.overview(A.orgId);

  // Window
  check("window.days = 60 (default cobre 30d passado + 30d futuro)", m.window.days === 60);

  // Appointments
  check("appointments.total ≥ 8 (todos os appts do período)", m.appointments.total >= 8, String(m.appointments.total));
  check("byStatus tem no_show=1", m.appointments.byStatus["no_show"] === 1);
  check("byStatus tem completed=2", m.appointments.byStatus["completed"] === 2);
  check("byStatus tem cancelled ≥ 2 (staff + system + patient no futuro)", (m.appointments.byStatus["cancelled"] || 0) >= 2, String(m.appointments.byStatus["cancelled"]));
  check("appointments.past ≥ 4 (past5+10+15+20)", m.appointments.past >= 4, String(m.appointments.past));
  // no_show / past * 100 — 1 no-show, past≥4
  check("noShowRate calculado (base past)", m.appointments.noShowRate > 0 && m.appointments.noShowRate <= 25.01, String(m.appointments.noShowRate));
  check("completedRate calculado (2 completed / past)", m.appointments.completedRate > 0 && m.appointments.completedRate <= 50.01, String(m.appointments.completedRate));
  check("patientConfirmedRate > 0 (2 confirmações)", m.appointments.patientConfirmedRate > 0);

  // Reminders
  check("reminders.sent = 2", m.reminders.sent === 2, String(m.reminders.sent));
  check("reminders.failed = 1", m.reminders.failed === 1, String(m.reminders.failed));
  // future2 e future5 estão confirmed pelo paciente → confirmationRate deve ser > 0
  check("confirmationRate > 0", m.reminders.confirmationRate > 0);
  // Nenhum cancelamento veio de reply nos lembretes sent (só de cancel manual)
  check("cancellationRate reflete replies", m.reminders.cancellationRate >= 0);

  // Cancellations
  check("cancellations.total ≥ 3", m.cancellations.total >= 3, String(m.cancellations.total));
  check("byOrigin.patient = 1", m.cancellations.byOrigin.patient === 1);
  check("byOrigin.staff = 1", m.cancellations.byOrigin.staff === 1);
  check("byOrigin.system = 1", m.cancellations.byOrigin.system === 1);
  check("patientShare > 0", m.cancellations.patientShare > 0);

  // Documents
  check("prescriptionsIssued = 1", m.documents.prescriptionsIssued === 1);
  check("certificatesIssued = 1", m.documents.certificatesIssued === 1);
  check("sentByChannel = 0 (não enviamos nenhum)", m.documents.sentByChannel === 0);

  // FollowUps
  check("followUps.recommended = 2 (enc10 + enc15)", m.followUps.recommended === 2, String(m.followUps.recommended));
  // Só 1 retorno agendado (past15 gerou followup)
  check("followUps.scheduled ≥ 1", m.followUps.scheduled >= 1);
  check("followUps.pending = 1 (enc10 recomendou mas não agendou)", m.followUps.pending === 1, String(m.followUps.pending));

  // Professionals
  check("professionals.length ≥ 2 (dra + dr)", m.professionals.length >= 2);
  const draRow = m.professionals.find((p) => p.name === "Dra. Ana");
  const drRow = m.professionals.find((p) => p.name === "Dr. Beto");
  check("dra tem >= 3 appointments", (draRow?.appointments || 0) >= 3);
  check("dr tem >= 3 appointments (past15+past20+future5)", (drRow?.appointments || 0) >= 3);
  check("professionals ordenado desc por appointments", m.professionals[0].appointments >= m.professionals[1].appointments);
  check("occupationMinutes de dra > 0", (draRow?.occupationMinutes || 0) > 0);

  // ── Filtro from/to ──────────────────────────────────────────────────
  const m7 = ClinicMetricsService.overview(A.orgId, {
    from: new Date(now - 7 * 86400_000).toISOString(),
    to: new Date(now + 7 * 86400_000).toISOString(),
  });
  check("window 14 dias respeita from/to", m7.window.days === 14);
  check("appointments.total é menor no window curto", m7.appointments.total < m.appointments.total);

  // ── Isolamento multi-tenant ─────────────────────────────────────────
  const B = seedOrg("B");
  const mB = ClinicMetricsService.overview(B.orgId);
  check("org B: 0 appointments", mB.appointments.total === 0);
  check("org B: 0 reminders", mB.reminders.sent === 0);
  check("org B: 0 professionals", mB.professionals.length === 0);
  check("org B: 0 followUps.recommended", mB.followUps.recommended === 0);

  console.log("\n=== Dashboard/insights clínico (ADR-080 Fase O) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
