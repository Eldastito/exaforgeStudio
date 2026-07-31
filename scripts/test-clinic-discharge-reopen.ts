/**
 * TESTE — Módulo Clínica Fatia 39: Alta explícita com PIN + reopen
 * (ADR-145 D5).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - discharge feliz: professional com PIN válido + dischargeType válido +
 *     summary ≥3 chars → episode.status='discharged' + discharge_signed_
 *     with_pin=1 + audit DISCHARGED com metadata (não expõe summary).
 *   - Consumir sessões NÃO dá alta (RN-007): 10/10 completed, episódio
 *     continua 'active' até discharge explícito.
 *   - PIN_REQUIRED: profissional sem PIN configurado.
 *   - PIN_INVALID: PIN errado — bump do failed_count.
 *   - PIN_LOCKED: 5 tentativas erradas → lockout, próxima chamada retorna
 *     lockedUntil sem incrementar mais.
 *   - dischargeType inválido → falha.
 *   - summary <3 chars → falha.
 *   - Episódio 'cancelled' → EPISODE_NOT_ACTIVE.
 *   - Episódio já 'discharged' → EPISODE_ALREADY_DISCHARGED com dischargedAt.
 *   - Appointments futuros NÃO cancelados após discharge (RF-070 §8).
 *   - Gate em createAppointment: novo appointment com care_episode_id de
 *     episódio discharged → EPISODE_DISCHARGED (409).
 *   - reopen feliz: episode.status volta pra 'active' + reopened_at +
 *     reopen_reason + audit REOPENED preserva previousDischargedAt/Type.
 *   - reopen precisa PIN + reason ≥3 chars.
 *   - reopen de active → EPISODE_NOT_DISCHARGED.
 *   - reopen preserva discharge history (discharged_at, discharge_type,
 *     summary — nada apagado).
 *   - Após reopen, novo appointment funciona novamente.
 *   - Isolamento multi-tenant.
 *
 * Uso:  npm run test:clinic-discharge-reopen
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-discharge-reopen-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-discharge-1234567890";

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
  const { resetPinLockout } = await import("../src/server/ClinicDocumentsService.js");

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
  const drAna = A.mkProf("Dra. Ana");
  const drSemPin = A.mkProf("Dr. Sem PIN");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drSemPin, [{ specialtyId: psico.id }], A.actorId);
  // Ana tem PIN, Sem PIN não tem
  ClinicAgendaService.setProfessionalPin(A.orgId, drAna, "123456", A.actorId);

  const patMaria = A.mkContact("Maria");
  const epMaria = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);

  // ── 1. RN-007: consumir sessões NÃO dá alta ─────────────────────────────
  const cyc = ClinicTreatmentCycleService.create(A.orgId, epMaria.id, { plannedSessions: 3 }, A.actorId);
  for (let i = 0; i < 3; i++) {
    const a = ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: epMaria.id,
      scheduledStart: `2027-01-${String(i + 1).padStart(2, "0")}T10:00:00-03:00`,
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
    db.prepare(`UPDATE appointments SET treatment_cycle_id=? WHERE id=?`).run(cyc.id, a.id);
    ClinicAgendaService.complete(A.orgId, a.id, A.actorId);
  }
  await new Promise((r) => setTimeout(r, 100));
  const epAfterConsume = ClinicCareEpisodeService.get(A.orgId, epMaria.id);
  check("RN-007: consumir 3/3 sessões NÃO fecha episódio", epAfterConsume?.status === "active");
  const cycAfter = ClinicTreatmentCycleService.get(A.orgId, cyc.id);
  check("RN-007: ciclo virou renewal_due (esgotou)", cycAfter?.status === "renewal_due");

  // ── 2. Discharge feliz ────────────────────────────────────────────────
  const discharged = ClinicCareEpisodeService.discharge(A.orgId, epMaria.id, {
    professionalId: drAna, pin: "123456",
    dischargeType: "goals_met",
    summary: "Paciente atingiu objetivos terapêuticos — evolução completa.",
  }, A.actorId);
  check("discharge feliz: status=discharged", discharged.status === "discharged");
  check("discharge feliz: discharge_type gravado", discharged.dischargeType === "goals_met");
  check("discharge feliz: signed_with_pin=true", discharged.dischargeSignedWithPin === true);
  check("discharge feliz: discharged_by_professional_id=drAna", discharged.dischargedByProfessionalId === drAna);
  check("discharge feliz: discharged_at preenchido", !!discharged.dischargedAt);
  check("discharge feliz: summary gravado", discharged.dischargeSummary?.includes("objetivos") === true);

  // ── 3. Discharge 2x → EPISODE_ALREADY_DISCHARGED ─────────────────────
  let alreadyErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epMaria.id, {
      professionalId: drAna, pin: "123456",
      dischargeType: "clinical_discharge", summary: "outra alta",
    }, A.actorId);
  } catch (e: any) { alreadyErr = e; }
  check("discharge 2x: EPISODE_ALREADY_DISCHARGED", alreadyErr?.code === "EPISODE_ALREADY_DISCHARGED");
  check("discharge 2x: expõe dischargedAt", !!alreadyErr?.dischargedAt);

  // ── 4. Novo appointment em episódio discharged → EPISODE_DISCHARGED ──
  let apptDischargedErr: any = null;
  try {
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: patMaria, careEpisodeId: epMaria.id,
      scheduledStart: "2027-02-01T10:00:00-03:00",
      professionalId: drAna, durationMinutes: 30,
    }, A.actorId);
  } catch (e: any) { apptDischargedErr = e; }
  check("novo appt em discharged: EPISODE_DISCHARGED", apptDischargedErr?.code === "EPISODE_DISCHARGED");

  // ── 5. Appointments futuros NÃO cancelados (RF-070 §8) ────────────────
  // Cria appt futuro ANTES do discharge de outro episódio pra checar
  const patZe = A.mkContact("Zé");
  const epZe = ClinicCareEpisodeService.open(A.orgId, patZe, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const futureAppt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patZe, careEpisodeId: epZe.id,
    scheduledStart: "2027-03-01T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 30,
  }, A.actorId);
  ClinicCareEpisodeService.discharge(A.orgId, epZe.id, {
    professionalId: drAna, pin: "123456",
    dischargeType: "patient_request", summary: "Paciente pediu encerramento.",
  }, A.actorId);
  const futureAfter = db.prepare(`SELECT status FROM appointments WHERE id = ?`).get(futureAppt.id) as any;
  check("RF-070 §8: appointment futuro NÃO cancelado pela alta", futureAfter?.status === "confirmed");

  // ── 6. PIN_REQUIRED (prof sem PIN) ──────────────────────────────────────
  const patCarlos = A.mkContact("Carlos");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drSemPin, [{ specialtyId: psico.id }], A.actorId);
  const epCarlos = ClinicCareEpisodeService.open(A.orgId, patCarlos, {
    specialtyId: psico.id, primaryProfessionalId: drSemPin,
  }, A.actorId);
  let noPinErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epCarlos.id, {
      professionalId: drSemPin, pin: "any",
      dischargeType: "clinical_discharge", summary: "teste",
    }, A.actorId);
  } catch (e: any) { noPinErr = e; }
  check("prof sem PIN: PIN_REQUIRED", noPinErr?.code === "PIN_REQUIRED");

  // ── 7. PIN_INVALID + PIN_LOCKED após 5 tentativas ─────────────────────
  const patLisa = A.mkContact("Lisa");
  const epLisa = ClinicCareEpisodeService.open(A.orgId, patLisa, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);

  resetPinLockout(A.orgId, drAna, A.actorId);
  const drAna2 = A.mkProf("Dra. Ana2 (isolado)");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna2, [{ specialtyId: psico.id }], A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, drAna2, "999888", A.actorId);
  const patLisa2 = A.mkContact("Lisa2");
  const epLisa2 = ClinicCareEpisodeService.open(A.orgId, patLisa2, {
    specialtyId: psico.id, primaryProfessionalId: drAna2,
  }, A.actorId);

  let invalidErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epLisa2.id, {
      professionalId: drAna2, pin: "wrong1",
      dischargeType: "other", summary: "teste PIN wrong",
    }, A.actorId);
  } catch (e: any) { invalidErr = e; }
  check("PIN errado: PIN_INVALID", invalidErr?.code === "PIN_INVALID");

  // 4 tentativas mais → total 5 → lockout na 5ª
  let lockErr: any = null;
  for (let i = 2; i <= 5; i++) {
    try {
      ClinicCareEpisodeService.discharge(A.orgId, epLisa2.id, {
        professionalId: drAna2, pin: `wrong${i}`,
        dischargeType: "other", summary: "teste PIN",
      }, A.actorId);
    } catch (e: any) { lockErr = e; }
  }
  check("5ª tentativa: PIN_LOCKED", lockErr?.code === "PIN_LOCKED");
  check("PIN_LOCKED: expõe until", !!lockErr?.until);

  // 6ª tentativa (PIN certo!) — ainda bloqueado
  let stillLockedErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epLisa2.id, {
      professionalId: drAna2, pin: "999888",
      dischargeType: "other", summary: "teste PIN certo mas bloqueado",
    }, A.actorId);
  } catch (e: any) { stillLockedErr = e; }
  check("PIN correto durante lockout: ainda PIN_LOCKED", stillLockedErr?.code === "PIN_LOCKED");

  // ── 8. dischargeType inválido ─────────────────────────────────────────
  let badTypeErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epLisa.id, {
      professionalId: drAna, pin: "123456",
      dischargeType: "invalido" as any, summary: "teste",
    }, A.actorId);
  } catch (e: any) { badTypeErr = e; }
  check("dischargeType inválido: falha com msg 'inválido'", badTypeErr?.message?.includes("inválido") === true);

  // ── 9. summary <3 chars ───────────────────────────────────────────────
  let shortSummaryErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epLisa.id, {
      professionalId: drAna, pin: "123456",
      dischargeType: "clinical_discharge", summary: "ok",
    }, A.actorId);
  } catch (e: any) { shortSummaryErr = e; }
  check("summary <3 chars: falha", shortSummaryErr?.message?.includes("mínimo") === true);

  // ── 10. Episódio cancelled → EPISODE_NOT_ACTIVE ───────────────────────
  const patCanc = A.mkContact("Cancelado");
  const epCanc = ClinicCareEpisodeService.open(A.orgId, patCanc, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  ClinicCareEpisodeService.cancel(A.orgId, epCanc.id, { reason: "engano" }, A.actorId);
  let cancNotActiveErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(A.orgId, epCanc.id, {
      professionalId: drAna, pin: "123456",
      dischargeType: "other", summary: "teste em cancelled",
    }, A.actorId);
  } catch (e: any) { cancNotActiveErr = e; }
  check("cancelled → EPISODE_NOT_ACTIVE", cancNotActiveErr?.code === "EPISODE_NOT_ACTIVE");

  // ── 11. Reopen feliz ──────────────────────────────────────────────────
  const reopened = ClinicCareEpisodeService.reopen(A.orgId, epMaria.id, {
    professionalId: drAna, pin: "123456",
    reason: "Paciente voltou com nova queixa clínica.",
  }, A.actorId);
  check("reopen feliz: status=active", reopened.status === "active");
  check("reopen feliz: reopened_at preenchido", !!reopened.reopenedAt);
  check("reopen feliz: reopen_reason gravado", reopened.reopenReason?.includes("voltou") === true);
  check("reopen preserva discharge history (discharged_at)", !!reopened.dischargedAt);
  check("reopen preserva discharge history (discharge_type)", reopened.dischargeType === "goals_met");
  check("reopen preserva discharge history (summary)", reopened.dischargeSummary?.includes("objetivos") === true);
  check("reopen preserva signed_with_pin", reopened.dischargeSignedWithPin === true);

  // Após reopen, novo appointment funciona
  const apptAfterReopen = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: patMaria, careEpisodeId: epMaria.id,
    scheduledStart: "2027-04-01T10:00:00-03:00",
    professionalId: drAna, durationMinutes: 30,
  }, A.actorId);
  check("após reopen: novo appointment funciona", !!apptAfterReopen?.id);

  // ── 12. Reopen precisa PIN + reason ──────────────────────────────────
  // epZe ainda está discharged — usa ele pra testar reason obrigatório
  let noReasonReopenErr: any = null;
  try {
    ClinicCareEpisodeService.reopen(A.orgId, epZe.id, {
      professionalId: drAna, pin: "123456", reason: "",
    }, A.actorId);
  } catch (e: any) { noReasonReopenErr = e; }
  check("reopen sem reason: falha", noReasonReopenErr?.message?.includes("obrigatório") === true);

  // ── 13. Reopen de active → EPISODE_NOT_DISCHARGED ─────────────────────
  let notDischargedErr: any = null;
  try {
    ClinicCareEpisodeService.reopen(A.orgId, epLisa.id, {
      professionalId: drAna, pin: "123456", reason: "teste",
    }, A.actorId);
  } catch (e: any) { notDischargedErr = e; }
  check("reopen de active: EPISODE_NOT_DISCHARGED", notDischargedErr?.code === "EPISODE_NOT_DISCHARGED");

  // ── 14. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const bProf = B.mkProf("B Ana");
  const bSpec = ClinicSpecialtyService.create(B.orgId, { name: "Psi B" }, B.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(B.orgId, bProf, [{ specialtyId: bSpec.id }], B.actorId);
  ClinicAgendaService.setProfessionalPin(B.orgId, bProf, "654321", B.actorId);

  let crossErr: any = null;
  try {
    ClinicCareEpisodeService.discharge(B.orgId, epMaria.id, {
      professionalId: bProf, pin: "654321",
      dischargeType: "other", summary: "cross-tenant tentativa",
    }, B.actorId);
  } catch (e: any) { crossErr = e; }
  check("cross-tenant discharge: falha 'não encontrado'", crossErr?.message?.includes("não encontrado") === true);

  // ── 15. Auditoria ──────────────────────────────────────────────────────
  const disc = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_DISCHARGED'`
  ).get(A.orgId) as any;
  check("audit DISCHARGED ≥ 2 (Maria + Zé)", Number(disc?.c) >= 2, String(disc?.c));

  const reop = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_REOPENED'`
  ).get(A.orgId) as any;
  check("audit REOPENED = 1", Number(reop?.c) === 1);

  const dMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_DISCHARGED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const dm = JSON.parse(dMeta?.metadata_json || "{}");
  check("audit DISCHARGED metadata: dischargeType", dm.dischargeType === "goals_met");
  check("audit DISCHARGED metadata: signedWithPin=true", dm.signedWithPin === true);
  check("audit DISCHARGED metadata: summaryLength (não expõe summary)", typeof dm.summaryLength === "number" && dm.summaryLength > 0);
  check("audit DISCHARGED metadata NÃO tem summary raw", dm.summary === undefined);

  const rMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_REOPENED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const rm = JSON.parse(rMeta?.metadata_json || "{}");
  check("audit REOPENED metadata: previousDischargeType", rm.previousDischargeType === "goals_met");
  check("audit REOPENED metadata: reasonLength", typeof rm.reasonLength === "number" && rm.reasonLength > 0);

  console.log("\n=== Alta explícita com PIN + reopen (ADR-145 Fatia 39) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
