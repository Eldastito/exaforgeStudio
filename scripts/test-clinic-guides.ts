/**
 * TESTE — Módulo Clínica Fatia 44: Guia da recepção polimorfa
 * (ADR-145 D7). Início da Fase 4.
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - create rascunho pra cada um dos 3 tipos (TISS, referral, medical_order)
 *     — validações "leves" (só formato) passam mesmo com campos incompletos.
 *   - internal_number segue série própria por tipo (TISS-000001, REF-000001,
 *     PM-000001; TISS-000002 no 2º TISS).
 *   - update só em draft; guia issued rejeita PATCH com GUIDE_NOT_EDITABLE.
 *   - issue com validação polimorfa por tipo:
 *     * TISS sem operatorId/procedureId/totalSessions → falha.
 *     * Referral sem fields.referralSpecialty/referralReason → falha.
 *     * MedicalOrder sem fields.items ou item sem description → falha.
 *   - issue feliz: status='issued', issued_at preenchido, document_hash
 *     canônico calculado, snapshot rico congelado com paciente/negócio/prof.
 *   - documentHash reprodutível: recalcular do snapshot atual = mesmo hash.
 *   - Snapshot imutável: renomear paciente após issue NÃO muda snapshot.
 *   - GUIDE_NOT_ISSUABLE se tentar emitir 2ª vez.
 *   - cancel de draft e issued: preservam histórico + reason obrigatório.
 *   - cancel de cancelled → idempotente.
 *   - Erros: contactId inexistente; episódio de outro paciente; ciclo
 *     de outro episódio.
 *   - Isolamento multi-tenant.
 *   - Auditoria: CREATED / UPDATED / ISSUED / CANCELLED com metadata.
 *
 * Uso:  npm run test:clinic-guides
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-guides-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-guides";

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
  const { ClinicGuideService } = await import("../src/server/ClinicGuideService.js");
  const { computeDocumentHash } = await import("../src/server/ClinicDocumentsService.js");

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
      db.prepare(`INSERT INTO clinic_professionals (id, organization_id, name, active, council, registration_number) VALUES (?, ?, ?, 1, 'CRM/SP', '12345')`).run(id, orgId, name);
      return id;
    };
    const mkContact = (name: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, `wa_${tag}_${randomUUID().slice(0, 4)}`);
      return id;
    };
    const mkOperator = (name: string) => {
      const id = randomUUID();
      // Operadora — se existir tabela health_plan_operators, insere ali;
      // senão só usa o id livre (o service não valida existência FK).
      try { db.prepare(`INSERT INTO health_plan_operators (id, organization_id, name) VALUES (?, ?, ?)`).run(id, orgId, name); } catch {}
      return id;
    };
    const mkProcedure = (name: string) => {
      const id = randomUUID();
      try { db.prepare(`INSERT INTO health_plan_procedures (id, organization_id, name) VALUES (?, ?, ?)`).run(id, orgId, name); } catch {}
      return id;
    };
    return { orgId, actorId, mkProf, mkContact, mkOperator, mkProcedure };
  }

  const A = seedOrg("A");
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia", defaultCycleSessions: 10 }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  const patMaria = A.mkContact("Maria");
  // patient_profile pra snapshot testar cpf/carteirinha
  db.prepare(`INSERT INTO patient_profiles (id, organization_id, contact_id, cpf, insurance_card_number) VALUES (?, ?, ?, '123.456.789-00', 'CARD-123')`)
    .run(randomUUID(), A.orgId, patMaria);

  const ep = ClinicCareEpisodeService.open(A.orgId, patMaria, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  const cy = ClinicTreatmentCycleService.create(A.orgId, ep.id, { plannedSessions: 10 }, A.actorId);
  const operator = A.mkOperator("Unimed");
  const procedure = A.mkProcedure("Sessão psi 50min");

  // ── 1. create rascunho pra cada tipo + série independente ─────────────
  const g1 = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria,
    episodeId: ep.id, cycleId: cy.id,
    operatorId: operator, procedureId: procedure,
    professionalId: drAna, totalSessions: 10,
  }, A.actorId);
  check("create TISS: status=draft", g1.status === "draft");
  check("create TISS: internalNumber = TISS-000001", g1.internalNumber === "TISS-000001", g1.internalNumber);

  const g2 = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria,
  }, A.actorId);
  check("create TISS 2º: internalNumber = TISS-000002", g2.internalNumber === "TISS-000002", g2.internalNumber);

  const gRef = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patMaria,
    professionalId: drAna,
    fields: { referralSpecialty: "Neurologia", referralReason: "Suspeita cefaleia crônica" },
  }, A.actorId);
  check("create referral: internalNumber = REF-000001 (série própria)", gRef.internalNumber === "REF-000001", gRef.internalNumber);

  const gPm = ClinicGuideService.create(A.orgId, {
    guideType: "medical_order", contactId: patMaria,
    professionalId: drAna,
    fields: { items: [{ description: "Hemograma" }, { description: "TSH" }] },
  }, A.actorId);
  check("create medical_order: internalNumber = PM-000001 (série própria)", gPm.internalNumber === "PM-000001", gPm.internalNumber);

  // ── 2. update só em draft ──────────────────────────────────────────────
  const g1Upd = ClinicGuideService.update(A.orgId, g1.id, { totalSessions: 15 }, A.actorId);
  check("update draft: totalSessions atualizado", g1Upd.totalSessions === 15);

  // ── 3. Validação totalSessions fora do range ──────────────────────────
  let badTotErr: any = null;
  try { ClinicGuideService.update(A.orgId, g1.id, { totalSessions: 999 }, A.actorId); }
  catch (e: any) { badTotErr = e; }
  check("update totalSessions=999: falha", badTotErr?.message?.includes("totalSessions") === true);

  // ── 4. issue com validação polimorfa: TISS sem procedureId ─────────────
  const gBadTiss = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria,
    operatorId: operator, // sem procedureId nem totalSessions
  }, A.actorId);
  let tissIssueErr: any = null;
  try { ClinicGuideService.issue(A.orgId, gBadTiss.id, A.actorId); }
  catch (e: any) { tissIssueErr = e; }
  check("issue TISS sem procedureId: falha", tissIssueErr?.message?.includes("procedureId") === true);

  // ── 5. issue referral sem fields.referralSpecialty ────────────────────
  const gBadRef = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patMaria,
    fields: { referralReason: "só isso" }, // sem specialty
  }, A.actorId);
  let refIssueErr: any = null;
  try { ClinicGuideService.issue(A.orgId, gBadRef.id, A.actorId); }
  catch (e: any) { refIssueErr = e; }
  check("issue referral sem referralSpecialty: falha", refIssueErr?.message?.includes("referralSpecialty") === true);

  // ── 6. issue medical_order sem items ──────────────────────────────────
  const gBadPm = ClinicGuideService.create(A.orgId, {
    guideType: "medical_order", contactId: patMaria,
    fields: { items: [] },
  }, A.actorId);
  let pmIssueErr: any = null;
  try { ClinicGuideService.issue(A.orgId, gBadPm.id, A.actorId); }
  catch (e: any) { pmIssueErr = e; }
  check("issue medical_order sem items: falha", pmIssueErr?.message?.includes("items") === true);

  // item sem description
  const gBadPm2 = ClinicGuideService.create(A.orgId, {
    guideType: "medical_order", contactId: patMaria,
    fields: { items: [{ description: "Hemograma" }, { description: "" }] },
  }, A.actorId);
  let pmIssueErr2: any = null;
  try { ClinicGuideService.issue(A.orgId, gBadPm2.id, A.actorId); }
  catch (e: any) { pmIssueErr2 = e; }
  check("issue medical_order com item vazio: falha", pmIssueErr2?.message?.includes("description") === true);

  // ── 7. issue feliz (TISS completa) ────────────────────────────────────
  const issuedTiss = ClinicGuideService.issue(A.orgId, g1.id, A.actorId);
  check("issue TISS feliz: status=issued", issuedTiss.status === "issued");
  check("issue TISS: issued_at preenchido", !!issuedTiss.issuedAt);
  check("issue TISS: document_hash calculado (64 hex)", (issuedTiss.documentHash || "").length === 64);
  check("issue TISS: snapshot rico com paciente Maria", issuedTiss.snapshotJson?.patient?.name === "Maria");
  check("issue TISS: snapshot com CPF do patient_profile", issuedTiss.snapshotJson?.patient?.cpf === "123.456.789-00");
  check("issue TISS: snapshot com carteirinha", issuedTiss.snapshotJson?.patient?.insuranceCardNumber === "CARD-123");
  check("issue TISS: snapshot com business", issuedTiss.snapshotJson?.business?.name === "Clínica A");
  check("issue TISS: snapshot com professional", issuedTiss.snapshotJson?.professional?.name === "Dra. Ana");
  check("issue TISS: snapshot com council", issuedTiss.snapshotJson?.professional?.council === "CRM/SP");
  check("issue TISS: snapshot com internalNumber TISS-000001", issuedTiss.snapshotJson?.internalNumber === "TISS-000001");

  // ── 8. documentHash reprodutível ──────────────────────────────────────
  const recomputed = computeDocumentHash(issuedTiss.snapshotJson);
  check("documentHash reprodutível a partir do snapshot", recomputed === issuedTiss.documentHash);

  // ── 9. Snapshot imutável: renomear paciente não muda snapshot ─────────
  db.prepare(`UPDATE contacts SET name = 'Maria RENOMEADA' WHERE id = ?`).run(patMaria);
  const reloaded = ClinicGuideService.get(A.orgId, g1.id);
  check("snapshot imutável: patient.name continua 'Maria'", reloaded?.snapshotJson?.patient?.name === "Maria");
  const rehash = computeDocumentHash(reloaded!.snapshotJson);
  check("snapshot imutável: hash não mudou após rename do contact", rehash === issuedTiss.documentHash);
  // Restaura
  db.prepare(`UPDATE contacts SET name = 'Maria' WHERE id = ?`).run(patMaria);

  // ── 10. Emitir 2× → GUIDE_NOT_ISSUABLE ────────────────────────────────
  let alreadyIssuedErr: any = null;
  try { ClinicGuideService.issue(A.orgId, g1.id, A.actorId); }
  catch (e: any) { alreadyIssuedErr = e; }
  check("issue 2x: GUIDE_NOT_ISSUABLE", alreadyIssuedErr?.code === "GUIDE_NOT_ISSUABLE");

  // ── 11. update em issued → GUIDE_NOT_EDITABLE ─────────────────────────
  let notEditableErr: any = null;
  try { ClinicGuideService.update(A.orgId, g1.id, { totalSessions: 20 }, A.actorId); }
  catch (e: any) { notEditableErr = e; }
  check("update em issued: GUIDE_NOT_EDITABLE", notEditableErr?.code === "GUIDE_NOT_EDITABLE");

  // ── 12. cancel de draft ───────────────────────────────────────────────
  const cancelDraft = ClinicGuideService.cancel(A.orgId, g2.id, { reason: "abriu por engano" }, A.actorId);
  check("cancel draft: status=cancelled", cancelDraft.status === "cancelled");
  check("cancel draft: cancelled_reason gravado", cancelDraft.cancelledReason === "abriu por engano");

  // cancel sem reason
  let noReasonErr: any = null;
  try { ClinicGuideService.cancel(A.orgId, gRef.id, { reason: "" }, A.actorId); }
  catch (e: any) { noReasonErr = e; }
  check("cancel sem reason: falha", noReasonErr?.message?.includes("obrigatório") === true);

  // cancel de issued (preserva snapshot)
  const cancelIssued = ClinicGuideService.cancel(A.orgId, g1.id, { reason: "operadora reprovou" }, A.actorId);
  check("cancel issued: status=cancelled", cancelIssued.status === "cancelled");
  check("cancel issued: snapshot preservado", cancelIssued.snapshotJson?.patient?.name === "Maria");
  check("cancel issued: document_hash preservado", cancelIssued.documentHash === issuedTiss.documentHash);

  // idempotente
  const cancelAgain = ClinicGuideService.cancel(A.orgId, g1.id, { reason: "de novo" }, A.actorId);
  check("cancel idempotente: continua cancelled", cancelAgain.status === "cancelled");

  // ── 13. Erros de vínculo ──────────────────────────────────────────────
  let noContactErr: any = null;
  try {
    ClinicGuideService.create(A.orgId, {
      guideType: "referral", contactId: "inexistente",
      fields: { referralSpecialty: "X", referralReason: "test" },
    }, A.actorId);
  } catch (e: any) { noContactErr = e; }
  check("create com contactId inexistente: falha", noContactErr?.message?.includes("não encontrado") === true);

  // Episódio de outro paciente
  const patZe = A.mkContact("Zé");
  const epZe = ClinicCareEpisodeService.open(A.orgId, patZe, {
    specialtyId: psico.id, primaryProfessionalId: drAna,
  }, A.actorId);
  let wrongPatErr: any = null;
  try {
    ClinicGuideService.create(A.orgId, {
      guideType: "referral", contactId: patMaria, episodeId: epZe.id,
      fields: { referralSpecialty: "X", referralReason: "test" },
    }, A.actorId);
  } catch (e: any) { wrongPatErr = e; }
  check("episódio de outro paciente: falha", wrongPatErr?.message?.includes("outro paciente") === true);

  // ── 14. list com filtros ───────────────────────────────────────────────
  const allA = ClinicGuideService.list(A.orgId);
  const patAll = ClinicGuideService.list(A.orgId, { contactId: patMaria });
  const tissOnly = ClinicGuideService.list(A.orgId, { guideType: "tiss_authorization" });
  check("list por contact: ≥ 6 guias", patAll.length >= 6, String(patAll.length));
  check("list por type=tiss: ≥ 3", tissOnly.length >= 3, String(tissOnly.length));

  // ── 15. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const crossGet = ClinicGuideService.get(B.orgId, g1.id);
  check("isolamento: get de A a partir de B → null", crossGet === null);
  const bList = ClinicGuideService.list(B.orgId);
  check("isolamento: list de B → []", bList.length === 0);

  // ── 16. Auditoria ──────────────────────────────────────────────────────
  const created = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_GUIDE_CREATED'`
  ).get(A.orgId) as any;
  check("audit CREATED ≥ 6", Number(created?.c) >= 6, String(created?.c));

  const issuedCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_GUIDE_ISSUED'`
  ).get(A.orgId) as any;
  check("audit ISSUED = 1", Number(issuedCnt?.c) === 1);

  const cancelledCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_GUIDE_CANCELLED'`
  ).get(A.orgId) as any;
  check("audit CANCELLED ≥ 2", Number(cancelledCnt?.c) >= 2);

  const issueMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_GUIDE_ISSUED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const im = JSON.parse(issueMeta?.metadata_json || "{}");
  check("audit ISSUED metadata: internalNumber", im.internalNumber === "TISS-000001");
  check("audit ISSUED metadata: documentHashPrefix (12 chars)",
    typeof im.documentHashPrefix === "string" && im.documentHashPrefix.length === 12);

  console.log("\n=== Guia da recepção polimorfa (ADR-145 Fatia 44) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
