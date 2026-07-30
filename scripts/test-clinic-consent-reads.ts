/**
 * TESTE — Módulo Clínica Fase 19: consent LGPD Art.11 em READS
 * -------------------------------------------------------------
 * Antes desta fatia, o consent SENSITIVE era exigido só nas WRITES (open,
 * update, create, add). Quando o paciente revogava, o profissional continuava
 * lendo prontuário, receitas, atestados e anexos até a retenção passar —
 * violando LGPD Art.8 §5 ("revogação facilitada") e Art.11 II f.
 *
 * Esta suíte cobre os gates novos:
 *
 *   ClinicEncounterService:  getByAppointment, get, listByPatient, history
 *   ClinicDocumentsService:  getPrescription, getCertificate, listByEncounter,
 *                            renderPrescriptionPdf, renderCertificatePdf
 *   ClinicAttachmentService: list, get, read
 *
 *   + ClinicRescheduleService.createOffer NÃO envia se o paciente revogou
 *     `comunicacoes` (evita spam pós-revoke; grava audit
 *     CLINIC_RESCHEDULE_SKIPPED_NO_CONSENT).
 *
 * Uso: npm run test:clinic-consent-reads
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-consent-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-fatia-19-consent-1234567890abcd";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c62000100000005000101" +
  "0d0a2db40000000049454e44ae426082", "hex"
);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
  const { ClinicAttachmentService } = await import("../src/server/ClinicAttachmentService.js");
  const { ClinicRescheduleService } = await import("../src/server/ClinicRescheduleService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}${Math.floor(Math.random() * 1e6)}`);
    return { orgId, contactId, channelId, actorId: `user_${tag}` };
  }

  function expectConsentThrow<T>(fn: () => T, label: string): boolean {
    try { fn(); return false; }
    catch (e: any) {
      const ok = e?.code === "LGPD_CONSENT_REQUIRED";
      if (!ok) console.error(`  [${label}] threw sem code LGPD_CONSENT_REQUIRED:`, e?.code, e?.message);
      return ok;
    }
  }

  async function expectConsentThrowAsync<T>(fn: () => Promise<T>, label: string): Promise<boolean> {
    try { await fn(); return false; }
    catch (e: any) {
      const ok = e?.code === "LGPD_CONSENT_REQUIRED";
      if (!ok) console.error(`  [${label}] threw sem code LGPD_CONSENT_REQUIRED:`, e?.code, e?.message);
      return ok;
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Setup base — 1 org com consent completo, cria fluxo inteiro
  // ───────────────────────────────────────────────────────────────────────
  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra." }, A.actorId);
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "Consulta",
    scheduledStart: "2026-08-15T10:00:00-03:00",
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);

  // Sem consent, open lança (regressão do gate original — Fatia 1)
  let openBeforeConsent: any = null;
  try { ClinicEncounterService.open(A.orgId, apt.id, A.actorId); }
  catch (e) { openBeforeConsent = e; }
  check("open sem consent lança LGPD_CONSENT_REQUIRED (regressão Fase 1)", openBeforeConsent?.code === "LGPD_CONSENT_REQUIRED");

  // Grant sensitive + open OK
  LgpdService.grantConsent(A.orgId, A.contactId, "dados_sensiveis", { actorId: A.actorId });
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);
  check("com consent, open cria encounter", !!enc?.id);

  ClinicEncounterService.update(A.orgId, enc.id, A.actorId, { subjective: "dor de cabeça" });

  const rx = ClinicDocumentsService.createPrescription(A.orgId, enc.id, {
    items: [{ drug: "Paracetamol 750mg", instructions: "1 cp 8/8h" }],
  }, A.actorId);
  const rxIssued = ClinicDocumentsService.issuePrescription(A.orgId, rx.id, A.actorId);
  check("rx issued OK com consent", rxIssued.status === "issued");

  const cert = ClinicDocumentsService.createCertificate(A.orgId, enc.id, {
    days: 3, purpose: "rest", notes: "Atestado padrão",
  }, A.actorId);
  const certIssued = ClinicDocumentsService.issueCertificate(A.orgId, cert.id, A.actorId);
  check("cert issued OK com consent", certIssued.status === "issued");

  const att = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PNG_1x1, mime: "image/png", originalFilename: "exame.png", label: "Exame",
  }, A.actorId);
  check("attachment add OK com consent", !!att?.id);

  // ───────────────────────────────────────────────────────────────────────
  // Reads com consent OK — sanity
  // ───────────────────────────────────────────────────────────────────────
  check("getByAppointment retorna encounter", !!ClinicEncounterService.getByAppointment(A.orgId, apt.id));
  check("get(encounterId) retorna encounter", !!ClinicEncounterService.get(A.orgId, enc.id));
  check("listByPatient retorna >=1", ClinicEncounterService.listByPatient(A.orgId, A.contactId).length >= 1);
  check("history retorna array", Array.isArray(ClinicEncounterService.history(A.orgId, enc.id)));

  check("getPrescription retorna rx", !!ClinicDocumentsService.getPrescription(A.orgId, rx.id));
  check("getCertificate retorna cert", !!ClinicDocumentsService.getCertificate(A.orgId, cert.id));
  const listedBefore = ClinicDocumentsService.listByEncounter(A.orgId, enc.id);
  check("listByEncounter traz rx+cert", listedBefore.prescriptions.length >= 1 && listedBefore.certificates.length >= 1);

  const rxPdf = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rx.id);
  check("renderPrescriptionPdf gera PDF", rxPdf.slice(0, 5).toString() === "%PDF-");
  const certPdf = await ClinicDocumentsService.renderCertificatePdf(A.orgId, cert.id);
  check("renderCertificatePdf gera PDF", certPdf.slice(0, 5).toString() === "%PDF-");

  check("attachment list retorna >=1", ClinicAttachmentService.list(A.orgId, enc.id).length >= 1);
  check("attachment get retorna att", !!ClinicAttachmentService.get(A.orgId, att.id));
  const read = ClinicAttachmentService.read(A.orgId, att.id);
  check("attachment read devolve buffer PNG", read.buffer.length > 0 && read.mime === "image/png");

  // ───────────────────────────────────────────────────────────────────────
  // REVOGA consent SENSITIVE → todos os reads bloqueiam
  // ───────────────────────────────────────────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.contactId, "dados_sensiveis", A.actorId);

  check("encounter.getByAppointment bloqueado após revoke",
    expectConsentThrow(() => ClinicEncounterService.getByAppointment(A.orgId, apt.id), "encounter.getByAppointment"));
  check("encounter.get bloqueado após revoke",
    expectConsentThrow(() => ClinicEncounterService.get(A.orgId, enc.id), "encounter.get"));
  check("encounter.listByPatient bloqueado após revoke",
    expectConsentThrow(() => ClinicEncounterService.listByPatient(A.orgId, A.contactId), "encounter.listByPatient"));
  check("encounter.history bloqueado após revoke",
    expectConsentThrow(() => ClinicEncounterService.history(A.orgId, enc.id), "encounter.history"));

  check("docs.getPrescription bloqueado após revoke",
    expectConsentThrow(() => ClinicDocumentsService.getPrescription(A.orgId, rx.id), "docs.getPrescription"));
  check("docs.getCertificate bloqueado após revoke",
    expectConsentThrow(() => ClinicDocumentsService.getCertificate(A.orgId, cert.id), "docs.getCertificate"));
  check("docs.listByEncounter bloqueado após revoke",
    expectConsentThrow(() => ClinicDocumentsService.listByEncounter(A.orgId, enc.id), "docs.listByEncounter"));
  check("docs.renderPrescriptionPdf bloqueado após revoke",
    await expectConsentThrowAsync(() => ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rx.id), "docs.renderPrescriptionPdf"));
  check("docs.renderCertificatePdf bloqueado após revoke",
    await expectConsentThrowAsync(() => ClinicDocumentsService.renderCertificatePdf(A.orgId, cert.id), "docs.renderCertificatePdf"));

  check("attachments.list bloqueado após revoke",
    expectConsentThrow(() => ClinicAttachmentService.list(A.orgId, enc.id), "attachments.list"));
  check("attachments.get bloqueado após revoke",
    expectConsentThrow(() => ClinicAttachmentService.get(A.orgId, att.id), "attachments.get"));
  check("attachments.read bloqueado após revoke",
    expectConsentThrow(() => ClinicAttachmentService.read(A.orgId, att.id), "attachments.read"));

  // ───────────────────────────────────────────────────────────────────────
  // Reads não gate em row inexistente (nada a proteger)
  // ───────────────────────────────────────────────────────────────────────
  const bogus = randomUUID();
  check("encounter.getByAppointment(inexistente) retorna null sem lançar",
    ClinicEncounterService.getByAppointment(A.orgId, bogus) === null);
  check("encounter.get(inexistente) retorna null sem lançar",
    ClinicEncounterService.get(A.orgId, bogus) === null);
  check("encounter.history(inexistente) retorna array vazio sem lançar",
    Array.isArray(ClinicEncounterService.history(A.orgId, bogus)) && ClinicEncounterService.history(A.orgId, bogus).length === 0);
  check("docs.getPrescription(inexistente) retorna null sem lançar",
    ClinicDocumentsService.getPrescription(A.orgId, bogus) === null);
  check("docs.getCertificate(inexistente) retorna null sem lançar",
    ClinicDocumentsService.getCertificate(A.orgId, bogus) === null);
  const emptyList = ClinicDocumentsService.listByEncounter(A.orgId, bogus);
  check("docs.listByEncounter(inexistente) retorna listas vazias sem lançar",
    emptyList.prescriptions.length === 0 && emptyList.certificates.length === 0);
  check("attachments.get(inexistente) retorna null sem lançar",
    ClinicAttachmentService.get(A.orgId, bogus) === null);
  check("attachments.list(encounter inexistente) retorna array vazio sem lançar",
    ClinicAttachmentService.list(A.orgId, bogus).length === 0);

  // ───────────────────────────────────────────────────────────────────────
  // Re-grant restaura reads
  // ───────────────────────────────────────────────────────────────────────
  LgpdService.grantConsent(A.orgId, A.contactId, "dados_sensiveis", { actorId: A.actorId });
  check("pós re-grant: encounter.get volta a funcionar", !!ClinicEncounterService.get(A.orgId, enc.id));
  check("pós re-grant: docs.getPrescription volta a funcionar", !!ClinicDocumentsService.getPrescription(A.orgId, rx.id));
  const rxPdfAgain = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rx.id);
  check("pós re-grant: renderPrescriptionPdf volta", rxPdfAgain.slice(0, 5).toString() === "%PDF-");
  check("pós re-grant: attachments.read volta", ClinicAttachmentService.read(A.orgId, att.id).buffer.length > 0);

  // ───────────────────────────────────────────────────────────────────────
  // Reschedule: createOffer NÃO envia sem consent comms
  // ───────────────────────────────────────────────────────────────────────
  const B = seedOrg("B");
  LgpdService.grantConsent(B.orgId, B.contactId, "dados_sensiveis", { actorId: B.actorId });
  const drB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dr B" }, B.actorId);
  const aptB = ClinicAgendaService.createAppointment(B.orgId, {
    contactId: B.contactId, title: "Consulta B",
    scheduledStart: "2026-09-01T10:00:00-03:00",
    professionalId: drB.id, durationMinutes: 30,
  }, B.actorId);

  // Sem consent comms → createOffer retorna null + audit
  const noConsentOffer = ClinicRescheduleService.createOffer(B.orgId, aptB.id, B.contactId);
  check("reschedule.createOffer sem consent comms retorna null", noConsentOffer === null);
  const skipAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_RESCHEDULE_SKIPPED_NO_CONSENT'`
  ).get(B.orgId) as any;
  check("reschedule sem consent grava audit CLINIC_RESCHEDULE_SKIPPED_NO_CONSENT", Number(skipAudit?.c) >= 1);

  // Grant comms → cria offer OK
  LgpdService.grantConsent(B.orgId, B.contactId, "comunicacoes", { actorId: B.actorId });
  const okOffer = ClinicRescheduleService.createOffer(B.orgId, aptB.id, B.contactId);
  check("reschedule.createOffer com consent comms retorna offer", !!okOffer?.offer?.id);

  // Revoke comms depois → nova tentativa retorna null
  LgpdService.revokeConsent(B.orgId, B.contactId, "comunicacoes", B.actorId);
  const revokedOffer = ClinicRescheduleService.createOffer(B.orgId, aptB.id, B.contactId);
  check("reschedule.createOffer pós revoke retorna null", revokedOffer === null);

  // ───────────────────────────────────────────────────────────────────────
  // Isolamento multi-tenant: revoke em B não afeta reads em A
  // ───────────────────────────────────────────────────────────────────────
  const encA = ClinicEncounterService.get(A.orgId, enc.id);
  check("cross-org: revoke em B não afeta A", !!encA);

  // ───────────────────────────────────────────────────────────────────────
  console.log("\n=== Fatia 19 — consent LGPD Art.11 em reads (ADR-080) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
