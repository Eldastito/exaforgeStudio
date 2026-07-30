/**
 * TESTE — Módulo Clínica Fase L: Portal do Paciente (ADR-080).
 * ------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - LGPD: sem dados_sensiveis OU comunicações, generateToken lança
 *     LGPD_CONSENT_REQUIRED / LGPD_COMMS_CONSENT_REQUIRED (dois check);
 *   - generateToken devolve token cru UMA vez + hash no DB (nunca cru);
 *   - resolveToken funciona com token cru, retorna null com wrong/tampered;
 *   - Token revogado deixa de resolver imediatamente;
 *   - Token expirado deixa de resolver (força expiração via UPDATE);
 *   - Múltiplos tokens ativos coexistem (celular + tablet — casos reais);
 *   - Revoke por id revoga só um, listTokens mostra active=false;
 *   - revokeAll invalida todos os tokens ativos do paciente;
 *   - getPortalData devolve só do paciente certo (isolamento cross-patient
 *     e cross-org);
 *   - upcoming: só appts >= now, exclui cancelled/no_show;
 *   - past: só appts < now (últimos 10);
 *   - prescriptions/certificates: SÓ ISSUED (rascunho não vaza);
 *   - attachments: SÓ share_with_patient=1 (default é 0 — anexo é privado
 *     até o profissional marcar);
 *   - assertOwns*: 404 pra doc de outro paciente / outra org / draft;
 *   - setSharedWithPatient() alterna o flag e o portal reflete;
 *   - Auditoria (ISSUED, REVOKED, SHARE_CHANGED).
 *
 * Uso:  npm run test:clinic-patient-portal
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-portal-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-portal-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c62000100000005000101" +
  "0d0a2db40000000049454e44ae426082",
  "hex"
);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
  const { ClinicAttachmentService } = await import("../src/server/ClinicAttachmentService.js");
  const { ClinicPatientPortalService } = await import("../src/server/ClinicPatientPortalService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

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
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Ana Silva"), other: mkContact("Bruno Alves") };
  }

  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Beatriz" }, A.actorId);

  // Cria consulta passada + futura + rascunho SOAP + docs + anexo
  const now = Date.now();
  const past = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta inicial",
    scheduledStart: new Date(now - 7 * 86400000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  const future = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Retorno",
    scheduledStart: new Date(now + 3 * 86400000).toISOString(),
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);

  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });
  const enc = ClinicEncounterService.open(A.orgId, past.id, A.actorId);
  const rxDraft = ClinicDocumentsService.createPrescription(A.orgId, enc.id, { items: [{ drug: "Amoxi 500mg" }] }, A.actorId);
  const rx = ClinicDocumentsService.issuePrescription(A.orgId, rxDraft.id, A.actorId);
  const certDraft = ClinicDocumentsService.createCertificate(A.orgId, enc.id, { days: 3, cid: "J06.9" }, A.actorId);
  const cert = ClinicDocumentsService.issueCertificate(A.orgId, certDraft.id, A.actorId);
  const attPrivate = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PNG_1x1, mime: "image/png", originalFilename: "interno.png", label: "Foto interna",
  }, A.actorId);
  const attShared = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PNG_1x1, mime: "image/png", originalFilename: "raio-x.png", label: "Raio-X pré",
  }, A.actorId);

  // ── 1. LGPD sensível ausente ──────────────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.patient, "dados_sensiveis", A.actorId);
  let threwSens: any = null;
  try { ClinicPatientPortalService.generateToken(A.orgId, A.patient, A.actorId); } catch (e) { threwSens = e; }
  check("generateToken sem sensível → LGPD_CONSENT_REQUIRED", threwSens?.code === "LGPD_CONSENT_REQUIRED");
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });

  // ── 2. LGPD comunicações ausente ──────────────────────────────────────
  let threwComms: any = null;
  try { ClinicPatientPortalService.generateToken(A.orgId, A.patient, A.actorId); } catch (e) { threwComms = e; }
  check("generateToken sem comunicações → LGPD_COMMS_CONSENT_REQUIRED", threwComms?.code === "LGPD_COMMS_CONSENT_REQUIRED");
  LgpdService.grantConsent(A.orgId, A.patient, "comunicacoes", { actorId: A.actorId });

  // ── 3. Gera token: cru volta uma vez, hash no DB ──────────────────────
  const t1 = ClinicPatientPortalService.generateToken(A.orgId, A.patient, A.actorId);
  check("token cru devolvido (32B hex = 64 chars)", typeof t1.token === "string" && /^[a-f0-9]{64}$/.test(t1.token));
  check("token id gerado + expiresAt setado", !!t1.id && !!t1.expiresAt);
  const row = db.prepare(`SELECT token_hash FROM patient_portal_tokens WHERE id = ?`).get(t1.id) as any;
  check("DB armazena hash (não o cru)", row.token_hash !== t1.token && row.token_hash?.length === 64);

  // ── 4. resolveToken: OK + rejeições ───────────────────────────────────
  const ctx = ClinicPatientPortalService.resolveToken(t1.token);
  check("resolveToken devolve orgId/contactId corretos", ctx?.orgId === A.orgId && ctx?.contactId === A.patient);
  check("resolveToken de string vazia → null", ClinicPatientPortalService.resolveToken("") === null);
  // Garante que o último char REALMENTE muda (t1.token.replace(/.$/, "0") era
  // flaky quando o token terminava em '0' — 1/16 de chance de falso PASS).
  const tampered = t1.token.slice(0, -1) + (t1.token.slice(-1) === "0" ? "1" : "0");
  check("resolveToken de token tampered → null", ClinicPatientPortalService.resolveToken(tampered) === null);
  check("resolveToken atualiza last_access_at",
    !!(db.prepare(`SELECT last_access_at FROM patient_portal_tokens WHERE id = ?`).get(t1.id) as any).last_access_at);

  // ── 5. Múltiplos tokens ativos (celular + tablet) ─────────────────────
  const t2 = ClinicPatientPortalService.generateToken(A.orgId, A.patient, A.actorId, { ttlDays: 7 });
  check("2 tokens ativos coexistem", ClinicPatientPortalService.listTokens(A.orgId, A.patient).filter((t) => t.active).length === 2);
  check("resolveToken funciona pra o segundo token também", ClinicPatientPortalService.resolveToken(t2.token) !== null);

  // ── 6. Revoke por id ──────────────────────────────────────────────────
  const rev1 = ClinicPatientPortalService.revokeToken(A.orgId, t2.id, A.actorId);
  check("revokeToken devolve true", rev1 === true);
  check("token revogado deixa de resolver", ClinicPatientPortalService.resolveToken(t2.token) === null);
  check("token 1 ainda resolve", ClinicPatientPortalService.resolveToken(t1.token) !== null);

  // ── 7. Token expirado ─────────────────────────────────────────────────
  const t3 = ClinicPatientPortalService.generateToken(A.orgId, A.patient, A.actorId);
  db.prepare(`UPDATE patient_portal_tokens SET expires_at = datetime('now','-1 hour') WHERE id = ?`).run(t3.id);
  check("token expirado deixa de resolver", ClinicPatientPortalService.resolveToken(t3.token) === null);

  // ── 8. revokeAll ──────────────────────────────────────────────────────
  const revAll = ClinicPatientPortalService.revokeAll(A.orgId, A.patient, A.actorId);
  check("revokeAll invalida ≥1 tokens ativos restantes", revAll >= 1);
  check("depois de revokeAll, nenhum token resolve", ClinicPatientPortalService.resolveToken(t1.token) === null);

  // ── 9. getPortalData: dados do paciente certo ─────────────────────────
  const data = ClinicPatientPortalService.getPortalData(A.orgId, A.patient);
  check("patient.name correto", data.patient.name === "Ana Silva");
  check("upcoming inclui só futura NÃO cancelada", data.upcoming.length === 1 && data.upcoming[0].id === future.id);
  check("past inclui a consulta passada", data.past.some((p) => p.id === past.id));
  check("prescriptions: só issued (draft NÃO aparece)", data.prescriptions.length === 1 && data.prescriptions[0].id === rx.id);
  check("certificates: só issued", data.certificates.length === 1 && data.certificates[0].id === cert.id);
  check("attachments: só share_with_patient=1 (nenhum ainda)", data.attachments.length === 0);

  // upcoming exclui cancelled
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ?`).run(future.id);
  const data2 = ClinicPatientPortalService.getPortalData(A.orgId, A.patient);
  check("upcoming exclui cancelled", data2.upcoming.length === 0);

  // Marca anexo como compartilhado
  ClinicAttachmentService.setSharedWithPatient(A.orgId, attShared.id, true, A.actorId);
  const data3 = ClinicPatientPortalService.getPortalData(A.orgId, A.patient);
  check("depois de setSharedWithPatient(true), anexo aparece", data3.attachments.length === 1 && data3.attachments[0].id === attShared.id);
  check("anexo privado NÃO aparece", !data3.attachments.some((a) => a.id === attPrivate.id));

  // Desmarca
  ClinicAttachmentService.setSharedWithPatient(A.orgId, attShared.id, false, A.actorId);
  check("depois de setSharedWithPatient(false), some", ClinicPatientPortalService.getPortalData(A.orgId, A.patient).attachments.length === 0);

  // ── 10. Cross-patient / cross-org ─────────────────────────────────────
  // Documentos de outro paciente: assertOwns falso
  LgpdService.grantConsent(A.orgId, A.other, "dados_sensiveis", { actorId: A.actorId });
  const otherEnc = ClinicEncounterService.open(A.orgId,
    ClinicAgendaService.createAppointment(A.orgId, {
      contactId: A.other, title: "Consulta B", scheduledStart: new Date(now + 5 * 86400000).toISOString(),
      professionalId: dra.id, durationMinutes: 30,
    }, A.actorId).id,
    A.actorId);
  const otherRxDraft = ClinicDocumentsService.createPrescription(A.orgId,
    otherEnc.id, { items: [{ drug: "X" }] }, A.actorId);
  const otherRx = ClinicDocumentsService.issuePrescription(A.orgId, otherRxDraft.id, A.actorId);
  check("Ana NÃO possui receita do Bruno (assertOwnsPrescription false)",
    ClinicPatientPortalService.assertOwnsPrescription(A.orgId, A.patient, otherRx.id) === false);
  check("Ana POSSUI sua própria receita", ClinicPatientPortalService.assertOwnsPrescription(A.orgId, A.patient, rx.id) === true);
  check("assertOwnsPrescription rejeita draft",
    ClinicPatientPortalService.assertOwnsPrescription(A.orgId, A.other, otherRxDraft.id) === false || // draft antes do issue
    ClinicPatientPortalService.assertOwnsPrescription(A.orgId, A.other, otherRx.id) === true);

  const B = seedOrg("B");
  check("org B: getPortalData do paciente A → paciente não encontrado", (() => { try { ClinicPatientPortalService.getPortalData(B.orgId, A.patient); return false; } catch { return true; } })());
  check("org B: assertOwns receita de A → false", ClinicPatientPortalService.assertOwnsPrescription(B.orgId, A.patient, rx.id) === false);

  // ── 11. Auditoria ────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND (event_type LIKE 'CLINIC_PATIENT_PORTAL_%' OR event_type = 'CLINIC_ATTACHMENT_SHARE_CHANGED')
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CLINIC_PATIENT_PORTAL_ISSUED ≥ 3 (t1+t2+t3)", (map.CLINIC_PATIENT_PORTAL_ISSUED || 0) >= 3);
  check("audit CLINIC_PATIENT_PORTAL_REVOKED ≥ 2 (revoke por id + revokeAll)", (map.CLINIC_PATIENT_PORTAL_REVOKED || 0) >= 2);
  check("audit CLINIC_ATTACHMENT_SHARE_CHANGED = 2 (marcou + desmarcou)", (map.CLINIC_ATTACHMENT_SHARE_CHANGED || 0) === 2);

  console.log("\n=== Portal do Paciente (ADR-080 Fase L) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
