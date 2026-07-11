/**
 * TESTE — Módulo Clínica Fase C1: backend da Agenda Clínica (ADR-080)
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - profissional como entidade própria (com link opcional a user);
 *   - duração POR consulta SEM teto de 150 min;
 *   - conflito por PROFISSIONAL e por SALA (com override via force);
 *   - ciclo check-in → início → estender → concluir, que NUNCA exclui;
 *   - estado de permanência (over_time) derivado dos timestamps;
 *   - isolamento multi-tenant e auditoria.
 *
 * Uso:  npm run test:clinic-agenda
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-agenda-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-agenda-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, clinic_overrun_warning_minutes) VALUES (?, ?, ?, 'active', 15)`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (n: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`).run(id, orgId, channelId, n, `55${tag}${Math.floor(Math.random() * 1e8)}`);
      return id;
    };
    return { orgId, actorId: `user_${tag}`, c1: mkContact("Paciente 1"), c2: mkContact("Paciente 2"), c3: mkContact("Paciente 3") };
  }
  const A = seedOrg("A");
  const B = seedOrg("B");

  // ---- 1. Profissionais e salas ----
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana", specialty: "Fisioterapia", color: "#22c55e" }, A.actorId);
  const dr = ClinicAgendaService.createProfessional(A.orgId, { name: "Dr. Bruno" }, A.actorId);
  check("Profissional criado como entidade própria", !!dra.id && dra.name === "Dra. Ana");
  check("Vincular user inexistente falha", (() => { try { ClinicAgendaService.createProfessional(A.orgId, { name: "X", userId: "nope" }, A.actorId); return false; } catch (e: any) { return e.message.includes("Usuário"); } })());
  const sala1 = ClinicAgendaService.createRoom(A.orgId, "Sala 1", A.actorId);
  check("Sala criada", !!sala1.id);
  check("2 profissionais ativos listados", ClinicAgendaService.listProfessionals(A.orgId).length === 2);

  // ---- 2. Duração por consulta SEM teto de 150 min ----
  const long = ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c1, title: "Sessão longa", scheduledStart: "2026-08-01T13:00:00-03:00", professionalId: dra.id, roomId: sala1.id, durationMinutes: 240 }, A.actorId);
  check("Consulta de 240 min aceita (sem teto 150)", long.duration_minutes === 240);
  check("scheduled_end calculado a partir da duração", !!long.scheduled_end);

  // ---- 3. Conflito por profissional ----
  let conflictErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c2, title: "Choca profissional", scheduledStart: "2026-08-01T14:00:00-03:00", professionalId: dra.id }, A.actorId);
  } catch (e: any) { conflictErr = e; }
  check("Conflito por profissional detectado", conflictErr && conflictErr.code === "CONFLICT" && conflictErr.conflicts?.[0]?.reason === "professional");

  // Outro profissional no mesmo horário NÃO conflita.
  const ok2 = ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c2, title: "Outro prof", scheduledStart: "2026-08-01T14:00:00-03:00", professionalId: dr.id }, A.actorId);
  check("Outro profissional no mesmo horário não conflita", !!ok2.id);

  // force=true grava mesmo com conflito.
  const forced = ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c3, title: "Forçado", scheduledStart: "2026-08-01T14:30:00-03:00", professionalId: dra.id, force: true }, A.actorId);
  check("force=true agenda mesmo com conflito", !!forced.id);

  // Conflito por SALA (profissional diferente, mesma sala/horário).
  let roomConflict: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c2, title: "Choca sala", scheduledStart: "2026-08-01T15:00:00-03:00", professionalId: dr.id, roomId: sala1.id }, A.actorId);
  } catch (e: any) { roomConflict = e; }
  check("Conflito por sala detectado", roomConflict && roomConflict.conflicts?.some((c: any) => c.reason === "room"));

  // ---- 4. Ciclo de vida (nunca exclui) + permanência ----
  // Consulta curta que começou há 30 min, duração 20 → já excedeu.
  const shortId = randomUUID();
  db.prepare(`INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, status, professional_id, expected_duration_minutes, care_started_at) VALUES (?, ?, ?, 'Curta', '2026-08-02T09:00:00-03:00', 'in_care', ?, 20, datetime('now','-30 minutes'))`)
    .run(shortId, A.orgId, A.c1, dr.id);
  const hydrated = ClinicAgendaService.hydrate(A.orgId, db.prepare("SELECT * FROM appointments WHERE id = ?").get(shortId));
  check("Estado over_time derivado dos timestamps", hydrated.overrun_state === "over_time");

  // Check-in / início / estender / concluir num agendamento normal.
  const flow = ClinicAgendaService.createAppointment(A.orgId, { contactId: A.c2, title: "Fluxo", scheduledStart: "2026-08-03T10:00:00-03:00", professionalId: dr.id, durationMinutes: 30 }, A.actorId);
  ClinicAgendaService.checkIn(A.orgId, flow.id, A.actorId);
  ClinicAgendaService.startCare(A.orgId, flow.id, A.actorId);
  const extended = ClinicAgendaService.extend(A.orgId, flow.id, 15, false, A.actorId);
  check("Estender soma à duração (30 → 45), sem recriar", extended.duration_minutes === 45 && extended.id === flow.id);
  const cont = ClinicAgendaService.setContinuation(A.orgId, flow.id, "continue", A.actorId);
  check("Decisão 'continuará' registrada", cont.continuation_status === "continue");
  const done = ClinicAgendaService.complete(A.orgId, flow.id, A.actorId);
  check("Concluir marca checkout e status completed", done.status === "completed" && !!done.checkout_at);
  check("Agendamento NÃO foi excluído (segue no banco)", !!db.prepare("SELECT id FROM appointments WHERE id = ?").get(flow.id));

  // ---- 5. Agenda do dia (hidratada) ----
  const agenda = ClinicAgendaService.agendaForDay(A.orgId, "2026-08-01");
  check("Agenda do dia lista os agendamentos daquela data", agenda.appointments.length >= 3 && agenda.date === "2026-08-01");
  check("Agenda hidrata com duração e estado", agenda.appointments.every((a: any) => typeof a.duration_minutes === "number" && !!a.overrun_state));
  const byProf = ClinicAgendaService.agendaForDay(A.orgId, "2026-08-01", { professionalId: dra.id });
  check("Filtro por profissional funciona", byProf.appointments.every((a: any) => a.professional_id === dra.id));

  // ---- 6. Isolamento multi-tenant ----
  check("Org B não vê profissionais de A", ClinicAgendaService.listProfessionals(B.orgId).length === 0);
  check("Agenda de B (mesma data) vem vazia", ClinicAgendaService.agendaForDay(B.orgId, "2026-08-01").appointments.length === 0);
  check("Criar consulta em B com profissional de A falha", (() => { try { ClinicAgendaService.createAppointment(B.orgId, { contactId: B.c1, scheduledStart: "2026-08-01T10:00:00-03:00", professionalId: dra.id }, B.actorId); return false; } catch (e: any) { return e.message.includes("não encontrado"); } })());

  // ---- 7. Auditoria ----
  const audited = db.prepare("SELECT event_type FROM auth_audit_logs WHERE organization_id = ?").all(A.orgId).map((r: any) => r.event_type);
  for (const ev of ["CLINIC_PROFESSIONAL_CREATED", "CLINIC_APPOINTMENT_CREATED", "CLINIC_CHECKIN", "CLINIC_CARE_STARTED", "CLINIC_APPOINTMENT_EXTENDED", "CLINIC_APPOINTMENT_COMPLETED"]) {
    check(`Auditoria registrou ${ev}`, audited.includes(ev));
  }

  console.log("\n=== Módulo Clínica — Agenda Clínica backend (ADR-080, Fase C1) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
