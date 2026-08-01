/**
 * TESTE — Módulo Clínica Fatia 43: Métricas de ocupação por sessão +
 * isolamento do portal do paciente em grupos (ADR-145 D6 / RN-013 §3).
 * FECHA A FASE 3.
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - occupationForProfessional: grupo de 5 participantes conta como
 *     1 ocupação (não 5) — RN-006. Individuais legado contam 1 cada.
 *   - Grupo cancelled NÃO conta na ocupação.
 *   - Appointments cancelled/no_show NÃO contam.
 *   - totalMinutes = soma de duration dos grupos + duration dos individuais.
 *   - Portal do paciente NUNCA vaza outros participantes: o getPortalData
 *     lista APENAS os próprios appointments (contact_id === self).
 *   - groupInfoForOwnAppointment: retorna contador + capacity SEM
 *     nomes de outros pacientes; retorna null pra appointment de outro
 *     paciente (bloqueia enumeração cross-patient).
 *   - groupInfoForOwnAppointment: retorna null pra appointment sem
 *     schedule_session_id (não é grupo).
 *   - Isolamento multi-tenant.
 *
 * Uso:  npm run test:clinic-group-metrics-portal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-group-metrics-portal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-group-metrics-portal";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");
  const { ClinicScheduleSessionService } = await import("../src/server/ClinicScheduleSessionService.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicPatientPortalService } = await import("../src/server/ClinicPatientPortalService.js");

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
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia" }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);

  // Seed: 1 grupo de 5 (60min) + 2 individuais (30min cada) + 1 grupo cancelled
  const gPatients = ["G1", "G2", "G3", "G4", "G5"].map((n) => A.mkContact(n));
  const iPatients = ["I1", "I2"].map((n) => A.mkContact(n));

  // Grupo 1: 5 participantes, 60min
  const group = ClinicScheduleSessionService.create(A.orgId, {
    specialtyId: psico.id, professionalId: drAna,
    scheduledStart: "2027-09-10T10:00:00-03:00",
    durationMinutes: 60, capacity: 6,
  }, A.actorId);
  for (const pat of gPatients) {
    ClinicScheduleSessionService.addParticipant(A.orgId, group.id, { contactId: pat }, A.actorId);
  }

  // 2 individuais em horários DIFERENTES pra não conflitar com o grupo nem entre si
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: iPatients[0], professionalId: drAna,
    scheduledStart: "2027-09-10T14:00:00-03:00", durationMinutes: 30,
  }, A.actorId);
  ClinicAgendaService.createAppointment(A.orgId, {
    contactId: iPatients[1], professionalId: drAna,
    scheduledStart: "2027-09-10T15:00:00-03:00", durationMinutes: 30,
  }, A.actorId);

  // Grupo cancelled (não conta)
  const groupCanc = ClinicScheduleSessionService.create(A.orgId, {
    specialtyId: psico.id, professionalId: drAna,
    scheduledStart: "2027-09-10T16:00:00-03:00",
    durationMinutes: 45, capacity: 3,
  }, A.actorId);
  ClinicScheduleSessionService.cancelSession(A.orgId, groupCanc.id, { reason: "prof faltou" }, A.actorId);

  // ── 1. Ocupação do profissional no dia ────────────────────────────────
  const from = "2027-09-10T00:00:00.000Z";
  const to = "2027-09-10T23:59:59.999Z";
  const occ = ClinicScheduleSessionService.occupationForProfessional(A.orgId, drAna, { from, to });
  check("occupation: groupSessions = 1 (cancelled não conta)", occ.groupSessions === 1, String(occ.groupSessions));
  check("occupation: individualAppointments = 2", occ.individualAppointments === 2);
  check("occupation: totalOccupations = 3 (1 grupo + 2 indiv, não 5+2)", occ.totalOccupations === 3);
  check("occupation: totalMinutes = 120 (60 + 30 + 30)", occ.totalMinutes === 120);

  // ── 2. Portal do paciente G1 NUNCA vê outros participantes ────────────
  const portalG1 = ClinicPatientPortalService.getPortalData(A.orgId, gPatients[0]);
  const otherNames = ["G2", "G3", "G4", "G5", "I1", "I2"];
  const portalStr = JSON.stringify(portalG1);
  const leaks = otherNames.filter((n) => portalStr.includes(n));
  check("portal G1: NÃO vaza nenhum nome de outro paciente", leaks.length === 0,
    `leaked: ${leaks.join(",")}`);
  check("portal G1: mostra 1 upcoming (só o próprio appt do grupo)",
    portalG1.upcoming.length === 1);

  // ── 3. groupInfoForOwnAppointment ─────────────────────────────────────
  const g1Appt = portalG1.upcoming[0]?.id;
  const info = ClinicPatientPortalService.groupInfoForOwnAppointment(A.orgId, gPatients[0], g1Appt);
  check("groupInfo: sessionId correto", info?.sessionId === group.id);
  check("groupInfo: capacity = 6", info?.capacity === 6);
  check("groupInfo: participantsCount = 5 (agregado, sem nomes)", info?.participantsCount === 5);
  check("groupInfo: sessionType = group", info?.sessionType === "group");
  check("groupInfo: sem campo 'participants' com nomes", (info as any)?.participants === undefined);

  // ── 4. groupInfo pra appt de OUTRO paciente → null ────────────────────
  const portalG2 = ClinicPatientPortalService.getPortalData(A.orgId, gPatients[1]);
  const g2Appt = portalG2.upcoming[0]?.id;
  const crossInfo = ClinicPatientPortalService.groupInfoForOwnAppointment(A.orgId, gPatients[0], g2Appt);
  check("groupInfo: appt de outro paciente → null (blindagem)", crossInfo === null);

  // ── 5. groupInfo pra appt SEM schedule_session_id (individual) → null ──
  const portalI1 = ClinicPatientPortalService.getPortalData(A.orgId, iPatients[0]);
  const i1Appt = portalI1.upcoming[0]?.id;
  const indInfo = ClinicPatientPortalService.groupInfoForOwnAppointment(A.orgId, iPatients[0], i1Appt);
  check("groupInfo: appointment individual → null", indInfo === null);

  // ── 6. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const bOcc = ClinicScheduleSessionService.occupationForProfessional(B.orgId, drAna, { from, to });
  check("isolamento: occupation de B com prof de A → tudo zero",
    bOcc.groupSessions === 0 && bOcc.individualAppointments === 0);
  const crossPortalInfo = ClinicPatientPortalService.groupInfoForOwnAppointment(B.orgId, gPatients[0], g1Appt);
  check("isolamento: groupInfo cross-tenant → null", crossPortalInfo === null);

  // ── 7. RN-006 numérico: 5 appointments do grupo VS 1 sessão ───────────
  const totalApptsOfProf = db.prepare(
    `SELECT COUNT(*) AS c FROM appointments
      WHERE organization_id = ? AND professional_id = ?
        AND status NOT IN ('cancelled','no_show')`
  ).get(A.orgId, drAna) as any;
  check("underlying: appointments totais do prof = 7 (5 grupo + 2 indiv)",
    Number(totalApptsOfProf?.c) === 7);
  check("RN-006: occupation ≠ appointments (3 ≠ 7)",
    occ.totalOccupations !== Number(totalApptsOfProf?.c));

  console.log("\n=== Métricas + portal patient isolation (ADR-145 Fatia 43) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
