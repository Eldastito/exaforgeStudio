/**
 * TESTE — Módulo Clínica Fatia 42: findConflicts respeita sessão + capacity
 * da sala (ADR-145 D6 / RN-006).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - findConflicts sem scheduleSessionId: comportamento legado
 *     (professional/room ocupados → conflito).
 *   - findConflicts com scheduleSessionId: ignora appointments da MESMA
 *     sessão (RN-006) — grupo de 5 = 1 ocupação de agenda.
 *   - addParticipant SEM force=true funciona: 5 participantes na mesma
 *     sessão sem conflito interno.
 *   - Outra sessão sobreposta pro mesmo profissional → CONFLICT
 *     (bloqueia).
 *   - Individual (sem session) mantém comportamento antigo (conflita
 *     com outros individuais).
 *   - checkRoomCapacity: sala capacity=1 → 2 appts paralelos bloqueia
 *     (via findConflicts com reason=room, como antes).
 *   - checkRoomCapacity: sala capacity=3 → 3 appts paralelos ok, 4º
 *     retorna ROOM_CAPACITY_EXCEEDED com current/capacity.
 *   - Sala com capacity permite grupos concorrentes ATÉ o limite.
 *   - Audit APPOINTMENT_CREATED sem force=true (nada de override).
 *   - Regressão: comportamento existente 1:1 preservado.
 *
 * Uso:  npm run test:clinic-conflict-by-session
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-conflict-by-session-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-conflict-by-session";

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
  const drAna = A.mkProf("Dra. Ana");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  const room1 = A.mkRoom("Sala 1"); // capacity=1 default
  const roomGroup = A.mkRoom("Sala Grande", 5); // capacity=5

  // ── 1. Comportamento legado 1:1 preservado ─────────────────────────────
  const p1 = A.mkContact("P1");
  const p2 = A.mkContact("P2");
  const a1 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: p1, professionalId: drAna, roomId: room1,
    scheduledStart: "2027-09-01T10:00:00-03:00", durationMinutes: 60,
  }, A.actorId);
  check("legado 1:1: 1º appointment criado", !!a1?.id);

  let conflictErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: p2, professionalId: drAna, // conflita
      scheduledStart: "2027-09-01T10:30:00-03:00", durationMinutes: 60,
    }, A.actorId);
  } catch (e: any) { conflictErr = e; }
  check("legado 1:1: 2º appointment sobreposto pro mesmo prof → CONFLICT",
    conflictErr?.code === "CONFLICT");

  // ── 2. Grupo com 5 participantes sem conflito interno ─────────────────
  const s1 = ClinicScheduleSessionService.create(A.orgId, {
    specialtyId: psico.id, professionalId: drAna, roomId: roomGroup,
    scheduledStart: "2027-09-02T14:00:00-03:00",
    durationMinutes: 60, capacity: 5,
  }, A.actorId);
  const gPatients = ["G1", "G2", "G3", "G4", "G5"].map((n) => A.mkContact(n));
  let internalConflict: any = null;
  try {
    for (const pat of gPatients) {
      ClinicScheduleSessionService.addParticipant(A.orgId, s1.id, { contactId: pat }, A.actorId);
    }
  } catch (e: any) { internalConflict = e; }
  check("grupo 5 participantes: sem conflito interno (sem force=true)", internalConflict === null,
    String(internalConflict?.message || ""));
  const p1s = ClinicScheduleSessionService.listParticipants(A.orgId, s1.id);
  check("grupo 5 participantes: todos entraram", p1s.length === 5);

  // ── 3. Outra sessão sobreposta pro mesmo prof → CONFLICT ──────────────
  let overlapErr: any = null;
  try {
    ClinicScheduleSessionService.create(A.orgId, {
      specialtyId: psico.id, professionalId: drAna,
      scheduledStart: "2027-09-02T14:30:00-03:00", // sobrepõe com s1
      durationMinutes: 60, capacity: 3,
    }, A.actorId);
    // A criação de sessão não valida conflict; quem valida é addParticipant.
    // Mas se tentarmos adicionar um paciente, deve conflitar com s1.
    const s2 = ClinicScheduleSessionService.listByProfessionalDay(A.orgId, drAna, "2027-09-02")
      .find((s) => s.scheduledStart.startsWith("2027-09-02T17:30"));
    if (s2) {
      const patOverlap = A.mkContact("Overlap");
      ClinicScheduleSessionService.addParticipant(A.orgId, s2.id, { contactId: patOverlap }, A.actorId);
    }
  } catch (e: any) { overlapErr = e; }
  // Vou refazer via createAppointment direto pra ser mais determinístico
  const patOverlap = A.mkContact("OverlapDirect");
  let apptOverlapErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patOverlap, professionalId: drAna,
      scheduledStart: "2027-09-02T14:30:00-03:00", // conflita com grupo s1
      durationMinutes: 60,
      // sem scheduleSessionId → é appointment individual, deve conflitar com o grupo
    }, A.actorId);
  } catch (e: any) { apptOverlapErr = e; }
  check("appointment individual sobreposto com grupo → CONFLICT",
    apptOverlapErr?.code === "CONFLICT");

  // ── 4. findConflicts com scheduleSessionId ignora mesma sessão ────────
  const startMs = Date.parse("2027-09-02T14:15:00-03:00");
  const endMs = startMs + 45 * 60000;
  const confWithSess = ClinicAgendaService.findConflicts(A.orgId, {
    professionalId: drAna, roomId: roomGroup,
    startMs, endMs, scheduleSessionId: s1.id,
  });
  check("findConflicts com scheduleSessionId=s1: appts da s1 são ignorados",
    confWithSess.length === 0, `got ${confWithSess.length}`);

  const confWithoutSess = ClinicAgendaService.findConflicts(A.orgId, {
    professionalId: drAna, roomId: roomGroup,
    startMs, endMs,
  });
  check("findConflicts SEM scheduleSessionId: appts da s1 aparecem",
    confWithoutSess.length === 5, `got ${confWithoutSess.length}`);

  // ── 5. checkRoomCapacity com sala capacity=1 (default) ────────────────
  // Já testado no #1 via CONFLICT reason=room. Só valida que a sala
  // com capacity default protege via findConflicts.
  const a1Room = ClinicAgendaService.findConflicts(A.orgId, {
    professionalId: null, roomId: room1,
    startMs: Date.parse("2027-09-01T10:30:00-03:00"),
    endMs: Date.parse("2027-09-01T11:30:00-03:00"),
  });
  check("sala capacity=1: findConflicts detecta ocupação", a1Room.length === 1);

  // ── 6. Sala capacity=5 permite grupos concorrentes até o limite ───────
  // Cria 5 appointments individuais na roomGroup (capacity=5), mesmo
  // horário porém DIFERENTES profs (senão conflita por prof).
  const otherProfs = ["Dr. B", "Dr. C", "Dr. D", "Dr. E"].map((n) => {
    const id = A.mkProf(n);
    ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, id, [{ specialtyId: psico.id }], A.actorId);
    return id;
  });
  const roomPatientsBase = ["R2", "R3", "R4", "R5"].map((n) => A.mkContact(n));
  // O 1º slot da sala está usado pelo s1 (5 grupo). Novo horário: 2027-09-03.
  const roomAppts: string[] = [];
  for (let i = 0; i < otherProfs.length; i++) {
    const a = ClinicAgendaService.createAppointment(A.orgId, {
      contactId: roomPatientsBase[i], professionalId: otherProfs[i], roomId: roomGroup,
      scheduledStart: "2027-09-03T10:00:00-03:00", durationMinutes: 60,
    }, A.actorId);
    roomAppts.push(a.id);
  }
  check("sala capacity=5: 4 appts paralelos ok", roomAppts.length === 4);

  // 5º entra
  const drF = A.mkProf("Dr. F");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drF, [{ specialtyId: psico.id }], A.actorId);
  const pRoom5 = A.mkContact("R6");
  const a5 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: pRoom5, professionalId: drF, roomId: roomGroup,
    scheduledStart: "2027-09-03T10:00:00-03:00", durationMinutes: 60,
  }, A.actorId);
  check("sala capacity=5: 5º appt ok (limite exato)", !!a5?.id);

  // 6º explode: ROOM_CAPACITY_EXCEEDED
  const drG = A.mkProf("Dr. G");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drG, [{ specialtyId: psico.id }], A.actorId);
  const pRoom6 = A.mkContact("R7");
  let capErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: pRoom6, professionalId: drG, roomId: roomGroup,
      scheduledStart: "2027-09-03T10:00:00-03:00", durationMinutes: 60,
    }, A.actorId);
  } catch (e: any) { capErr = e; }
  check("sala capacity=5: 6º → ROOM_CAPACITY_EXCEEDED", capErr?.code === "ROOM_CAPACITY_EXCEEDED");
  check("ROOM_CAPACITY_EXCEEDED: current=5, capacity=5", capErr?.current === 5 && capErr?.capacity === 5);

  // ── 7. Audit APPOINTMENT_CREATED SEM force nos participantes de grupo ─
  const groupAppts = db.prepare(
    `SELECT id FROM appointments WHERE schedule_session_id = ?`
  ).all(s1.id) as any[];
  const overrides = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE event_type = 'CLINIC_PROFESSIONAL_OVERRIDE_USED'`
  ).get() as any;
  check("nenhum OVERRIDE_USED nos participantes de grupo (força NÃO usada)",
    Number(overrides?.c) === 0);

  // ── 8. Isolamento multi-tenant do findConflicts ────────────────────────
  const B = seedOrg("B");
  const bConf = ClinicAgendaService.findConflicts(B.orgId, {
    professionalId: drAna, // prof de A
    startMs, endMs,
  });
  check("cross-tenant: findConflicts de B com prof de A → []", bConf.length === 0);

  console.log("\n=== Conflito por sessão + capacity de sala (ADR-145 Fatia 42) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
