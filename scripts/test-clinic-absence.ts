/**
 * TESTE — Módulo Clínica Fatia 22: Bloqueio de agenda por indisponibilidade
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Criar ausência OK (vacation/conference/sick_leave/other).
 *   - Rejeita reason inválido (ABSENCE_INVALID_REASON) e endsAt<=startsAt
 *     (ABSENCE_INVALID_RANGE).
 *   - Rejeita profissional inexistente.
 *   - Notes é trimmed e clipada em 500 chars.
 *   - overlaps() detecta 4 cenários (before-only, inside, wrap, after-only)
 *     e ignora appts sem overlap.
 *   - createAppointment com professionalId DENTRO da janela devolve 409
 *     equivalente: código PROFESSIONAL_UNAVAILABLE + payload absence.
 *   - createAppointment com `force:true` bypassa (mesmo padrão CONFLICT).
 *   - createAppointment SEM professionalId NÃO é bloqueado (ausência é
 *     por profissional).
 *   - createAppointment em OUTRO profissional na mesma janela OK.
 *   - createAppointment FORA da janela OK.
 *   - remove() libera imediatamente (próxima chamada passa).
 *   - list() filtros: por professionalId, activeAt, from/to, limit.
 *   - Appointments PRÉ-existentes na janela NÃO são apagados quando a
 *     ausência é criada (integridade — gestor decide caso a caso).
 *   - Isolamento multi-tenant.
 *   - Auditoria CLINIC_ABSENCE_CREATED/REMOVED com metadata.
 *
 * Uso:  npm run test:clinic-absence
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-absence-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-absence-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicProfessionalAbsenceService } = await import("../src/server/ClinicProfessionalAbsenceService.js");

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
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Paciente") };
  }

  // === Setup base ==========================================================
  const A = seedOrg("A");
  const draAna = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  const drCarlos = ClinicAgendaService.createProfessional(A.orgId, { name: "Dr. Carlos" }, A.actorId);

  // === 1. Criar ausência OK ================================================
  const abs1 = ClinicProfessionalAbsenceService.create(A.orgId, draAna.id, {
    startsAt: "2026-09-10T00:00:00-03:00",
    endsAt: "2026-09-20T00:00:00-03:00",
    reason: "vacation",
    notes: "Férias em família.",
  }, A.actorId);
  check("ausência criada tem id", !!abs1.id);
  check("reason preservado", abs1.reason === "vacation");
  check("notes preservada", abs1.notes === "Férias em família.");

  // === 2. Validações =======================================================
  let threwRange: any = null;
  try {
    ClinicProfessionalAbsenceService.create(A.orgId, draAna.id, {
      startsAt: "2026-09-20T00:00:00-03:00",
      endsAt: "2026-09-10T00:00:00-03:00",
      reason: "vacation",
    }, A.actorId);
  } catch (e) { threwRange = e; }
  check("endsAt<=startsAt → ABSENCE_INVALID_RANGE", threwRange?.code === "ABSENCE_INVALID_RANGE", String(threwRange?.code));

  let threwReason: any = null;
  try {
    ClinicProfessionalAbsenceService.create(A.orgId, draAna.id, {
      startsAt: "2026-09-10T00:00:00-03:00",
      endsAt: "2026-09-20T00:00:00-03:00",
      reason: "hackeando" as any,
    }, A.actorId);
  } catch (e) { threwReason = e; }
  check("reason inválido → ABSENCE_INVALID_REASON", threwReason?.code === "ABSENCE_INVALID_REASON");

  let threwProf: any = null;
  try {
    ClinicProfessionalAbsenceService.create(A.orgId, "prof_inexistente", {
      startsAt: "2026-09-10T00:00:00-03:00",
      endsAt: "2026-09-20T00:00:00-03:00",
      reason: "vacation",
    }, A.actorId);
  } catch (e) { threwProf = e; }
  check("profissional inexistente rejeitado", threwProf?.message?.includes("não encontrado"));

  const longNote = "x".repeat(600);
  const absNote = ClinicProfessionalAbsenceService.create(A.orgId, drCarlos.id, {
    startsAt: "2026-10-01T00:00:00-03:00",
    endsAt: "2026-10-02T00:00:00-03:00",
    reason: "other",
    notes: `   ${longNote}   `,
  }, A.actorId);
  check("notes trim + clip 500", absNote.notes?.length === 500 && !absNote.notes?.startsWith(" "));

  // === 3. overlaps() =======================================================
  const S = Date.parse("2026-09-10T00:00:00-03:00");
  const E = Date.parse("2026-09-20T00:00:00-03:00");
  // before-only (termina antes do início) — sem overlap
  const before = ClinicProfessionalAbsenceService.overlaps(A.orgId, draAna.id, S - 3600_000 * 24, S - 1);
  check("overlaps: before-only → null", before === null);
  // inside (totalmente dentro)
  const inside = ClinicProfessionalAbsenceService.overlaps(A.orgId, draAna.id, S + 3600_000 * 24, S + 3600_000 * 48);
  check("overlaps: inside → detecta", inside?.id === abs1.id);
  // wrap (envolve a ausência)
  const wrap = ClinicProfessionalAbsenceService.overlaps(A.orgId, draAna.id, S - 3600_000 * 24, E + 3600_000 * 24);
  check("overlaps: wrap → detecta", wrap?.id === abs1.id);
  // after-only (começa depois do fim) — sem overlap
  const after = ClinicProfessionalAbsenceService.overlaps(A.orgId, draAna.id, E + 1, E + 3600_000 * 24);
  check("overlaps: after-only → null", after === null);
  // borda: começa exatamente no ends → SEM overlap (janela aberta na direita)
  const boundary = ClinicProfessionalAbsenceService.overlaps(A.orgId, draAna.id, E, E + 60_000);
  check("overlaps: começa em ends → null (borda aberta)", boundary === null);
  // outro prof, mesma janela → sem overlap
  const other = ClinicProfessionalAbsenceService.overlaps(A.orgId, drCarlos.id, S + 3600_000, S + 7200_000);
  check("overlaps: outro profissional → null", other === null);

  // === 4. createAppointment gate ===========================================
  let threwUnavail: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: A.patient,
      title: "Durante férias",
      scheduledStart: "2026-09-15T10:00:00-03:00",
      professionalId: draAna.id,
      durationMinutes: 30,
    }, A.actorId);
  } catch (e) { threwUnavail = e; }
  check("createAppointment dentro da ausência → PROFESSIONAL_UNAVAILABLE", threwUnavail?.code === "PROFESSIONAL_UNAVAILABLE", String(threwUnavail?.code));
  check("erro carrega payload absence com id", threwUnavail?.absence?.id === abs1.id);

  // force:true bypassa
  const forced = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Urgência força",
    scheduledStart: "2026-09-15T11:00:00-03:00",
    professionalId: draAna.id,
    durationMinutes: 30,
    force: true,
  }, A.actorId);
  check("force:true bypassa PROFESSIONAL_UNAVAILABLE", !!forced.id);

  // Sem professionalId → não bloqueia (ausência é por profissional)
  const noProf = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Sem prof",
    scheduledStart: "2026-09-15T12:00:00-03:00",
    durationMinutes: 30,
  }, A.actorId);
  check("createAppointment sem professionalId NÃO bloqueia", !!noProf.id);

  // Outro profissional na mesma janela → OK
  const otherProf = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Com Dr. Carlos",
    scheduledStart: "2026-09-15T13:00:00-03:00",
    professionalId: drCarlos.id,
    durationMinutes: 30,
  }, A.actorId);
  check("outro profissional na mesma janela OK", !!otherProf.id);

  // Fora da janela → OK
  const outside = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Depois das férias",
    scheduledStart: "2026-09-25T10:00:00-03:00",
    professionalId: draAna.id,
    durationMinutes: 30,
  }, A.actorId);
  check("createAppointment fora da janela OK", !!outside.id);

  // === 5. remove() libera ==================================================
  ClinicProfessionalAbsenceService.remove(A.orgId, abs1.id, A.actorId);
  const afterRemove = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Depois de remover ausência",
    scheduledStart: "2026-09-16T10:00:00-03:00",
    professionalId: draAna.id,
    durationMinutes: 30,
  }, A.actorId);
  check("remove ausência libera agenda", !!afterRemove.id);
  check("get devolve null após remove", ClinicProfessionalAbsenceService.get(A.orgId, abs1.id) === null);

  let threwRemoveFake: any = null;
  try { ClinicProfessionalAbsenceService.remove(A.orgId, randomUUID(), A.actorId); } catch (e) { threwRemoveFake = e; }
  check("remove id inexistente lança", !!threwRemoveFake);

  // === 6. list() com filtros ===============================================
  // Recria pra ter dados: 3 ausências, 2 profissionais.
  const absVac = ClinicProfessionalAbsenceService.create(A.orgId, draAna.id, {
    startsAt: "2026-11-01T00:00:00-03:00",
    endsAt: "2026-11-05T00:00:00-03:00",
    reason: "vacation",
  }, A.actorId);
  const absConf = ClinicProfessionalAbsenceService.create(A.orgId, draAna.id, {
    startsAt: "2026-11-10T00:00:00-03:00",
    endsAt: "2026-11-12T00:00:00-03:00",
    reason: "conference",
  }, A.actorId);
  const absSick = ClinicProfessionalAbsenceService.create(A.orgId, drCarlos.id, {
    startsAt: "2026-11-03T00:00:00-03:00",
    endsAt: "2026-11-04T00:00:00-03:00",
    reason: "sick_leave",
  }, A.actorId);

  const anaAll = ClinicProfessionalAbsenceService.list(A.orgId, { professionalId: draAna.id });
  check("list professionalId Ana → 2", anaAll.length === 2, String(anaAll.length));

  const activeInMiddle = ClinicProfessionalAbsenceService.list(A.orgId, {
    professionalId: draAna.id,
    activeAt: "2026-11-03T12:00:00-03:00",
  });
  check("list activeAt filtro (03 nov) → 1 (só vacation)",
    activeInMiddle.length === 1 && activeInMiddle[0].id === absVac.id, String(activeInMiddle.length));

  const win = ClinicProfessionalAbsenceService.list(A.orgId, {
    from: "2026-11-08T00:00:00-03:00",
    to: "2026-11-15T00:00:00-03:00",
  });
  check("list janela 08-15 → só conf (Ana)", win.length === 1 && win[0].id === absConf.id);

  const clipped = ClinicProfessionalAbsenceService.list(A.orgId, { limit: 2 });
  check("list limit=2 clipa", clipped.length === 2);

  // === 7. Appts pré-existentes NÃO são apagados ============================
  // Cria appt antes de nova ausência
  const preExisting = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Antes da ausência",
    scheduledStart: "2026-12-15T10:00:00-03:00",
    professionalId: drCarlos.id,
    durationMinutes: 30,
  }, A.actorId);
  ClinicProfessionalAbsenceService.create(A.orgId, drCarlos.id, {
    startsAt: "2026-12-14T00:00:00-03:00",
    endsAt: "2026-12-20T00:00:00-03:00",
    reason: "other",
  }, A.actorId);
  const still = db.prepare(`SELECT id, status FROM appointments WHERE id = ?`).get(preExisting.id) as any;
  check("appt pré-existente NÃO é apagado ao criar ausência", still?.id === preExisting.id);
  check("appt pré-existente mantém status", still?.status === "confirmed");

  // === 8. Isolamento multi-tenant ==========================================
  const B = seedOrg("B");
  const drBia = ClinicAgendaService.createProfessional(B.orgId, { name: "Dra. Bia" }, B.actorId);
  ClinicProfessionalAbsenceService.create(B.orgId, drBia.id, {
    startsAt: "2026-11-01T00:00:00-03:00",
    endsAt: "2026-11-30T00:00:00-03:00",
    reason: "vacation",
  }, B.actorId);
  const aList = ClinicProfessionalAbsenceService.list(A.orgId, { professionalId: drBia.id });
  check("org A não vê ausência de prof de B", aList.length === 0);
  const bList = ClinicProfessionalAbsenceService.list(B.orgId, { professionalId: draAna.id });
  check("org B não vê ausência de prof de A", bList.length === 0);

  // === 9. Auditoria ========================================================
  const audCreated = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ABSENCE_CREATED'`
  ).get(A.orgId) as any;
  check("CLINIC_ABSENCE_CREATED contado", Number(audCreated?.c) >= 4, String(audCreated?.c));

  const audRemoved = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ABSENCE_REMOVED'`
  ).get(A.orgId) as any;
  check("CLINIC_ABSENCE_REMOVED = 1", Number(audRemoved?.c) === 1);

  const audMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_ABSENCE_CREATED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(audMeta.metadata_json || "{}");
  check("audit metadata carrega absenceId", !!meta.absenceId);
  check("audit metadata carrega professionalId", meta.professionalId === draAna.id);
  check("audit metadata carrega reason", meta.reason === "vacation");

  console.log("\n=== Bloqueio de agenda (ADR-080 Fase 22) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
