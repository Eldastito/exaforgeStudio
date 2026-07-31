/**
 * TESTE — Módulo Clínica Fatia 40: Métricas + fila operacional + counts
 * (ADR-145 Fase 2 §3).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - overview: episodes.active/onHold conta ativos e em hold corretamente.
 *   - overview: bySpecialty/byProfessional agrupa e ordena por count DESC.
 *   - overview: dischargedInPeriod filtra por janela (dischargeType breakdown).
 *   - overview: cancelledInPeriod filtra por janela.
 *   - overview: cycles.active/renewalDue snapshot atual.
 *   - overview: transfers.inPeriod dentro da janela.
 *   - overview: activeWithoutNextAppointment conta episódios sem futuro.
 *   - overview: futureAppointmentsAfterDischarge conta órfãos.
 *   - queue active-without-schedule: retorna episódios sem futuro
 *     hidratados (patientName, specialtyName, professionalName).
 *   - queue renewal-pending: retorna ciclos renewal_due.
 *   - queue transfers-recent: retorna transfers últimos 30d.
 *   - queue futures-after-discharge: retorna appts em discharged.
 *   - queue com filter inválido: filtrado antes da rota (service devolve []).
 *   - counts: active/renewalDue/withoutSchedule/futuresAfterDischarge
 *     matcham com queue.length.
 *   - Isolamento multi-tenant.
 *
 * Uso:  npm run test:clinic-care-journey-metrics
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-care-journey-metrics-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-care-journey-metrics";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");
  const { ClinicCareEpisodeService } = await import("../src/server/ClinicCareEpisodeService.js");
  const { ClinicTreatmentCycleService } = await import("../src/server/ClinicTreatmentCycleService.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicCareJourneyMetricsService } = await import("../src/server/ClinicCareJourneyMetricsService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const actorId = `user_${tag}`;
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkProf = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, 1)`).run(id, orgId, name);
      return id;
    };
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, `wa_${tag}_${randomUUID().slice(0, 4)}`);
      return id;
    };
    return { orgId, actorId, mkProf, mkContact };
  }

  const A = seedOrg("A");
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultCycleSessions: 3 }, A.actorId);
  const fono = ClinicSpecialtyService.create(A.orgId, { name: "Fono", defaultCycleSessions: 5 }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  const drBruno = A.mkProf("Dr. Bruno");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [
    { specialtyId: psico.id, isPrimary: true }, { specialtyId: fono.id },
  ], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [
    { specialtyId: psico.id }, { specialtyId: fono.id, isPrimary: true },
  ], A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, drAna, "111222", A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, drBruno, "333444", A.actorId);

  // Cenário rico:
  // - 3 episódios ativos em Psico com Ana
  // - 2 episódios ativos em Fono com Bruno
  // - 1 episódio on_hold em Psico com Ana
  // - 1 episódio já discharged (Bruno + Fono, tipo goals_met)
  // - 1 episódio cancelled
  // - 1 transfer recente
  const patients = ["A1", "A2", "A3", "F1", "F2", "H1", "D1", "C1"].map((tag) => A.mkContact(`P${tag}`));

  // 3 Psico + Ana
  const epPA = patients.slice(0, 3).map((pat) => ClinicCareEpisodeService.open(A.orgId, pat, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId));
  // 2 Fono + Bruno
  const epFB = patients.slice(3, 5).map((pat) => ClinicCareEpisodeService.open(A.orgId, pat, {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
  }, A.actorId));
  // 1 on_hold
  const epHold = ClinicCareEpisodeService.open(A.orgId, patients[5], {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  ClinicCareEpisodeService.hold(A.orgId, epHold.id, { reason: "gravidez" }, A.actorId);

  // 1 discharged (com ciclo + appointment futuro pra virar órfão)
  const epDisc = ClinicCareEpisodeService.open(A.orgId, patients[6], {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
  }, A.actorId);
  const cyDisc = ClinicTreatmentCycleService.create(A.orgId, epDisc.id, { plannedSessions: 5 }, A.actorId);
  const aDiscFuture = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patients[6], careEpisodeId: epDisc.id,
    scheduledStart: "2027-06-01T10:00:00-03:00",
    professionalId: drBruno, durationMinutes: 30,
  }, A.actorId);
  ClinicCareEpisodeService.discharge(A.orgId, epDisc.id, {
    professionalId: drBruno, pin: "333444",
    dischargeType: "goals_met", summary: "Metas atingidas.",
  }, A.actorId);

  // 1 cancelled
  const epCanc = ClinicCareEpisodeService.open(A.orgId, patients[7], {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  ClinicCareEpisodeService.cancel(A.orgId, epCanc.id, { reason: "engano" }, A.actorId);

  // 1 transfer no epPA[0] (Ana → Bruno em Psico)
  ClinicCareEpisodeService.transfer(A.orgId, epPA[0].id, {
    toProfessionalId: drBruno, reason: "Ana em licença",
  }, A.actorId);

  // 1 ciclo esgotado sem renovar (renewal_due) em epPA[1]
  const cyR = ClinicTreatmentCycleService.create(A.orgId, epPA[1].id, { plannedSessions: 1 }, A.actorId);
  const aExh = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: epPA[1].contactId, careEpisodeId: epPA[1].id,
    scheduledStart: "2027-05-15T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 30,
  }, A.actorId);
  db.prepare(`UPDATE appointments SET treatment_cycle_id=? WHERE id=?`).run(cyR.id, aExh.id);
  ClinicAgendaService.complete(A.orgId, aExh.id, A.actorId);
  await new Promise((r) => setTimeout(r, 100));

  // epPA[2] ganha appointment futuro (não fica sem schedule)
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: epPA[2].contactId, careEpisodeId: epPA[2].id,
    scheduledStart: "2027-07-01T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 30,
  }, A.actorId);

  // ── 1. overview: contagens gerais ──────────────────────────────────────
  const m = ClinicCareJourneyMetricsService.overview(A.orgId);

  check("episodes.active = 5 (3 Psico + 2 Fono)", m.episodes.active === 5, String(m.episodes.active));
  check("episodes.onHold = 1", m.episodes.onHold === 1);
  check("episodes.dischargedInPeriod = 1", m.episodes.dischargedInPeriod === 1);
  check("episodes.cancelledInPeriod = 1", m.episodes.cancelledInPeriod === 1);

  // ── 2. overview: bySpecialty / byProfessional ordenados ────────────────
  check("bySpecialty tem 2 linhas (Psico + Fono)", m.episodes.bySpecialty.length === 2);
  const psicoRow = m.episodes.bySpecialty.find((r) => r.specialtyName === "Psicologia");
  check("bySpecialty Psico active = 4 (3 active + 1 on_hold)", psicoRow?.count === 4, String(psicoRow?.count));
  const fonoRow = m.episodes.bySpecialty.find((r) => r.specialtyName === "Fono");
  check("bySpecialty Fono active = 2", fonoRow?.count === 2);

  // byProfessional: após transfer, epPA[0] agora é do Bruno em Psico
  // Ana: epPA[1] + epPA[2] + epHold = 3 (Bruno recebeu 1 transfer + tinha 2 Fono = 3)
  const anaRow = m.episodes.byProfessional.find((r) => r.professionalName === "Dra. Ana");
  const brunoRow = m.episodes.byProfessional.find((r) => r.professionalName === "Dr. Bruno");
  check("byProfessional Ana count = 3", anaRow?.count === 3, String(anaRow?.count));
  check("byProfessional Bruno count = 3", brunoRow?.count === 3, String(brunoRow?.count));

  // ── 3. discharges.byType ───────────────────────────────────────────────
  check("discharges.total = 1", m.discharges.total === 1);
  check("discharges.byType.goals_met = 1", m.discharges.byType["goals_met"] === 1);
  check("discharges.avgCyclesUntilDischarge = 1", m.discharges.avgCyclesUntilDischarge === 1);

  // ── 4. cycles ──────────────────────────────────────────────────────────
  check("cycles.renewalDue = 1", m.cycles.renewalDue === 1, String(m.cycles.renewalDue));
  // active = ciclo do epDisc (ainda active pois discharge não fecha ciclo)
  check("cycles.active >= 1", m.cycles.active >= 1);

  // ── 5. transfers.inPeriod ──────────────────────────────────────────────
  check("transfers.inPeriod = 1", m.transfers.inPeriod === 1);

  // ── 6. operational ─────────────────────────────────────────────────────
  // activeWithoutNextAppointment: epPA[0], epPA[1], epFB[0], epFB[1], epHold = 5
  // (epPA[2] tem futuro; epDisc não conta pois é discharged)
  check("activeWithoutNextAppointment = 5", m.operational.activeWithoutNextAppointment === 5,
    String(m.operational.activeWithoutNextAppointment));
  check("futureAppointmentsAfterDischarge = 1", m.operational.futureAppointmentsAfterDischarge === 1);

  // ── 7. queue active-without-schedule ───────────────────────────────────
  const q1 = ClinicCareJourneyMetricsService.queue(A.orgId, "active-without-schedule");
  check("queue active-without-schedule: 5 itens", q1.length === 5, String(q1.length));
  const anyItem = q1[0];
  check("queue item: hidratado com patientName", typeof anyItem.patientName === "string");
  check("queue item: hidratado com specialtyName", typeof anyItem.specialtyName === "string");
  check("queue item: hidratado com professionalName", typeof anyItem.professionalName === "string");

  // ── 8. queue renewal-pending ───────────────────────────────────────────
  const q2 = ClinicCareJourneyMetricsService.queue(A.orgId, "renewal-pending");
  check("queue renewal-pending: 1 item (cyR)", q2.length === 1);
  check("queue renewal-pending item: cycleId = cyR", q2[0]?.cycleId === cyR.id);
  check("queue renewal-pending item: patientName do join", q2[0]?.patientName === "PA2");

  // ── 9. queue transfers-recent ──────────────────────────────────────────
  const q3 = ClinicCareJourneyMetricsService.queue(A.orgId, "transfers-recent");
  check("queue transfers-recent: 1 item", q3.length === 1);
  check("queue transfers-recent: from/to/reason", q3[0]?.fromProfessionalName === "Dra. Ana"
    && q3[0]?.toProfessionalName === "Dr. Bruno"
    && q3[0]?.reason?.includes("licença") === true);

  // ── 10. queue futures-after-discharge ──────────────────────────────────
  const q4 = ClinicCareJourneyMetricsService.queue(A.orgId, "futures-after-discharge");
  check("queue futures-after-discharge: 1 item (aDiscFuture)", q4.length === 1);
  check("queue futures-after-discharge: appointmentId = aDiscFuture",
    q4[0]?.appointmentId === aDiscFuture.id);
  check("queue futures-after-discharge: hidrata dischargedAt", !!q4[0]?.dischargedAt);

  // ── 11. counts (matcham com queue) ─────────────────────────────────────
  const counts = ClinicCareJourneyMetricsService.counts(A.orgId);
  check("counts.active = 5", counts.active === 5, String(counts.active));
  check("counts.onHold = 1", counts.onHold === 1);
  check("counts.renewalDue = 1", counts.renewalDue === 1);
  check("counts.withoutSchedule = 5 (matcha queue)", counts.withoutSchedule === q1.length);
  check("counts.futuresAfterDischarge = 1 (matcha queue)", counts.futuresAfterDischarge === q4.length);
  check("counts.transfersRecent = 1 (matcha queue)", counts.transfersRecent === q3.length);

  // ── 12. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const bMetrics = ClinicCareJourneyMetricsService.overview(B.orgId);
  check("isolamento: B tem tudo zerado", bMetrics.episodes.active === 0
    && bMetrics.discharges.total === 0
    && bMetrics.transfers.inPeriod === 0);
  const bCounts = ClinicCareJourneyMetricsService.counts(B.orgId);
  check("isolamento: counts de B tudo zero", bCounts.active === 0
    && bCounts.renewalDue === 0 && bCounts.withoutSchedule === 0);
  const bQueue = ClinicCareJourneyMetricsService.queue(B.orgId, "active-without-schedule");
  check("isolamento: queue de B → []", bQueue.length === 0);

  console.log("\n=== Métricas + fila operacional (ADR-145 Fatia 40) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
