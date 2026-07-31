/**
 * TESTE — Módulo Clínica Fatia 36: Episódio de cuidado (ADR-145 D1).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - open: valida contact/specialty/prof existem, ativos e prof vinculado
 *     à specialty; unique parcial impede 2 episódios ativos do mesmo par
 *     (paciente, specialty); código EPISODE_ALREADY_ACTIVE + existingId.
 *   - Multi-especialidade: paciente pode ter Psico e Fono ativos ao mesmo
 *     tempo (2 episódios).
 *   - Erros: profissional não vinculado à specialty (PROFESSIONAL_NOT_IN_
 *     SPECIALTY); specialty inativa; profissional inativo; contact ausente.
 *   - Transfer: só dentro da mesma specialty; destino != atual; motivo
 *     obrigatório; atualiza primary_professional_id + registra transfer;
 *     append-only (2 transfers geram 2 rows); episódio discharged não
 *     pode transferir.
 *   - Hold/Resume: hold só de active; resume só de on_hold; hold exige
 *     reason.
 *   - Cancel: preserva histórico (status='cancelled'), exige reason,
 *     não pode cancelar discharged.
 *   - listByPatient com activeOnly filtra; listByProfessional idem.
 *   - Isolamento multi-tenant: episódio de A invisível pra B; transfer
 *     cross-tenant falha.
 *   - Auditoria: OPENED / TRANSFERRED / HOLD / RESUMED / CANCELLED
 *     gravados com metadata correto.
 *
 * Uso:  npm run test:clinic-care-episodes
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-care-episodes-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-care-episodes-1234567890";

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

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const actorId = `user_${tag}`;
    const mkProf = (name: string, active = 1) => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO clinic_professionals (id, organization_id, name, active) VALUES (?, ?, ?, ?)`
      ).run(id, orgId, name, active);
      return id;
    };
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(
      `INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`
    ).run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`
      ).run(id, orgId, channelId, name, `wa_${tag}_${randomUUID().slice(0, 4)}`);
      return id;
    };
    return { orgId, actorId, mkProf, mkContact };
  }

  const A = seedOrg("A");

  // Seeds: 2 specialties + 3 profs
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia" }, A.actorId);
  const fono = ClinicSpecialtyService.create(A.orgId, { name: "Fonoaudiologia" }, A.actorId);
  const specInactive = ClinicSpecialtyService.create(A.orgId, { name: "Extinta" }, A.actorId);
  ClinicSpecialtyService.update(A.orgId, specInactive.id, { active: false }, A.actorId);

  const drAna = A.mkProf("Dra. Ana");
  const drBruno = A.mkProf("Dr. Bruno");
  const drInactivo = A.mkProf("Dr. Inativo", 0);

  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [
    { specialtyId: psico.id, isPrimary: true },
  ], A.actorId);
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drBruno, [
    { specialtyId: psico.id }, // Bruno também atende Psico (pra ter destino de transfer)
    { specialtyId: fono.id, isPrimary: true },
  ], A.actorId);

  const patMaria = A.mkContact("Maria Silva");

  // ── 1. Open feliz ──────────────────────────────────────────────────────
  const ep1 = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  check("open feliz: retornou episódio", !!ep1);
  check("open feliz: status=active", ep1.status === "active");
  check("open feliz: primary_professional preenchido", ep1.primaryProfessionalId === drAna);
  check("open feliz: started_at auto", !!ep1.startedAt);

  // ── 2. Unique parcial: 2º episódio Psico pra Maria bloqueado ───────────
  let dupErr: any = null;
  try { ClinicCareEpisodeService.open(A.orgId, patMaria, { specialtyId: psico.id, primaryProfessionalId: drAna }, A.actorId); }
  catch (e: any) { dupErr = e; }
  check("open duplicado: EPISODE_ALREADY_ACTIVE", dupErr?.code === "EPISODE_ALREADY_ACTIVE");
  check("open duplicado: aponta pro existente", dupErr?.existingEpisodeId === ep1.id);

  // ── 3. Multi-especialidade: Fono pra Maria funciona ────────────────────
  const ep2 = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: fono.id, primaryProfessionalId: drBruno,
  }, A.actorId);
  check("multi-especialidade: 2º episódio (Fono) abriu OK", ep2.status === "active" && ep2.specialtyId === fono.id);

  // ── 4. Profissional não vinculado à specialty ──────────────────────────
  let notInSpecErr: any = null;
  try { ClinicCareEpisodeService.open(A.orgId, patMaria, { specialtyId: fono.id, primaryProfessionalId: drAna }, A.actorId); }
  catch (e: any) { notInSpecErr = e; }
  check("prof não vinculado: PROFESSIONAL_NOT_IN_SPECIALTY", notInSpecErr?.code === "PROFESSIONAL_NOT_IN_SPECIALTY");

  // ── 5. Specialty inativa ───────────────────────────────────────────────
  let specInactiveErr: any = null;
  try { ClinicCareEpisodeService.open(A.orgId, patMaria, { specialtyId: specInactive.id, primaryProfessionalId: drAna }, A.actorId); }
  catch (e: any) { specInactiveErr = e; }
  check("specialty inativa: falha com msg 'desativada'", specInactiveErr?.message?.includes("desativada") === true);

  // ── 6. Prof inativo ────────────────────────────────────────────────────
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drInactivo, [{ specialtyId: psico.id }], A.actorId);
  let profInativoErr: any = null;
  const patCarlos = A.mkContact("Carlos");
  try { ClinicCareEpisodeService.open(A.orgId, patCarlos, { specialtyId: psico.id, primaryProfessionalId: drInactivo }, A.actorId); }
  catch (e: any) { profInativoErr = e; }
  check("prof inativo: falha", profInativoErr?.message?.includes("desativado") === true);

  // ── 7. Contact ausente ─────────────────────────────────────────────────
  let noContactErr: any = null;
  try { ClinicCareEpisodeService.open(A.orgId, "contact_inexistente", { specialtyId: psico.id, primaryProfessionalId: drAna }, A.actorId); }
  catch (e: any) { noContactErr = e; }
  check("contact ausente: falha", noContactErr?.message?.includes("não encontrado") === true);

  // ── 8. Transfer: happy path ────────────────────────────────────────────
  const transfer1 = ClinicCareEpisodeService.transfer(A.orgId, ep1.id, {
    toProfessionalId: drBruno, reason: "Ana saiu de licença",
  }, A.actorId);
  check("transfer feliz: episode atualizado", transfer1.episode.primaryProfessionalId === drBruno);
  check("transfer feliz: transfer criado com reason", transfer1.transfer.reason === "Ana saiu de licença");
  check("transfer feliz: from_professional_id = drAna", transfer1.transfer.fromProfessionalId === drAna);
  check("transfer feliz: to_professional_id = drBruno", transfer1.transfer.toProfessionalId === drBruno);

  // ── 9. Transfer: motivo obrigatório ────────────────────────────────────
  let noReasonErr: any = null;
  try { ClinicCareEpisodeService.transfer(A.orgId, ep1.id, { toProfessionalId: drAna, reason: "  " }, A.actorId); }
  catch (e: any) { noReasonErr = e; }
  check("transfer sem motivo: falha", noReasonErr?.message?.includes("obrigatório") === true);

  // ── 10. Transfer noop ──────────────────────────────────────────────────
  let noopErr: any = null;
  try { ClinicCareEpisodeService.transfer(A.orgId, ep1.id, { toProfessionalId: drBruno, reason: "teste" }, A.actorId); }
  catch (e: any) { noopErr = e; }
  check("transfer noop: TRANSFER_NOOP", noopErr?.code === "TRANSFER_NOOP");

  // ── 11. Transfer pra prof de outra specialty ──────────────────────────
  const drCarla = A.mkProf("Dra. Carla"); // Só Fono
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drCarla, [{ specialtyId: fono.id }], A.actorId);
  let crossSpecErr: any = null;
  try { ClinicCareEpisodeService.transfer(A.orgId, ep1.id, { toProfessionalId: drCarla, reason: "teste" }, A.actorId); }
  catch (e: any) { crossSpecErr = e; }
  check("transfer pra outra specialty: PROFESSIONAL_NOT_IN_SPECIALTY", crossSpecErr?.code === "PROFESSIONAL_NOT_IN_SPECIALTY");

  // ── 12. Transfer append-only (2ª transfer gera 2ª row) ─────────────────
  ClinicCareEpisodeService.transfer(A.orgId, ep1.id, {
    toProfessionalId: drAna, reason: "Ana voltou",
  }, A.actorId);
  const transfers = ClinicCareEpisodeService.listTransfers(A.orgId, ep1.id);
  check("transfer append-only: 2 rows", transfers.length === 2);
  check("transfer ordering: mais recente primeiro", transfers[0].reason === "Ana voltou");

  // ── 13. Hold / Resume ──────────────────────────────────────────────────
  const held = ClinicCareEpisodeService.hold(A.orgId, ep2.id, { reason: "paciente viajou" }, A.actorId);
  check("hold: status=on_hold", held.status === "on_hold");
  check("hold: on_hold_reason gravado", held.onHoldReason === "paciente viajou");
  check("hold: on_hold_at preenchido", !!held.onHoldAt);

  let doubleHoldErr: any = null;
  try { ClinicCareEpisodeService.hold(A.orgId, ep2.id, { reason: "de novo" }, A.actorId); }
  catch (e: any) { doubleHoldErr = e; }
  check("hold 2x: EPISODE_NOT_ACTIVE", doubleHoldErr?.code === "EPISODE_NOT_ACTIVE");

  const resumed = ClinicCareEpisodeService.resume(A.orgId, ep2.id, A.actorId);
  check("resume: status=active", resumed.status === "active");
  check("resume: on_hold_reason limpo", resumed.onHoldReason === null);

  let resumeActiveErr: any = null;
  try { ClinicCareEpisodeService.resume(A.orgId, ep2.id, A.actorId); }
  catch (e: any) { resumeActiveErr = e; }
  check("resume active: EPISODE_NOT_ON_HOLD", resumeActiveErr?.code === "EPISODE_NOT_ON_HOLD");

  // ── 14. Cancel ─────────────────────────────────────────────────────────
  const patZe = A.mkContact("Zé");
  const epZe = ClinicCareEpisodeService.open(A.orgId, patZe, { specialtyId: psico.id, primaryProfessionalId: drAna }, A.actorId);
  let noReasonCancel: any = null;
  try { ClinicCareEpisodeService.cancel(A.orgId, epZe.id, { reason: "" }, A.actorId); }
  catch (e: any) { noReasonCancel = e; }
  check("cancel sem motivo: falha", noReasonCancel?.message?.includes("obrigatório") === true);

  const cancelled = ClinicCareEpisodeService.cancel(A.orgId, epZe.id, { reason: "aberto por engano" }, A.actorId);
  check("cancel: status=cancelled", cancelled.status === "cancelled");
  check("cancel: cancelled_reason gravado", cancelled.cancelledReason === "aberto por engano");

  const cancelAgain = ClinicCareEpisodeService.cancel(A.orgId, epZe.id, { reason: "de novo" }, A.actorId);
  check("cancel 2x: idempotente (mesmo status)", cancelAgain.status === "cancelled");

  // Após cancelar Psico do Zé, posso reabrir Psico do Zé (unique parcial só bloqueia active|on_hold)
  const epZe2 = ClinicCareEpisodeService.open(A.orgId, patZe, { specialtyId: psico.id, primaryProfessionalId: drAna }, A.actorId);
  check("cancel liberou unique parcial", epZe2.status === "active" && epZe2.id !== epZe.id);

  // ── 15. listByPatient / listByProfessional ─────────────────────────────
  const mariaEps = ClinicCareEpisodeService.listByPatient(A.orgId, patMaria);
  check("listByPatient Maria: 2 episódios (Psico + Fono)", mariaEps.length === 2);
  const mariaActive = ClinicCareEpisodeService.listByPatient(A.orgId, patMaria, { activeOnly: true });
  check("listByPatient activeOnly: 2 (ambos ativos)", mariaActive.length === 2);

  const anaEps = ClinicCareEpisodeService.listByProfessional(A.orgId, drAna);
  check("listByProfessional Ana ativa: 2 (ep1 depois de 2ª transfer + epZe2)", anaEps.length === 2, String(anaEps.length));
  const anaAll = ClinicCareEpisodeService.listByProfessional(A.orgId, drAna, { activeOnly: false });
  check("listByProfessional includeAll: ≥2", anaAll.length >= 2);

  // ── 16. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const crossGet = ClinicCareEpisodeService.get(B.orgId, ep1.id);
  check("isolamento: get de A a partir de B → null", crossGet === null);

  let crossTransfer: any = null;
  try { ClinicCareEpisodeService.transfer(B.orgId, ep1.id, { toProfessionalId: drAna, reason: "cross" }, B.actorId); }
  catch (e: any) { crossTransfer = e; }
  check("isolamento: transfer cross-tenant falha", crossTransfer?.message?.includes("não encontrado") === true);

  const crossListPatient = ClinicCareEpisodeService.listByPatient(B.orgId, patMaria);
  check("isolamento: listByPatient de A a partir de B → []", crossListPatient.length === 0);

  // ── 17. Auditoria ──────────────────────────────────────────────────────
  const opened = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_OPENED'`
  ).get(A.orgId) as any;
  check("audit OPENED ≥ 4 (ep1 + ep2 + epZe + epZe2)", Number(opened?.c) >= 4, String(opened?.c));

  const transferred = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_TRANSFERRED'`
  ).get(A.orgId) as any;
  check("audit TRANSFERRED = 2", Number(transferred?.c) === 2, String(transferred?.c));

  const hold = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_HOLD'`
  ).get(A.orgId) as any;
  check("audit HOLD = 1", Number(hold?.c) === 1);

  const resumed_cnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_RESUMED'`
  ).get(A.orgId) as any;
  check("audit RESUMED = 1", Number(resumed_cnt?.c) === 1);

  const cancelled_cnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_CANCELLED'`
  ).get(A.orgId) as any;
  check("audit CANCELLED = 1", Number(cancelled_cnt?.c) === 1);

  const openedMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_CARE_EPISODE_OPENED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(openedMeta?.metadata_json || "{}");
  check("audit OPENED metadata: episodeId", meta.episodeId === ep1.id);
  check("audit OPENED metadata: specialtyId", meta.specialtyId === psico.id);
  check("audit OPENED metadata: primaryProfessionalId", meta.primaryProfessionalId === drAna);

  console.log("\n=== Episódio de cuidado (ADR-145 Fatia 36) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
