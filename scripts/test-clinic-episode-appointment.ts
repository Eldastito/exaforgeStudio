/**
 * TESTE — Módulo Clínica Fatia 37: Aditivos em appointments + gate
 * EPISODE_PROFESSIONAL_MISMATCH + assistente Adicionar Especialidade
 * (ADR-145 D1/D3).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Aditivos care_episode_id/specialty_id/professional_override_reason
 *     existem em appointments e ficam NULL em appointment legado (compat).
 *   - createAppointment com careEpisodeId: injeta specialty_id automaticamente;
 *     professional_id herda do episódio quando omitido; se professional_id
 *     bate com primary_professional_id, gravado limpo.
 *   - Gate EPISODE_PROFESSIONAL_MISMATCH: professional divergente sem force
 *     retorna erro com expectedProfessionalId; com force + reason grava
 *     professional_override_reason + audit CLINIC_PROFESSIONAL_OVERRIDE_USED;
 *     force sem reason falha ("motivo obrigatório").
 *   - Erros: episódio inexistente, episódio de outro paciente, episódio
 *     discharged/cancelled não aceita novo appointment.
 *   - addSpecialtyForPatient sem firstAppointmentAt: só abre episódio,
 *     firstAppointment null.
 *   - addSpecialtyForPatient com firstAppointmentAt: transação atômica
 *     abre episódio + cria appointment; duration puxa default da specialty.
 *   - addSpecialtyForPatient rollback: se createAppointment falhar por
 *     conflito, episódio NÃO persiste.
 *   - Compat legado: createAppointment sem careEpisodeId funciona igual
 *     (colunas ficam NULL).
 *   - Isolamento multi-tenant.
 *   - Auditoria: OVERRIDE_USED gravado com expected/used/reason;
 *     APPOINTMENT_CREATED metadata carrega careEpisodeId/specialtyId.
 *
 * Uso:  npm run test:clinic-episode-appointment
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-episode-appt-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-episode-appt-1234567890";

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
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const actorId = `user_${tag}`;
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(
      `INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`
    ).run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
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

  // Seeds
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultDurationMinutes: 50 }, A.actorId);
  const fono = ClinicSpecialtyService.create(A.orgId, { name: "Fonoaudiologia" }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  const drBruno = A.mkProf("Dr. Bruno");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [
    { specialtyId: psico.id },
    { specialtyId: fono.id, isPrimary: true },
  ], A.actorId);
  const patMaria = A.mkContact("Maria");

  // ── 1. Appointment LEGADO (sem careEpisodeId) funciona normalmente ────
  const legacy = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patMaria, title: "Consulta avulsa",
    scheduledStart: "2026-11-01T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 30,
  }, A.actorId);
  check("legado: criado sem episódio", !!legacy?.id);
  const legacyRow = db.prepare(`SELECT care_episode_id, specialty_id, professional_override_reason FROM appointments WHERE id = ?`).get(legacy.id) as any;
  check("legado: care_episode_id NULL", legacyRow.care_episode_id === null);
  check("legado: specialty_id NULL", legacyRow.specialty_id === null);
  check("legado: override_reason NULL", legacyRow.professional_override_reason === null);

  // ── 2. Episódio + appointment feliz ───────────────────────────────────
  const ep = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);

  const good = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patMaria, careEpisodeId: ep.id,
    scheduledStart: "2026-11-02T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 50,
  }, A.actorId);
  check("com episódio: appointment criado", !!good?.id);
  const goodRow = db.prepare(`SELECT care_episode_id, specialty_id, professional_id, professional_override_reason FROM appointments WHERE id = ?`).get(good.id) as any;
  check("com episódio: care_episode_id gravado", goodRow.care_episode_id === ep.id);
  check("com episódio: specialty_id auto-injetado do episódio", goodRow.specialty_id === psico.id);
  check("com episódio: override_reason NULL (profissional bateu)", goodRow.professional_override_reason === null);

  // ── 3. professional_id herda do episódio quando omitido ────────────────
  const noProf = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patMaria, careEpisodeId: ep.id,
    scheduledStart: "2026-11-03T10:00:00-03:00",
    durationMinutes: 30,
  }, A.actorId);
  const noProfRow = db.prepare(`SELECT professional_id FROM appointments WHERE id = ?`).get(noProf.id) as any;
  check("sem professionalId: herda do episódio", noProfRow.professional_id === drAna);

  // ── 4. Gate EPISODE_PROFESSIONAL_MISMATCH sem force ────────────────────
  let mismatchErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: ep.id,
      scheduledStart: "2026-11-04T10:00:00-03:00",
      professionalId: drBruno, durationMinutes: 30,
    }, A.actorId);
  } catch (e: any) { mismatchErr = e; }
  check("gate: EPISODE_PROFESSIONAL_MISMATCH sem force", mismatchErr?.code === "EPISODE_PROFESSIONAL_MISMATCH");
  check("gate: expectedProfessionalId aponta pro primary", mismatchErr?.expectedProfessionalId === drAna);

  // ── 5. Override com force + reason ─────────────────────────────────────
  const override = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patMaria, careEpisodeId: ep.id,
    scheduledStart: "2026-11-05T10:00:00-03:00",
    professionalId: drBruno, durationMinutes: 30,
    force: true, professionalOverrideReason: "Ana em férias — cobertura pontual do Bruno",
  }, A.actorId);
  const ovRow = db.prepare(`SELECT professional_id, professional_override_reason FROM appointments WHERE id = ?`).get(override.id) as any;
  check("override: professional_id = drBruno", ovRow.professional_id === drBruno);
  check("override: override_reason gravado", ovRow.professional_override_reason?.includes("cobertura") === true);

  // Episódio NÃO deve ter mudado (override é pontual)
  const epAfter = ClinicCareEpisodeService.get(A.orgId, ep.id);
  check("override: primary_professional_id do episódio inalterado", epAfter?.primaryProfessionalId === drAna);

  // ── 6. Override sem reason falha ───────────────────────────────────────
  let noReasonErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: ep.id,
      scheduledStart: "2026-11-06T10:00:00-03:00",
      professionalId: drBruno, durationMinutes: 30,
      force: true,
    }, A.actorId);
  } catch (e: any) { noReasonErr = e; }
  check("override sem reason: falha 'motivo obrigatório'", noReasonErr?.message?.includes("obrigatório") === true);

  // ── 7. Episódio inexistente ────────────────────────────────────────────
  let noEpErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: "ep_inexistente",
      scheduledStart: "2026-11-07T10:00:00-03:00",
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
  } catch (e: any) { noEpErr = e; }
  check("episódio inexistente: falha", noEpErr?.message?.includes("não encontrado") === true);

  // ── 8. Episódio de outro paciente ──────────────────────────────────────
  const patCarlos = A.mkContact("Carlos");
  const epCarlos = ClinicCareEpisodeService.open(A.orgId, patCarlos, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  let wrongPatErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: epCarlos.id,
      scheduledStart: "2026-11-08T10:00:00-03:00",
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
  } catch (e: any) { wrongPatErr = e; }
  check("episódio de outro paciente: falha", wrongPatErr?.message?.includes("outro paciente") === true);

  // ── 9. Episódio cancelled não aceita agendamento ───────────────────────
  const patZe = A.mkContact("Zé");
  const epZe = ClinicCareEpisodeService.open(A.orgId, patZe, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  ClinicCareEpisodeService.cancel(A.orgId, epZe.id, { reason: "engano" }, A.actorId);
  let cancelledErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patZe, careEpisodeId: epZe.id,
      scheduledStart: "2026-11-09T10:00:00-03:00",
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
  } catch (e: any) { cancelledErr = e; }
  check("episódio cancelled: EPISODE_NOT_ACTIVE", cancelledErr?.code === "EPISODE_NOT_ACTIVE");

  // ── 10. addSpecialtyForPatient sem firstAppointmentAt ──────────────────
  const patLisa = A.mkContact("Lisa");
  const only = ClinicCareEpisodeService.addSpecialtyForPatient(A.orgId, patLisa, {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
  }, A.actorId);
  check("add-specialty sem appt: episódio criado", only.episode.status === "active");
  check("add-specialty sem appt: firstAppointment null", only.firstAppointment === null);

  // ── 11. addSpecialtyForPatient com firstAppointmentAt: atômico ─────────
  const patRoberta = A.mkContact("Roberta");
  const full = ClinicCareEpisodeService.addSpecialtyForPatient(A.orgId, patRoberta, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
    firstAppointmentAt: "2026-12-01T14:00:00-03:00",
    // durationMinutes omitido → puxa default da specialty (Psico = 50)
  }, A.actorId);
  check("add-specialty com appt: episódio criado", full.episode.status === "active");
  check("add-specialty com appt: appointment criado", !!full.firstAppointment?.id);
  const fullRow = db.prepare(`SELECT expected_duration_minutes, care_episode_id, specialty_id FROM appointments WHERE id = ?`).get(full.firstAppointment.id) as any;
  check("add-specialty com appt: duração puxou default specialty (50)", fullRow.expected_duration_minutes === 50);
  check("add-specialty com appt: care_episode_id ligado", fullRow.care_episode_id === full.episode.id);
  check("add-specialty com appt: specialty_id ligado", fullRow.specialty_id === psico.id);

  // ── 12. addSpecialtyForPatient rollback em conflito ────────────────────
  // Cria conflito: ocupa 2027-01-05T10:00
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patMaria, professionalId: drAna,
    scheduledStart: "2027-01-05T10:00:00-03:00", durationMinutes: 60,
  }, A.actorId);

  const patDupla = A.mkContact("Dupla");
  let rollbackErr: any = null;
  const beforeEps = ClinicCareEpisodeService.listByPatient(A.orgId, patDupla).length;
  try {
    ClinicCareEpisodeService.addSpecialtyForPatient(A.orgId, patDupla, {
      specialtyId: psico.id, primaryProfessionalId: drAna,
      firstAppointmentAt: "2027-01-05T10:30:00-03:00", // sobrepõe com o conflict
      durationMinutes: 30,
    }, A.actorId);
  } catch (e: any) { rollbackErr = e; }
  check("rollback: erro de conflito propagado", rollbackErr?.code === "CONFLICT");
  const afterEps = ClinicCareEpisodeService.listByPatient(A.orgId, patDupla).length;
  check("rollback: episódio NÃO persistiu (transação abortada)", beforeEps === afterEps, `before=${beforeEps} after=${afterEps}`);

  // ── 13. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const bPat = B.mkContact("BPat");
  let crossErr: any = null;
  try {
    ClinicAgendaService.createAppointment(B.orgId, {
      contactId: bPat, careEpisodeId: ep.id, // ep é de A
      scheduledStart: "2026-11-10T10:00:00-03:00",
      professionalId: drAna, durationMinutes: 30,
    }, B.actorId);
  } catch (e: any) { crossErr = e; }
  check("cross-tenant: episódio de A a partir de B falha", crossErr?.message?.includes("não encontrado") === true);

  // ── 14. Auditoria ──────────────────────────────────────────────────────
  const override_cnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_PROFESSIONAL_OVERRIDE_USED'`
  ).get(A.orgId) as any;
  check("audit OVERRIDE_USED = 1", Number(override_cnt?.c) === 1, String(override_cnt?.c));

  const overrideMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_PROFESSIONAL_OVERRIDE_USED'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(A.orgId) as any;
  const om = JSON.parse(overrideMeta?.metadata_json || "{}");
  check("audit OVERRIDE metadata: expectedProfessionalId", om.expectedProfessionalId === drAna);
  check("audit OVERRIDE metadata: usedProfessionalId", om.usedProfessionalId === drBruno);
  check("audit OVERRIDE metadata: reason", om.reason?.includes("cobertura") === true);

  // APPOINTMENT_CREATED com metadata episode/specialty
  const apptCreatedMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_APPOINTMENT_CREATED'
        AND metadata_json LIKE '%"careEpisodeId":"%'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const am = JSON.parse(apptCreatedMeta?.metadata_json || "{}");
  check("audit APPOINTMENT_CREATED metadata: careEpisodeId presente", typeof am.careEpisodeId === "string" && am.careEpisodeId.length > 0);
  check("audit APPOINTMENT_CREATED metadata: specialtyId presente", typeof am.specialtyId === "string" && am.specialtyId.length > 0);

  console.log("\n=== Episódio + Appointment (ADR-145 Fatia 37) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
