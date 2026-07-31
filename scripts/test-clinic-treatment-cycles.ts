/**
 * TESTE — Módulo Clínica Fatia 38: Ciclos de sessões renováveis
 * (ADR-145 D4).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - create feliz: puxa default_cycle_sessions da specialty (10);
 *     cycle_number=1; status=active; noShowConsumesSession=false por default.
 *   - create com plannedSessions custom respeita valor (1..200).
 *   - create com valores fora do range → cai no default.
 *   - CYCLE_ALREADY_ACTIVE quando já existe ciclo em uso no episódio.
 *   - usage por query: derivado de appointments (completed + no_show
 *     opcional) — RN-004: nunca contador mutável.
 *   - usage: appointments 'confirmed' viram scheduled, não consumidos;
 *     availableToSchedule = planned - consumed - scheduled.
 *   - noShowConsumesSession=false: no_show não conta.
 *   - noShowConsumesSession=true: no_show conta como consumido.
 *   - transitionOnAppointmentCompleted: quando planned=1 e appt completa,
 *     ciclo vira renewal_due; audit EXHAUSTED gravado.
 *   - RN-001: episódio permanece 'active' após ciclo virar renewal_due.
 *   - renew: fecha anterior como 'renewed', cria novo com previous_cycle_id,
 *     cycle_number+1, plannedSessions herda se omitido, atômico.
 *   - renew não pode em 'renewed' ou 'cancelled'.
 *   - Renovação ilimitada: 3 renovações seguidas funcionam.
 *   - cancel: preserva histórico, exige reason, não cancela 'renewed'.
 *   - renewalQueue: retorna active com remaining<=threshold + renewal_due;
 *     inclui patientName + specialtyName + professionalName do join.
 *   - Isolamento multi-tenant.
 *   - Auditoria: CREATED / RENEWED / EXHAUSTED / CANCELLED com metadata.
 *   - addSpecialtyForPatient com createInitialCycle=true (default) cria
 *     ciclo + amarra 1º appointment (treatment_cycle_id + sequence=1).
 *
 * Uso:  npm run test:clinic-treatment-cycles
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-treatment-cycles-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-treatment-cycles-1234567890";

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
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultCycleSessions: 10 }, A.actorId);
  const fono = ClinicSpecialtyService.create(A.orgId, { name: "Fono", defaultCycleSessions: 6 }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  const drBruno = A.mkProf("Dr. Bruno");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [{ specialtyId: fono.id, isPrimary: true }], A.actorId);
  const patMaria = A.mkContact("Maria");
  const ep = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);

  // ── 1. create puxa default_cycle_sessions da specialty ────────────────
  const c1 = ClinicTreatmentCycleService.create(A.orgId, ep.id, {}, A.actorId);
  check("create: cycle_number=1", c1.cycleNumber === 1);
  check("create: plannedSessions=10 (default da Psico)", c1.plannedSessions === 10);
  check("create: status=active", c1.status === "active");
  check("create: noShowConsumesSession=false", c1.noShowConsumesSession === false);
  check("create: previous_cycle_id null", c1.previousCycleId === null);

  // ── 2. CYCLE_ALREADY_ACTIVE ────────────────────────────────────────────
  let dupErr: any = null;
  try { ClinicTreatmentCycleService.create(A.orgId, ep.id, {}, A.actorId); }
  catch (e: any) { dupErr = e; }
  check("create 2x: CYCLE_ALREADY_ACTIVE", dupErr?.code === "CYCLE_ALREADY_ACTIVE");
  check("create 2x: existingCycleId aponta pro c1", dupErr?.existingCycleId === c1.id);

  // ── 3. usage inicial (zero) ────────────────────────────────────────────
  const u0 = ClinicTreatmentCycleService.usage(A.orgId, c1.id);
  check("usage inicial: planned=10", u0.planned === 10);
  check("usage inicial: completed=0", u0.completed === 0);
  check("usage inicial: remaining=10", u0.remaining === 10);
  check("usage inicial: availableToSchedule=10", u0.availableToSchedule === 10);

  // ── 4. Cria appointments vinculados ao ciclo e testa usage ─────────────
  const appts: string[] = [];
  for (let i = 0; i < 3; i++) {
    const a = ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: ep.id,
      scheduledStart: `2026-12-${String(i + 1).padStart(2, "0")}T10:00:00-03:00`,
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
    db.prepare(`UPDATE appointments SET treatment_cycle_id = ?, cycle_sequence_number = ? WHERE id = ?`)
      .run(c1.id, i + 1, a.id);
    appts.push(a.id);
  }

  const uScheduled = ClinicTreatmentCycleService.usage(A.orgId, c1.id);
  check("usage 3 confirmed: scheduled=3", uScheduled.scheduled === 3);
  check("usage 3 confirmed: completed=0", uScheduled.completed === 0);
  check("usage 3 confirmed: remaining=10 (não consumiu)", uScheduled.remaining === 10);
  check("usage 3 confirmed: availableToSchedule=7", uScheduled.availableToSchedule === 7);

  // Completa o 1º e 2º
  ClinicAgendaService.complete(A.orgId, appts[0], A.actorId);
  ClinicAgendaService.complete(A.orgId, appts[1], A.actorId);

  const uCompleted = ClinicTreatmentCycleService.usage(A.orgId, c1.id);
  check("usage 2 completed: completed=2", uCompleted.completed === 2);
  check("usage 2 completed: remaining=8", uCompleted.remaining === 8);
  check("usage 2 completed: scheduled=1", uCompleted.scheduled === 1);

  // Marca o 3º como no_show
  db.prepare(`UPDATE appointments SET status='no_show' WHERE id = ?`).run(appts[2]);
  const uNoShow = ClinicTreatmentCycleService.usage(A.orgId, c1.id);
  check("usage no_show default (não consome): remaining=8", uNoShow.remaining === 8);
  check("usage no_show default: completed ainda 2", uNoShow.completed === 2);
  check("usage no_show default: noShowConsumed=0", uNoShow.noShowConsumed === 0);

  // Simula um ciclo com no_show consumindo
  const ep2 = ClinicCareEpisodeService.open(A.orgId, A.mkContact("Zé NoShow"), {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const cNs = ClinicTreatmentCycleService.create(A.orgId, ep2.id, {
    plannedSessions: 5, noShowConsumesSession: true,
  }, A.actorId);
  const aNs = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: ep2.contactId, careEpisodeId: ep2.id,
    scheduledStart: "2026-12-15T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 30,
  }, A.actorId);
  db.prepare(`UPDATE appointments SET treatment_cycle_id = ?, status='no_show' WHERE id = ?`).run(cNs.id, aNs.id);
  const uNsOn = ClinicTreatmentCycleService.usage(A.orgId, cNs.id);
  check("noShowConsumesSession=true: noShowConsumed=1", uNsOn.noShowConsumed === 1);
  check("noShowConsumesSession=true: remaining=4", uNsOn.remaining === 4);

  // ── 5. transitionOnAppointmentCompleted → renewal_due quando esgota ───
  const ep3 = ClinicCareEpisodeService.open(A.orgId, A.mkContact("Esgotará"), {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const cLast = ClinicTreatmentCycleService.create(A.orgId, ep3.id, { plannedSessions: 1 }, A.actorId);
  const aLast = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: ep3.contactId, careEpisodeId: ep3.id,
    scheduledStart: "2026-12-20T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 30,
  }, A.actorId);
  db.prepare(`UPDATE appointments SET treatment_cycle_id = ? WHERE id = ?`).run(cLast.id, aLast.id);

  ClinicAgendaService.complete(A.orgId, aLast.id, A.actorId);
  // Import dinâmico do hook — aguarda microtask
  await new Promise((r) => setTimeout(r, 100));
  const cLastAfter = ClinicTreatmentCycleService.get(A.orgId, cLast.id);
  check("hook: ciclo esgotado vira renewal_due", cLastAfter?.status === "renewal_due");

  const ep3After = ClinicCareEpisodeService.get(A.orgId, ep3.id);
  check("RN-001: episódio permanece 'active' após ciclo esgotado", ep3After?.status === "active");

  // ── 6. renew ───────────────────────────────────────────────────────────
  const renewed = ClinicTreatmentCycleService.renew(A.orgId, cLast.id, {}, A.actorId);
  check("renew: previous.status = renewed", renewed.previous.status === "renewed");
  check("renew: current.cycle_number = 2", renewed.current.cycleNumber === 2);
  check("renew: current.previous_cycle_id = cLast", renewed.current.previousCycleId === cLast.id);
  check("renew: current.plannedSessions herdado (1)", renewed.current.plannedSessions === 1);
  check("renew: current.status = active", renewed.current.status === "active");

  // Renovação ilimitada — vamos renovar mais 2 vezes
  const r2 = ClinicTreatmentCycleService.renew(A.orgId, renewed.current.id, { plannedSessions: 20 }, A.actorId);
  check("renew 2x: cycle_number = 3", r2.current.cycleNumber === 3);
  check("renew 2x: plannedSessions custom (20)", r2.current.plannedSessions === 20);
  const r3 = ClinicTreatmentCycleService.renew(A.orgId, r2.current.id, {}, A.actorId);
  check("renew 3x: cycle_number = 4", r3.current.cycleNumber === 4);

  // ── 7. renew de estado inválido ────────────────────────────────────────
  let cantRenewErr: any = null;
  try { ClinicTreatmentCycleService.renew(A.orgId, cLast.id, {}, A.actorId); }
  catch (e: any) { cantRenewErr = e; }
  check("renew de renewed: CYCLE_NOT_RENEWABLE", cantRenewErr?.code === "CYCLE_NOT_RENEWABLE");

  // ── 8. cancel ──────────────────────────────────────────────────────────
  const epCancel = ClinicCareEpisodeService.open(A.orgId, A.mkContact("Cancelará"), {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
  }, A.actorId);
  const cCancel = ClinicTreatmentCycleService.create(A.orgId, epCancel.id, {}, A.actorId);

  let noReasonCancel: any = null;
  try { ClinicTreatmentCycleService.cancel(A.orgId, cCancel.id, { reason: "" }, A.actorId); }
  catch (e: any) { noReasonCancel = e; }
  check("cancel sem reason: falha", noReasonCancel?.message?.includes("obrigatório") === true);

  const cancelled = ClinicTreatmentCycleService.cancel(A.orgId, cCancel.id, { reason: "abriu por engano" }, A.actorId);
  check("cancel: status=cancelled", cancelled.status === "cancelled");

  const cancelAgain = ClinicTreatmentCycleService.cancel(A.orgId, cCancel.id, { reason: "de novo" }, A.actorId);
  check("cancel 2x: idempotente", cancelAgain.status === "cancelled");

  let cantCancelRenewedErr: any = null;
  try { ClinicTreatmentCycleService.cancel(A.orgId, cLast.id, { reason: "x" }, A.actorId); }
  catch (e: any) { cantCancelRenewedErr = e; }
  check("cancel de renewed: CYCLE_NOT_CANCELLABLE", cantCancelRenewedErr?.code === "CYCLE_NOT_CANCELLABLE");

  // ── 9. renewalQueue ────────────────────────────────────────────────────
  // Setup: ep=c1 (planned=10, remaining=8, threshold 2 → NÃO entra),
  //        ep2=cNs (planned=5, remaining=4, threshold 2 → NÃO entra),
  //        ep3=r3 (novo ciclo active, remaining=default herdado),
  //        um novo com remaining <= 2 pra entrar
  const epQ = ClinicCareEpisodeService.open(A.orgId, A.mkContact("Quase acabando"), {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const cQ = ClinicTreatmentCycleService.create(A.orgId, epQ.id, { plannedSessions: 3 }, A.actorId);
  // Marca 2 como completed pra deixar remaining=1
  for (let i = 0; i < 2; i++) {
    const a = ClinicAgendaService.createAppointment(A.orgId, {
      contactId: epQ.contactId, careEpisodeId: epQ.id,
      scheduledStart: `2027-02-${String(i + 1).padStart(2, "0")}T10:00:00-03:00`,
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
    db.prepare(`UPDATE appointments SET treatment_cycle_id=?, status='completed' WHERE id=?`).run(cQ.id, a.id);
  }

  const queue = ClinicTreatmentCycleService.renewalQueue(A.orgId, { threshold: 2 });
  const inQueue = queue.map((q) => q.cycle.id);
  check("renewalQueue inclui ciclo com remaining=1", inQueue.includes(cQ.id));
  const qEntry = queue.find((q) => q.cycle.id === cQ.id);
  check("renewalQueue: patientName do join", qEntry?.patientName === "Quase acabando");
  check("renewalQueue: specialtyName", qEntry?.specialtyName === "Psicologia");
  check("renewalQueue: professionalName", qEntry?.professionalName === "Dra. Ana");
  check("renewalQueue: usage.remaining=1", qEntry?.usage.remaining === 1);
  check("renewalQueue NÃO inclui c1 (remaining=8 > 2)", !inQueue.includes(c1.id));

  // ── 10. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const bQueue = ClinicTreatmentCycleService.renewalQueue(B.orgId);
  check("isolamento: renewalQueue de B → []", bQueue.length === 0);
  const crossGet = ClinicTreatmentCycleService.get(B.orgId, c1.id);
  check("isolamento: get de A a partir de B → null", crossGet === null);

  // ── 11. addSpecialtyForPatient cria ciclo inicial ──────────────────────
  const patNew = A.mkContact("Nova Ass");
  const added = ClinicCareEpisodeService.addSpecialtyForPatient(A.orgId, patNew, {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
    firstAppointmentAt: "2027-03-05T10:00:00-03:00",
  }, A.actorId);
  check("add-specialty: initialCycle criado", added.initialCycle?.status === "active");
  check("add-specialty: initialCycle plannedSessions=6 (default Fono)", added.initialCycle?.plannedSessions === 6);
  const appt1Row = db.prepare(`SELECT treatment_cycle_id, cycle_sequence_number FROM appointments WHERE id = ?`).get(added.firstAppointment.id) as any;
  check("add-specialty: 1º appt amarrado ao ciclo", appt1Row?.treatment_cycle_id === added.initialCycle.id);
  check("add-specialty: cycle_sequence_number=1", appt1Row?.cycle_sequence_number === 1);

  // opt-out cycle
  const patNoCycle = A.mkContact("Sem Ciclo");
  const onlyEp = ClinicCareEpisodeService.addSpecialtyForPatient(A.orgId, patNoCycle, {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
    createInitialCycle: false,
  }, A.actorId);
  check("add-specialty createInitialCycle=false: sem ciclo", onlyEp.initialCycle === null);

  // ── 12. Auditoria ──────────────────────────────────────────────────────
  const created = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_CREATED'`
  ).get(A.orgId) as any;
  check("audit CREATED ≥ 5", Number(created?.c) >= 5, String(created?.c));

  const renewedCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_RENEWED'`
  ).get(A.orgId) as any;
  check("audit RENEWED = 3", Number(renewedCnt?.c) === 3, String(renewedCnt?.c));

  const exhausted = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_EXHAUSTED'`
  ).get(A.orgId) as any;
  check("audit EXHAUSTED = 1", Number(exhausted?.c) === 1, String(exhausted?.c));

  const cancelledCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_CANCELLED'`
  ).get(A.orgId) as any;
  check("audit CANCELLED = 1", Number(cancelledCnt?.c) === 1);

  const renewedMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_TREATMENT_CYCLE_RENEWED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const rm = JSON.parse(renewedMeta?.metadata_json || "{}");
  check("audit RENEWED metadata: previousCycleId", rm.previousCycleId === cLast.id);
  check("audit RENEWED metadata: newCycleNumber = 2", rm.newCycleNumber === 2);

  console.log("\n=== Ciclos de sessões renováveis (ADR-145 Fatia 38) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
