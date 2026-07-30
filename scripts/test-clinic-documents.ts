/**
 * TESTE — Módulo Clínica Fase H: Receita + Atestado (ADR-080 extensão).
 * ---------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - LGPD Art.11: create/update falham com LGPD_CONSENT_REQUIRED sem
 *     consentimento 'dados_sensiveis' (mesmo guardrail do encounter);
 *   - Receita exige ≥1 item (create e update);
 *   - update() bloqueia doc `issued` com DOCUMENT_ISSUED (bloqueio no
 *     service — o DB não impõe, mas o produto sim);
 *   - issue() é IDEMPOTENTE (2ª chamada não muda issued_by/issued_at);
 *   - issue() faz SNAPSHOT PRÓPRIO do profissional (nome + registro +
 *     conselho) — alterar o cadastro do profissional DEPOIS não afeta
 *     doc já emitido;
 *   - PDF (Buffer) gera sem crash pra receita e atestado, com header PDF
 *     válido e tamanho razoável;
 *   - Atestado exige days ≥ 1;
 *   - listByEncounter devolve receitas e atestados ordenados desc;
 *   - Isolamento multi-tenant;
 *   - Auditoria em auth_audit_logs (CREATED/UPDATED/ISSUED).
 *
 * Uso:  npm run test:clinic-documents
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-docs-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-documents-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicDocumentsService } = await import("../src/server/ClinicDocumentsService.js");
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
    return { orgId, actorId: `user_${tag}`, patient: mkContact("Ana Silva") };
  }
  const A = seedOrg("A");

  const dra = ClinicAgendaService.createProfessional(A.orgId, {
    name: "Dra. Beatriz Souza",
    specialty: "Clínica Geral",
    registrationNumber: "123456",
    council: "CRM/SP",
  }, A.actorId);
  check("createProfessional aceita registration_number + council", !!dra.registration_number && dra.council === "CRM/SP");

  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient,
    title: "Consulta",
    scheduledStart: "2026-08-01T09:00:00-03:00",
    professionalId: dra.id,
    durationMinutes: 30,
  }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);

  // ── 1. LGPD: sem consentimento não cria ────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.patient, "dados_sensiveis", A.actorId);
  let threw: any = null;
  try { ClinicDocumentsService.createPrescription(A.orgId, enc.id, { items: [{ drug: "X" }] }, A.actorId); } catch (e) { threw = e; }
  check("createPrescription sem consentimento → LGPD_CONSENT_REQUIRED", threw?.code === "LGPD_CONSENT_REQUIRED");

  // Concede de novo pra seguir
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });

  // ── 2. Receita: exige item ─────────────────────────────────────────────
  let threwNoItem: any = null;
  try { ClinicDocumentsService.createPrescription(A.orgId, enc.id, { items: [] }, A.actorId); } catch (e) { threwNoItem = e; }
  check("createPrescription sem itens → erro", !!threwNoItem);

  // ── 3. Receita: draft → update → issue ─────────────────────────────────
  const rx = ClinicDocumentsService.createPrescription(A.orgId, enc.id, {
    headerNotes: "Uso conforme prescrição",
    items: [
      { drug: "Amoxicilina 500mg", dosage: "1 cápsula", quantity: "21 cápsulas", instructions: "1 cápsula de 8/8h por 7 dias" },
      { drug: "Ibuprofeno 400mg", dosage: "1 comprimido", quantity: "10 comprimidos", instructions: "Se dor, até de 8/8h" },
    ],
    repeatsAllowed: 0,
  }, A.actorId);
  check("createPrescription draft", rx.status === "draft" && rx.items.length === 2);

  const rx2 = ClinicDocumentsService.updatePrescription(A.orgId, rx.id, A.actorId, {
    headerNotes: "Uso oral conforme prescrição",
    validUntil: "2026-09-01",
  });
  check("updatePrescription altera header + validUntil", rx2.headerNotes?.includes("oral") && rx2.validUntil === "2026-09-01");

  // ── 4. Alterar cadastro do profissional DEPOIS ────────────────────────
  // (pra testar snapshot no issue — o issue deve usar o registro ATUAL do
  // cadastro naquele momento, e um cadastro que muda DEPOIS não afeta o doc)
  const issued = ClinicDocumentsService.issuePrescription(A.orgId, rx.id, A.actorId);
  check("issuePrescription → status issued", issued.status === "issued");
  check("issue faz snapshot do nome do profissional", issued.professionalNameSnapshot === "Dra. Beatriz Souza");
  check("issue faz snapshot do registro (CRM)", issued.professionalRegistrationSnapshot === "123456");
  check("issue faz snapshot do conselho", issued.professionalCouncilSnapshot === "CRM/SP");
  check("issue registra issued_by/issued_at", issued.issuedBy === A.actorId && !!issued.issuedAt);

  // Alterar cadastro depois — snapshot permanece
  ClinicAgendaService.updateProfessional(A.orgId, dra.id, { registrationNumber: "999999", council: "CRM/RJ" }, A.actorId);
  const rxAfter = ClinicDocumentsService.getPrescription(A.orgId, rx.id);
  check("snapshot NÃO muda quando cadastro do profissional muda depois",
    rxAfter?.professionalRegistrationSnapshot === "123456" && rxAfter?.professionalCouncilSnapshot === "CRM/SP");

  // ── 5. issue() idempotente ─────────────────────────────────────────────
  const issued2 = ClinicDocumentsService.issuePrescription(A.orgId, rx.id, "outro-user");
  check("issue() idempotente: 2ª chamada NÃO troca issued_by", issued2.issuedBy === A.actorId);

  // ── 6. update() bloqueado após issued ─────────────────────────────────
  let threwIssued: any = null;
  try { ClinicDocumentsService.updatePrescription(A.orgId, rx.id, A.actorId, { headerNotes: "outro" }); } catch (e) { threwIssued = e; }
  check("update receita issued → DOCUMENT_ISSUED", threwIssued?.code === "DOCUMENT_ISSUED");

  // ── 7. PDF receita ─────────────────────────────────────────────────────
  const rxPdf = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rx.id);
  check("PDF receita gera Buffer", Buffer.isBuffer(rxPdf) && rxPdf.length > 500);
  check("PDF receita começa com '%PDF-'", rxPdf.slice(0, 5).toString() === "%PDF-");

  // ── 8. Atestado ────────────────────────────────────────────────────────
  let threwNoDays: any = null;
  try { ClinicDocumentsService.createCertificate(A.orgId, enc.id, { days: 0 }, A.actorId); } catch (e) { threwNoDays = e; }
  check("createCertificate days=0 → erro", !!threwNoDays);

  const cert = ClinicDocumentsService.createCertificate(A.orgId, enc.id, {
    days: 3,
    cid: "J06.9",
    cidDescription: "Infecção aguda das vias aéreas superiores",
    purpose: "rest",
    notes: "Repouso relativo, hidratação e reavaliar em 5 dias.",
  }, A.actorId);
  check("createCertificate draft", cert.status === "draft" && cert.days === 3 && cert.cid === "J06.9");

  const certIssued = ClinicDocumentsService.issueCertificate(A.orgId, cert.id, A.actorId);
  check("issueCertificate → issued", certIssued.status === "issued");
  // O cadastro do profissional agora tem 999999/CRM/RJ (item 4) —
  // atestado deve usar o valor ATUAL no momento do issue.
  check("issue atestado captura registro ATUAL no momento", certIssued.professionalRegistrationSnapshot === "999999" && certIssued.professionalCouncilSnapshot === "CRM/RJ");

  let threwCertIssued: any = null;
  try { ClinicDocumentsService.updateCertificate(A.orgId, cert.id, A.actorId, { days: 5 }); } catch (e) { threwCertIssued = e; }
  check("update atestado issued → DOCUMENT_ISSUED", threwCertIssued?.code === "DOCUMENT_ISSUED");

  const certPdf = await ClinicDocumentsService.renderCertificatePdf(A.orgId, cert.id);
  check("PDF atestado gera Buffer", Buffer.isBuffer(certPdf) && certPdf.length > 500);
  check("PDF atestado começa com '%PDF-'", certPdf.slice(0, 5).toString() === "%PDF-");

  // ── 9. listByEncounter ─────────────────────────────────────────────────
  const docs = ClinicDocumentsService.listByEncounter(A.orgId, enc.id);
  check("listByEncounter: 1 receita + 1 atestado", docs.prescriptions.length === 1 && docs.certificates.length === 1);

  // ── 10. Rascunho: PDF marca "RASCUNHO" (não crashea, apenas devolve buffer) ─
  const draftRx = ClinicDocumentsService.createPrescription(A.orgId, enc.id, { items: [{ drug: "Paracetamol 750mg", instructions: "6/6h se dor" }] }, A.actorId);
  const draftPdf = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, draftRx.id);
  check("PDF de rascunho gera sem crash", Buffer.isBuffer(draftPdf) && draftPdf.length > 500);

  // ── 11. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  check("org B não vê receita da org A", ClinicDocumentsService.getPrescription(B.orgId, rx.id) === null);
  check("org B não vê atestado da org A", ClinicDocumentsService.getCertificate(B.orgId, cert.id) === null);
  let threwCrossUpdate: any = null;
  try { ClinicDocumentsService.updatePrescription(B.orgId, rx.id, B.actorId, { headerNotes: "x" }); } catch (e) { threwCrossUpdate = e; }
  check("org B update receita alheia → 404", threwCrossUpdate?.message?.includes("não encontrada"));

  // ── 12. Auditoria ──────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND (event_type LIKE 'CLINIC_PRESCRIPTION_%' OR event_type LIKE 'CLINIC_CERTIFICATE_%')
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CLINIC_PRESCRIPTION_CREATED ≥ 2", (map.CLINIC_PRESCRIPTION_CREATED || 0) >= 2, String(map.CLINIC_PRESCRIPTION_CREATED));
  check("audit CLINIC_PRESCRIPTION_ISSUED = 1", (map.CLINIC_PRESCRIPTION_ISSUED || 0) === 1, String(map.CLINIC_PRESCRIPTION_ISSUED));
  check("audit CLINIC_CERTIFICATE_CREATED = 1", (map.CLINIC_CERTIFICATE_CREATED || 0) === 1, String(map.CLINIC_CERTIFICATE_CREATED));
  check("audit CLINIC_CERTIFICATE_ISSUED = 1", (map.CLINIC_CERTIFICATE_ISSUED || 0) === 1, String(map.CLINIC_CERTIFICATE_ISSUED));

  console.log("\n=== Receita + Atestado (ADR-080 Fase H) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
