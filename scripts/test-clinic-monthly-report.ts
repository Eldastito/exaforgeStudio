/**
 * TESTE — Módulo Clínica Fase 17 (ADR-080): Relatório mensal em PDF.
 * ------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - `normalizeMonth` aceita YYYY-MM válido; sem input, cai no mês
 *     ANTERIOR ao `nowMs` (relatório é retrospectivo, não parcial);
 *   - `monthWindow` fecha o mês em UTC (dia 1 00:00 → último dia 23:59:59.999);
 *   - `buildPayload` chama `ClinicMetricsService.overview` com essa janela
 *     e traz `businessName` do `organization_settings`;
 *   - Agregados casam com o seed: contagens de completed/no-show/cancelled,
 *     minutos recuperados = duração das vagas aceitas, docs.issued por mês;
 *   - PDF começa com `%PDF-` (magic bytes válidos);
 *   - `pdf-parse` extrai texto literal: nome da clínica, "Relatório mensal ·
 *     julho de 2026", "Atendimentos", "Cancelamentos por origem",
 *     "Lembretes WhatsApp", "Automações WhatsApp", "Documentos emitidos",
 *     "Retornos", "Ocupação por profissional", nome do profissional e
 *     "Horário recuperado";
 *   - Isolamento multi-tenant: org B com dados no mesmo mês NÃO aparece
 *     no relatório de A (por buildPayload, agregados de A não vazam de B);
 *   - Consulta de mês SEM dados renderiza PDF válido com "Sem atendimentos
 *     no período." em vez de quebrar.
 *
 * Uso:  npm run test:clinic-monthly-report
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-monthly-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-monthly-report-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function pdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const out = await parser.getText();
  return String(out?.text || "");
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
  const { ClinicReminderService } = await import("../src/server/ClinicReminderService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { ClinicMonthlyReportService, normalizeMonth, monthWindow } = await import("../src/server/ClinicMonthlyReportService.js");

  // ── 1. normalizeMonth / monthWindow ───────────────────────────────────
  const nowJulyMs = Date.UTC(2026, 6, 15, 12, 0, 0); // 2026-07-15
  check("normalizeMonth(undefined) volta mês anterior a nowMs", normalizeMonth(undefined, nowJulyMs) === "2026-06");
  check("normalizeMonth('2026-07') aceita input válido", normalizeMonth("2026-07", nowJulyMs) === "2026-07");
  check("normalizeMonth('2026-13') rejeita → mês anterior a nowMs", normalizeMonth("2026-13", nowJulyMs) === "2026-06");
  check("normalizeMonth('xyz') rejeita → default", normalizeMonth("xyz", nowJulyMs) === "2026-06");

  const win = monthWindow("2026-07");
  check("monthWindow('2026-07').fromISO = 2026-07-01T00:00Z", win.fromISO === "2026-07-01T00:00:00.000Z");
  check("monthWindow('2026-07').toISO = 2026-07-31T23:59:59.999Z", win.toISO === "2026-07-31T23:59:59.999Z");
  check("monthWindow('2026-07').label = 'julho de 2026'", win.label === "julho de 2026");
  check("monthWindow('2026-02').toISO cobre fim de fev (dia 28)", monthWindow("2026-02").toISO.startsWith("2026-02-28"));

  // ── 2. Seed org A com atividade no mês 2026-07 ────────────────────────
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
      LgpdService.grantConsent(orgId, id, "comunicacoes", { actorId: `user_${tag}` });
      LgpdService.grantConsent(orgId, id, "dados_sensiveis", { actorId: `user_${tag}` });
      return id;
    };
    return { orgId, actorId: `user_${tag}`, ana: mkContact("Ana"), bruno: mkContact("Bruno") };
  }

  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Julia" }, A.actorId);
  const dr = ClinicAgendaService.createProfessional(A.orgId, { name: "Dr. Marcos" }, A.actorId);

  // 3 no-show, 5 completed, 2 cancelled, 4 confirmed — todos em julho/2026
  const jul = (dayUtc: number, h: number, opts: Partial<{ contactId: string; professionalId: string; durationMinutes: number }> = {}) =>
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: opts.contactId || A.ana, title: "T",
      scheduledStart: new Date(Date.UTC(2026, 6, dayUtc, h, 0, 0)).toISOString(),
      professionalId: opts.professionalId || dra.id,
      durationMinutes: opts.durationMinutes || 30,
      force: true,
    }, A.actorId);

  const c1 = jul(2, 10); const c2 = jul(3, 11); const c3 = jul(4, 9);
  const c4 = jul(5, 10, { professionalId: dr.id }); const c5 = jul(6, 14, { professionalId: dr.id });
  db.prepare(`UPDATE appointments SET status='completed', checkout_at=? WHERE id=?`).run("2026-07-02T10:30:00Z", c1.id);
  db.prepare(`UPDATE appointments SET status='completed', checkout_at=? WHERE id=?`).run("2026-07-03T11:30:00Z", c2.id);
  db.prepare(`UPDATE appointments SET status='completed', checkout_at=? WHERE id=?`).run("2026-07-04T09:30:00Z", c3.id);
  db.prepare(`UPDATE appointments SET status='completed', checkout_at=? WHERE id=?`).run("2026-07-05T10:30:00Z", c4.id);
  db.prepare(`UPDATE appointments SET status='completed', checkout_at=? WHERE id=?`).run("2026-07-06T14:30:00Z", c5.id);

  const ns1 = jul(7, 10); const ns2 = jul(8, 11); const ns3 = jul(9, 15, { professionalId: dr.id });
  db.prepare(`UPDATE appointments SET status='no_show' WHERE id=?`).run(ns1.id);
  db.prepare(`UPDATE appointments SET status='no_show' WHERE id=?`).run(ns2.id);
  db.prepare(`UPDATE appointments SET status='no_show' WHERE id=?`).run(ns3.id);

  const cx1 = jul(10, 10); const cx2 = jul(11, 14);
  ClinicAgendaService.cancel(A.orgId, cx1.id, { cancelledBy: "patient", reason: "patient_reply" }, A.actorId);
  ClinicAgendaService.cancel(A.orgId, cx2.id, { cancelledBy: "staff", reason: "reagendou" }, A.actorId);
  // cancel() grava cancelled_at = AGORA, mas o relatório é de julho/2026 e o
  // byOrigin filtra por cancelled_at dentro do mês — fixa a data no período
  // do seed (mesmo padrão do checkout_at acima) pra rodar em qualquer mês.
  db.prepare(`UPDATE appointments SET cancelled_at=? WHERE id=?`).run("2026-07-10T11:00:00Z", cx1.id);
  db.prepare(`UPDATE appointments SET cancelled_at=? WHERE id=?`).run("2026-07-11T15:00:00Z", cx2.id);

  const c6 = jul(20, 10); const c7 = jul(21, 10); const c8 = jul(22, 14); const c9 = jul(23, 14);
  ClinicAgendaService.confirmByPatient(A.orgId, c6.id, A.actorId);
  ClinicAgendaService.confirmByPatient(A.orgId, c7.id, A.actorId);
  ClinicAgendaService.confirmByPatient(A.orgId, c8.id, A.actorId);
  ClinicAgendaService.confirmByPatient(A.orgId, c9.id, A.actorId);

  // Docs emitidos no mês (2 receitas + 1 atestado)
  const enc1 = ClinicEncounterService.open(A.orgId, c1.id, A.actorId);
  ClinicEncounterService.setFollowUpRecommendation(A.orgId, enc1.id, A.actorId, 15);
  ClinicEncounterService.finalize(A.orgId, enc1.id, A.actorId);
  const rxD1 = ClinicDocumentsService.createPrescription(A.orgId, enc1.id, { items: [{ drug: "X" }] }, A.actorId);
  ClinicDocumentsService.issuePrescription(A.orgId, rxD1.id, A.actorId);
  const rxD2 = ClinicDocumentsService.createPrescription(A.orgId, enc1.id, { items: [{ drug: "Y" }] }, A.actorId);
  ClinicDocumentsService.issuePrescription(A.orgId, rxD2.id, A.actorId);
  const enc2 = ClinicEncounterService.open(A.orgId, c2.id, A.actorId);
  ClinicEncounterService.finalize(A.orgId, enc2.id, A.actorId);
  const certD = ClinicDocumentsService.createCertificate(A.orgId, enc2.id, { days: 3 }, A.actorId);
  ClinicDocumentsService.issueCertificate(A.orgId, certD.id, A.actorId);
  // Força issued_at para o mês (o service pode gravar CURRENT_TIMESTAMP)
  db.prepare(`UPDATE clinical_prescriptions SET issued_at='2026-07-02T11:00:00Z' WHERE id=?`).run(rxD1.id);
  db.prepare(`UPDATE clinical_prescriptions SET issued_at='2026-07-02T11:05:00Z' WHERE id=?`).run(rxD2.id);
  db.prepare(`UPDATE clinical_medical_certificates SET issued_at='2026-07-03T12:00:00Z' WHERE id=?`).run(certD.id);
  // Também alinha signed_at do encounter pra cair no mês
  db.prepare(`UPDATE clinical_encounters SET signed_at='2026-07-02T10:45:00Z' WHERE id=?`).run(enc1.id);
  db.prepare(`UPDATE clinical_encounters SET signed_at='2026-07-03T11:45:00Z' WHERE id=?`).run(enc2.id);

  // 1 vaga aceita de 60min → recoveredMinutes = 60
  const vacId = randomUUID();
  db.prepare(
    `INSERT INTO clinical_vacancy_offers
       (id, organization_id, source_appointment_id, candidate_contact_id, candidate_encounter_id,
        professional_id, slot_start, slot_duration_minutes, status, expires_at, created_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?, ?, ?)`
  ).run(vacId, A.orgId, c1.id, A.bruno, enc1.id, dra.id, "2026-07-15T10:00:00Z", 60, "2026-07-15T09:00:00Z", "2026-07-14T10:00:00Z", "2026-07-14T10:05:00Z");

  // 1 vaga oferecida (pending) — não conta em recovered
  db.prepare(
    `INSERT INTO clinical_vacancy_offers
       (id, organization_id, source_appointment_id, candidate_contact_id, candidate_encounter_id,
        professional_id, slot_start, slot_duration_minutes, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
  ).run(randomUUID(), A.orgId, c2.id, A.bruno, enc2.id, dra.id, "2026-07-20T10:00:00Z", 30, "2026-07-20T11:00:00Z", "2026-07-19T10:00:00Z");

  // ── 3. buildPayload cobre o mês certo ──────────────────────────────────
  const payload = ClinicMonthlyReportService.buildPayload(A.orgId, "2026-07");
  check("payload.month = 2026-07", payload.month === "2026-07");
  check("payload.monthLabel = 'julho de 2026'", payload.monthLabel === "julho de 2026");
  check("payload.businessName = 'Clínica A'", payload.businessName === "Clínica A");
  const m = payload.metrics;
  check("metrics.appointments.total ≥ 12 (5 comp + 3 ns + 2 cx + 4 conf)", m.appointments.total >= 12, String(m.appointments.total));
  check("byStatus.completed = 5", m.appointments.byStatus["completed"] === 5, String(m.appointments.byStatus["completed"]));
  check("byStatus.no_show = 3", m.appointments.byStatus["no_show"] === 3, String(m.appointments.byStatus["no_show"]));
  check("cancellations.byOrigin.patient = 1", m.cancellations.byOrigin.patient === 1);
  check("cancellations.byOrigin.staff = 1", m.cancellations.byOrigin.staff === 1);
  check("documents.prescriptionsIssued = 2", m.documents.prescriptionsIssued === 2, String(m.documents.prescriptionsIssued));
  check("documents.certificatesIssued = 1", m.documents.certificatesIssued === 1);
  check("automations.vacancy.accepted = 1", m.automations.vacancy.accepted === 1);
  check("automations.vacancy.recoveredMinutes = 60", m.automations.vacancy.recoveredMinutes === 60, String(m.automations.vacancy.recoveredMinutes));
  check("professionals inclui Dra. Julia + Dr. Marcos", m.professionals.some((p) => p.name === "Dra. Julia") && m.professionals.some((p) => p.name === "Dr. Marcos"));

  // ── 4. PDF ─────────────────────────────────────────────────────────────
  const pdf = await ClinicMonthlyReportService.renderPdfFromPayload(payload);
  check("PDF começa com %PDF-", pdf.subarray(0, 5).toString() === "%PDF-");
  const text = await pdfText(pdf);
  check("PDF contém 'Clínica A'", text.includes("Clínica A"));
  check("PDF contém 'Relatório mensal'", text.includes("Relatório mensal"));
  check("PDF contém 'julho de 2026'", text.includes("julho de 2026"));
  check("PDF contém 'Atendimentos'", text.includes("Atendimentos"));
  check("PDF contém 'Cancelamentos por origem'", text.includes("Cancelamentos por origem"));
  check("PDF contém 'Lembretes WhatsApp'", text.includes("Lembretes WhatsApp"));
  check("PDF contém 'Automações WhatsApp'", text.includes("Automações WhatsApp"));
  check("PDF contém 'Documentos emitidos'", text.includes("Documentos emitidos"));
  check("PDF contém 'Retornos'", text.includes("Retornos"));
  check("PDF contém 'Ocupação por profissional'", text.includes("Ocupação por profissional"));
  check("PDF contém 'Dra. Julia'", text.includes("Dra. Julia"));
  check("PDF contém 'Dr. Marcos'", text.includes("Dr. Marcos"));
  check("PDF contém 'Horário recuperado'", text.includes("Horário recuperado"));
  check("PDF contém '1 h' (60 minutos aceitos)", text.includes("1 h"));
  check("PDF contém rodapé 'ADR-080 Fase 17'", text.includes("ADR-080 Fase 17"));

  // ── 5. Isolamento multi-tenant ─────────────────────────────────────────
  const B = seedOrg("B");
  const draB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dra. Isolamento" }, B.actorId);
  ClinicAgendaService.createAppointment(B.orgId, {
    contactId: B.ana, title: "T-B",
    scheduledStart: new Date(Date.UTC(2026, 6, 10, 10, 0, 0)).toISOString(),
    professionalId: draB.id, durationMinutes: 30, force: true,
  }, B.actorId);
  const payloadA2 = ClinicMonthlyReportService.buildPayload(A.orgId, "2026-07");
  check("A.total inalterado após seed em B", payloadA2.metrics.appointments.total === m.appointments.total);
  check("A.professionals NÃO inclui Dra. Isolamento", !payloadA2.metrics.professionals.some((p) => p.name === "Dra. Isolamento"));
  const payloadB = ClinicMonthlyReportService.buildPayload(B.orgId, "2026-07");
  check("B tem exatamente 1 appointment", payloadB.metrics.appointments.total === 1);
  check("B.businessName = 'Clínica B'", payloadB.businessName === "Clínica B");

  // ── 6. Mês vazio renderiza PDF válido ──────────────────────────────────
  const empty = ClinicMonthlyReportService.buildPayload(A.orgId, "2020-01");
  check("mês vazio: total = 0", empty.metrics.appointments.total === 0);
  const pdfEmpty = await ClinicMonthlyReportService.renderPdfFromPayload(empty);
  check("PDF vazio começa com %PDF-", pdfEmpty.subarray(0, 5).toString() === "%PDF-");
  const emptyText = await pdfText(pdfEmpty);
  check("PDF vazio contém 'Sem atendimentos no período.'", emptyText.includes("Sem atendimentos no período"));

  // ── 7. renderPdf (atalho) devolve mesmo formato ────────────────────────
  const pdf2 = await ClinicMonthlyReportService.renderPdf(A.orgId, "2026-07");
  check("renderPdf devolve %PDF-", pdf2.subarray(0, 5).toString() === "%PDF-");

  // Silencia warning de reminder (contatos sem consent) — não afeta métricas.
  // Aqui não geramos lembretes, então reminders.sent = 0.
  check("reminders.sent = 0 (nenhum enviado no seed)", m.reminders.sent === 0);
  // Confere que a chamada não quebra quando algum lembrete real existe:
  await ClinicReminderService.sendForAppointment(A.orgId, c6.id, { sender: async () => "wamid.mock" });
  db.prepare(`UPDATE clinical_appointment_reminders SET sent_at='2026-07-19T10:00:00Z' WHERE appointment_id=?`).run(c6.id);
  const payload3 = ClinicMonthlyReportService.buildPayload(A.orgId, "2026-07");
  check("após enviar 1 lembrete: reminders.sent >= 1", payload3.metrics.reminders.sent >= 1, String(payload3.metrics.reminders.sent));

  console.log("\n=== Relatório mensal em PDF (ADR-080 Fase 17) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
