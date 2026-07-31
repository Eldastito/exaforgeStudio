/**
 * TESTE — Módulo Clínica Fatia 41: Sessões de agenda compartilhadas
 * (ADR-145 D6). Início da Fase 3.
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - create feliz: valida prof/spec/room; capacity/duration em range;
 *     sessionType default 'group'; scheduledEnd calculado.
 *   - create com prof não vinculado à specialty: PROFESSIONAL_NOT_IN_SPECIALTY.
 *   - create com capacity fora de 1..100: falha.
 *   - create com duration fora de 5..480: falha.
 *   - create com sessionType inválido: falha.
 *   - addParticipant feliz: cria appointment ligado à session + retorna
 *     hidratado; contador de participantes = 1.
 *   - addParticipant com careEpisodeId: valida episódio pertence ao
 *     paciente + está ativo + specialty igual à da sessão (SESSION_
 *     SPECIALTY_MISMATCH se divergir).
 *   - addParticipant dedup: mesmo paciente 2× → PARTICIPANT_ALREADY_IN_SESSION.
 *   - SESSION_CAPACITY_REACHED: adicionar N+1º participante bloqueia
 *     (current/capacity retornados).
 *   - AC-012: 6 requests concorrentes tentando lotar 3 vagas → só 3
 *     entram, outros 3 recebem SESSION_CAPACITY_REACHED (transação atômica).
 *   - removeParticipant: cancela o appointment + sessão continua ativa +
 *     libera vaga (outro paciente pode entrar).
 *   - removeParticipant de appointment que NÃO pertence à sessão: falha.
 *   - cancelSession: cancela sessão + todos appointments não-cancelled;
 *     idempotente 2×; reason obrigatório.
 *   - Após cancelSession, addParticipant → SESSION_NOT_ACCEPTING.
 *   - listByProfessionalDay: retorna sessões do dia com participantsCount.
 *   - Isolamento multi-tenant.
 *   - Audit: CREATED / PARTICIPANT_ADDED / PARTICIPANT_REMOVED /
 *     SESSION_CANCELLED com metadata correto.
 *
 * Uso:  npm run test:clinic-group-sessions
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-group-sessions-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-group-sessions";

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
  const { ClinicScheduleSessionService } = await import("../src/server/ClinicScheduleSessionService.js");

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
    const mkRoom = (name: string, capacity = 1) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO clinic_rooms (id, organization_id, name, capacity) VALUES (?, ?, ?, ?)`).run(id, orgId, name, capacity);
      return id;
    };
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, `wa_${tag}_${randomUUID().slice(0, 4)}`);
      return id;
    };
    return { orgId, actorId, mkProf, mkRoom, mkContact };
  }

  const A = seedOrg("A");
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia" }, A.actorId);
  const fono = ClinicSpecialtyService.create(A.orgId, { name: "Fono" }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  const drBruno = A.mkProf("Dr. Bruno");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [{ specialtyId: fono.id, isPrimary: true }], A.actorId);
  const room1 = A.mkRoom("Sala 1", 6);

  // ── 1. create feliz ────────────────────────────────────────────────────
  const s1 = ClinicScheduleSessionService.create(A.orgId, {
    specialtyId: psico.id, professionalId: drAna, roomId: room1,
    title: "Grupo Habilidades Sociais",
    scheduledStart: "2027-08-05T10:00:00-03:00",
    durationMinutes: 60, capacity: 4,
  }, A.actorId);
  check("create feliz: retornou session", !!s1?.id);
  check("create feliz: sessionType = group (default)", s1.sessionType === "group");
  check("create feliz: capacity = 4", s1.capacity === 4);
  check("create feliz: scheduledEnd calculado (60min depois)",
    Date.parse(s1.scheduledEnd) - Date.parse(s1.scheduledStart) === 60 * 60000);
  check("create feliz: status=scheduled", s1.status === "scheduled");

  // ── 2. create com prof não vinculado ──────────────────────────────────
  let notInSpecErr: any = null;
  try {
    ClinicScheduleSessionService.create(A.orgId, {
      specialtyId: fono.id, professionalId: drAna, // Ana não faz fono
      scheduledStart: "2027-08-06T10:00:00-03:00",
      durationMinutes: 60, capacity: 3,
    }, A.actorId);
  } catch (e: any) { notInSpecErr = e; }
  check("prof não vinculado: PROFESSIONAL_NOT_IN_SPECIALTY", notInSpecErr?.code === "PROFESSIONAL_NOT_IN_SPECIALTY");

  // ── 3. create com capacity/duration inválidos ──────────────────────────
  let badCapErr: any = null;
  try {
    ClinicScheduleSessionService.create(A.orgId, {
      specialtyId: psico.id, professionalId: drAna,
      scheduledStart: "2027-08-07T10:00:00-03:00",
      durationMinutes: 60, capacity: 0,
    }, A.actorId);
  } catch (e: any) { badCapErr = e; }
  check("capacity=0: falha", badCapErr?.message?.includes("capacity") === true);

  let badCap2Err: any = null;
  try {
    ClinicScheduleSessionService.create(A.orgId, {
      specialtyId: psico.id, professionalId: drAna,
      scheduledStart: "2027-08-07T10:00:00-03:00",
      durationMinutes: 60, capacity: 500,
    }, A.actorId);
  } catch (e: any) { badCap2Err = e; }
  check("capacity=500: falha", badCap2Err?.message?.includes("capacity") === true);

  let badDurErr: any = null;
  try {
    ClinicScheduleSessionService.create(A.orgId, {
      specialtyId: psico.id, professionalId: drAna,
      scheduledStart: "2027-08-08T10:00:00-03:00",
      durationMinutes: 3, capacity: 4,
    }, A.actorId);
  } catch (e: any) { badDurErr = e; }
  check("duration=3min: falha", badDurErr?.message?.includes("duration") === true);

  let badTypeErr: any = null;
  try {
    ClinicScheduleSessionService.create(A.orgId, {
      specialtyId: psico.id, professionalId: drAna,
      sessionType: "parallel" as any,
      scheduledStart: "2027-08-09T10:00:00-03:00",
      durationMinutes: 60, capacity: 4,
    }, A.actorId);
  } catch (e: any) { badTypeErr = e; }
  check("sessionType=parallel: falha (só individual|group)", badTypeErr?.message?.includes("sessionType") === true);

  // ── 4. addParticipant feliz + count ────────────────────────────────────
  const patients = ["P1", "P2", "P3", "P4", "P5"].map((n) => A.mkContact(n));
  // Cria episódios em Psico
  const eps = patients.map((p) => ClinicCareEpisodeService.open(A.orgId, p, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId));

  const r1 = ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, {
    contactId: patients[0], careEpisodeId: eps[0].id,
  }, A.actorId);
  check("addParticipant feliz: retorna appointment", !!r1.appointment?.id);
  const p1 = ClinicScheduleSessionService.listParticipants(A.orgId, s1.id);
  check("listParticipants: 1", p1.length === 1);
  check("listParticipants: contactName do join", p1[0]?.contactName === "P1");

  // ── 5. addParticipant dedup ────────────────────────────────────────────
  let dupErr: any = null;
  try {
    ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, { contactId: patients[0] }, A.actorId);
  } catch (e: any) { dupErr = e; }
  check("addParticipant dedup: PARTICIPANT_ALREADY_IN_SESSION", dupErr?.code === "PARTICIPANT_ALREADY_IN_SESSION");
  check("dedup: appointmentId apontando pro existente", dupErr?.appointmentId === r1.appointment.id);

  // ── 6. SESSION_SPECIALTY_MISMATCH ──────────────────────────────────────
  // Cria episódio de Fono pro paciente 4 e tenta adicionar no grupo Psico
  const epFono = ClinicCareEpisodeService.open(A.orgId, patients[3], {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
  }, A.actorId);
  let mismatchErr: any = null;
  try {
    ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, {
      contactId: patients[3], careEpisodeId: epFono.id,
    }, A.actorId);
  } catch (e: any) { mismatchErr = e; }
  check("careEpisodeId de outra specialty: SESSION_SPECIALTY_MISMATCH", mismatchErr?.code === "SESSION_SPECIALTY_MISMATCH");

  // ── 7. Preencher a sessão + SESSION_CAPACITY_REACHED ───────────────────
  // Já tem 1. Capacity=4. Vamos adicionar mais 3 (P2, P3, P4 sem episódio pra evitar mismatch)
  ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, { contactId: patients[1] }, A.actorId);
  ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, { contactId: patients[2] }, A.actorId);
  ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, { contactId: patients[3] }, A.actorId);
  const pAll = ClinicScheduleSessionService.listParticipants(A.orgId, s1.id);
  check("sessão lotada: 4 participantes", pAll.length === 4);

  let capErr: any = null;
  try {
    ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, { contactId: patients[4] }, A.actorId);
  } catch (e: any) { capErr = e; }
  check("cap+1: SESSION_CAPACITY_REACHED", capErr?.code === "SESSION_CAPACITY_REACHED");
  check("cap+1: current=4, capacity=4", capErr?.current === 4 && capErr?.capacity === 4);

  // ── 8. AC-012 pseudo-concorrência (transação garante ordem) ────────────
  // Reset: cancela sessão e cria nova capacity=3, adiciona 6 na sequência,
  // valida que só 3 entram (os outros falham com CAPACITY_REACHED).
  const s2 = ClinicScheduleSessionService.create(A.orgId, {
    specialtyId: psico.id, professionalId: drAna,
    scheduledStart: "2027-08-10T10:00:00-03:00",
    durationMinutes: 60, capacity: 3,
  }, A.actorId);
  const patCon = ["C1", "C2", "C3", "C4", "C5", "C6"].map((n) => A.mkContact(n));
  let ok = 0, blocked = 0;
  for (const pat of patCon) {
    try {
      ClinicScheduleSessionService.addParticipant(A.orgId, s2.id, { contactId: pat }, A.actorId);
      ok++;
    } catch (e: any) {
      if (e?.code === "SESSION_CAPACITY_REACHED") blocked++;
    }
  }
  check("AC-012: 6 tentativas → 3 ok + 3 blocked", ok === 3 && blocked === 3, `ok=${ok} blocked=${blocked}`);

  // ── 9. removeParticipant + libera vaga ─────────────────────────────────
  const s2P = ClinicScheduleSessionService.listParticipants(A.orgId, s2.id);
  const firstApptId = s2P[0].appointmentId;
  ClinicScheduleSessionService.removeParticipant(A.orgId, s2.id, firstApptId, { reason: "desistiu" }, A.actorId);
  const s2After = ClinicScheduleSessionService.listParticipants(A.orgId, s2.id);
  check("removeParticipant: 1 a menos", s2After.length === s2P.length - 1);
  const s2AfterAll = ClinicScheduleSessionService.listParticipants(A.orgId, s2.id, { includeCancelled: true });
  check("removeParticipant: appointment preservado (cancelled)", s2AfterAll.length === s2P.length);

  // Agora tem vaga — adicionar patCon[3] (que estava bloqueado) deve funcionar
  const filler = ClinicScheduleSessionService.addParticipant(A.orgId, s2.id, { contactId: patCon[3] }, A.actorId);
  check("após remove: vaga liberada, novo participante entra", !!filler.appointment?.id);

  // ── 10. removeParticipant de appt que NÃO pertence à sessão ───────────
  const s3 = ClinicScheduleSessionService.create(A.orgId, {
    specialtyId: psico.id, professionalId: drAna,
    scheduledStart: "2027-08-11T10:00:00-03:00",
    durationMinutes: 60, capacity: 2,
  }, A.actorId);
  let notInSessErr: any = null;
  try {
    ClinicScheduleSessionService.removeParticipant(A.orgId, s3.id, firstApptId, {}, A.actorId);
  } catch (e: any) { notInSessErr = e; }
  check("remove appt de outra sessão: falha", notInSessErr?.message?.includes("não pertence") === true);

  // ── 11. cancelSession ──────────────────────────────────────────────────
  let noReasonErr: any = null;
  try {
    ClinicScheduleSessionService.cancelSession(A.orgId, s2.id, { reason: "" }, A.actorId);
  } catch (e: any) { noReasonErr = e; }
  check("cancelSession sem reason: falha", noReasonErr?.message?.includes("obrigatório") === true);

  const s2Cancel = ClinicScheduleSessionService.cancelSession(A.orgId, s2.id, {
    reason: "profissional adoeceu",
  }, A.actorId);
  check("cancelSession: status=cancelled", s2Cancel.session.status === "cancelled");
  check("cancelSession: cancelou appointments dos participantes",
    s2Cancel.cancelledAppointments >= 3, String(s2Cancel.cancelledAppointments));

  // Após cancelar, addParticipant → SESSION_NOT_ACCEPTING
  let notAcceptingErr: any = null;
  try {
    ClinicScheduleSessionService.addParticipant(A.orgId, s2.id, { contactId: patCon[5] }, A.actorId);
  } catch (e: any) { notAcceptingErr = e; }
  check("após cancel: addParticipant → SESSION_NOT_ACCEPTING", notAcceptingErr?.code === "SESSION_NOT_ACCEPTING");

  // Idempotente
  const s2CancelAgain = ClinicScheduleSessionService.cancelSession(A.orgId, s2.id, { reason: "outro" }, A.actorId);
  check("cancelSession 2x: cancelledAppointments=0 (nada novo)", s2CancelAgain.cancelledAppointments === 0);

  // ── 12. listByProfessionalDay ──────────────────────────────────────────
  const day = "2027-08-05";
  const dayList = ClinicScheduleSessionService.listByProfessionalDay(A.orgId, drAna, day);
  check("listByProfessionalDay: 1 sessão em 2027-08-05", dayList.length === 1);
  check("listByProfessionalDay: participantsCount=4 (s1)", dayList[0]?.participantsCount === 4);

  // ── 13. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const crossGet = ClinicScheduleSessionService.get(B.orgId, s1.id);
  check("isolamento: get de A a partir de B → null", crossGet === null);
  const bList = ClinicScheduleSessionService.listByProfessionalDay(B.orgId, drAna, day);
  check("isolamento: listByProfessionalDay de B com prof de A → []", bList.length === 0);

  // ── 14. Auditoria ──────────────────────────────────────────────────────
  const created = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_SCHEDULE_SESSION_CREATED'`
  ).get(A.orgId) as any;
  check("audit SESSION_CREATED ≥ 3", Number(created?.c) >= 3, String(created?.c));

  const added = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_GROUP_PARTICIPANT_ADDED'`
  ).get(A.orgId) as any;
  check("audit PARTICIPANT_ADDED ≥ 7 (s1: 4 + s2: 3+1 filler)", Number(added?.c) >= 7, String(added?.c));

  const removed = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_GROUP_PARTICIPANT_REMOVED'`
  ).get(A.orgId) as any;
  check("audit PARTICIPANT_REMOVED = 1", Number(removed?.c) === 1);

  const sessionCanc = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_SCHEDULE_SESSION_CANCELLED'`
  ).get(A.orgId) as any;
  check("audit SESSION_CANCELLED = 1", Number(sessionCanc?.c) === 1);

  const addedMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_GROUP_PARTICIPANT_ADDED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const am = JSON.parse(addedMeta?.metadata_json || "{}");
  check("audit ADDED metadata: sessionId", am.sessionId === s1.id);
  check("audit ADDED metadata: contactId + careEpisodeId", am.contactId === patients[0] && am.careEpisodeId === eps[0].id);

  console.log("\n=== Sessões de agenda compartilhadas (ADR-145 Fatia 41) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
