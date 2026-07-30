/**
 * TESTE — Módulo Clínica Fase 16 (ADR-080): Assinatura visível no PDF
 * ---------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Documento emitido SEM PIN → signature_hash/signature_timestamp NULL,
 *     PDF sem rodapé de assinatura eletrônica (compat com clínicas antigas);
 *   - Documento emitido COM PIN → hash SHA-256 (64 hex) + ISO timestamp
 *     persistidos, PDF contém "Assinado eletronicamente com PIN pessoal"
 *     + o hash literal + data extraída;
 *   - Hash é determinístico pra mesmo conteúdo, mas dois docs emitidos em
 *     momentos diferentes têm hashes diferentes (timestamp entra no canônico);
 *   - Certificate segue mesma regra da Prescription;
 *   - Isolamento multi-tenant: hash de A não vaza pra B;
 *   - Auditoria ISSUED carrega signatureHash no metadata;
 *   - PDF assinado é maior que PDF não-assinado (rodapé real).
 *
 * Uso:  npm run test:clinic-signature-visible
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-sig-vis-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-signature-visible-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function pdfText(buf: Buffer): Promise<string> {
  const { PDFParse } = await import("pdf-parse");
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  const out = await parser.getText();
  return String(out?.text || "");
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
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}`);
    LgpdService.grantConsent(orgId, contactId, "dados_sensiveis", { actorId: `user_${tag}` });
    return { orgId, actorId: `user_${tag}`, contactId };
  }

  async function seedDraft(orgId: string, actorId: string, contactId: string, prof: any, kind: "rx" | "cert") {
    const apt = ClinicAgendaService.createAppointment(orgId, {
      contactId, title: "T",
      scheduledStart: new Date(Date.now() - 2 * 86400_000).toISOString(),
      professionalId: prof.id, durationMinutes: 30, force: true,
    }, actorId);
    const enc = ClinicEncounterService.open(orgId, apt.id, actorId);
    if (kind === "rx") {
      return ClinicDocumentsService.createPrescription(orgId, enc.id, {
        items: [{ drug: "Amoxicilina 500mg", dosage: "1cp 8/8h", quantity: "21cp" }],
      }, actorId);
    }
    return ClinicDocumentsService.createCertificate(orgId, enc.id, { days: 3, purpose: "rest" }, actorId);
  }

  const A = seedOrg("A");
  const draNoPin = ClinicAgendaService.createProfessional(A.orgId, {
    name: "Dra. Sem PIN", registrationNumber: "12345", council: "CRM/SP",
  }, A.actorId);
  const draPin = ClinicAgendaService.createProfessional(A.orgId, {
    name: "Dr. João Silva", registrationNumber: "98765", council: "CRM/RJ",
  }, A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, draPin.id, "1234", A.actorId);

  // ── 1. SEM PIN → nenhum hash/timestamp; PDF sem rodapé eletrônico ─────
  const rxNoPin = await seedDraft(A.orgId, A.actorId, A.contactId, draNoPin, "rx");
  const issuedNoPin = ClinicDocumentsService.issuePrescription(A.orgId, rxNoPin.id, A.actorId);
  check("SEM PIN → status=issued", issuedNoPin.status === "issued");
  check("SEM PIN → signatureHash null", issuedNoPin.signatureHash === null);
  check("SEM PIN → signatureTimestamp null", issuedNoPin.signatureTimestamp === null);
  check("SEM PIN → signedWithPin false", issuedNoPin.signedWithPin === false);
  const pdfNoPin = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rxNoPin.id);
  const textNoPin = await pdfText(pdfNoPin);
  check("SEM PIN → PDF SEM 'Assinado eletronicamente'", !textNoPin.includes("Assinado eletronicamente"));
  check("SEM PIN → PDF SEM 'Hash SHA-256'", !textNoPin.includes("Hash SHA-256"));

  // ── 2. COM PIN → hash+timestamp; PDF com rodapé eletrônico ────────────
  const rxPin = await seedDraft(A.orgId, A.actorId, A.contactId, draPin, "rx");
  const issuedPin = ClinicDocumentsService.issuePrescription(A.orgId, rxPin.id, A.actorId, { pin: "1234" });
  check("COM PIN → status=issued", issuedPin.status === "issued");
  check("COM PIN → signedWithPin true", issuedPin.signedWithPin === true);
  check("COM PIN → signatureHash 64 hex chars", /^[a-f0-9]{64}$/.test(issuedPin.signatureHash || ""));
  check("COM PIN → signatureTimestamp ISO", /^\d{4}-\d{2}-\d{2}T/.test(issuedPin.signatureTimestamp || ""));
  const pdfPin = await ClinicDocumentsService.renderPrescriptionPdf(A.orgId, rxPin.id);
  const textPin = await pdfText(pdfPin);
  check("COM PIN → PDF contém 'Assinado eletronicamente'", textPin.includes("Assinado eletronicamente"));
  check("COM PIN → PDF contém 'ADR-080'", textPin.includes("ADR-080"));
  check("COM PIN → PDF contém 'LGPD Art. 11'", textPin.includes("LGPD Art. 11"));
  check("COM PIN → PDF contém 'Hash SHA-256'", textPin.includes("Hash SHA-256"));
  check("COM PIN → PDF contém o hash literal", issuedPin.signatureHash != null && textPin.includes(issuedPin.signatureHash));
  check("COM PIN → PDF contém 'Emitido em'", textPin.includes("Emitido em"));
  check("COM PIN → PDF contém 'UTC'", textPin.includes("UTC"));

  // ── 3. PDF assinado é MAIOR que PDF não-assinado ──────────────────────
  check("PDF assinado > PDF não-assinado", pdfPin.length > pdfNoPin.length, `${pdfPin.length} vs ${pdfNoPin.length}`);

  // ── 4. Hash é determinístico pro mesmo doc ────────────────────────────
  const reload = ClinicDocumentsService.getPrescription(A.orgId, rxPin.id);
  check("hash persistido == hash retornado no issue", reload?.signatureHash === issuedPin.signatureHash);

  // ── 5. Dois docs distintos → hashes distintos ─────────────────────────
  await new Promise((r) => setTimeout(r, 5));
  const rxPin2 = await seedDraft(A.orgId, A.actorId, A.contactId, draPin, "rx");
  const issuedPin2 = ClinicDocumentsService.issuePrescription(A.orgId, rxPin2.id, A.actorId, { pin: "1234" });
  check("2 docs distintos → hashes distintos", issuedPin.signatureHash !== issuedPin2.signatureHash);

  // ── 6. Certificate segue mesma regra ──────────────────────────────────
  const certNoPin = await seedDraft(A.orgId, A.actorId, A.contactId, draNoPin, "cert");
  const cIssuedNoPin = ClinicDocumentsService.issueCertificate(A.orgId, certNoPin.id, A.actorId);
  check("certificate SEM PIN → signatureHash null", cIssuedNoPin.signatureHash === null);
  const certPin = await seedDraft(A.orgId, A.actorId, A.contactId, draPin, "cert");
  const cIssuedPin = ClinicDocumentsService.issueCertificate(A.orgId, certPin.id, A.actorId, { pin: "1234" });
  check("certificate COM PIN → hash 64 hex", /^[a-f0-9]{64}$/.test(cIssuedPin.signatureHash || ""));
  const cPdfPin = await ClinicDocumentsService.renderCertificatePdf(A.orgId, certPin.id);
  const cTextPin = await pdfText(cPdfPin);
  check("certificate PDF assinado → contém 'Assinado eletronicamente'", cTextPin.includes("Assinado eletronicamente"));
  check("certificate PDF assinado → contém hash", cIssuedPin.signatureHash != null && cTextPin.includes(cIssuedPin.signatureHash));

  // ── 7. Kinds distintos → hashes distintos ─────────────────────────────
  check("prescription hash != certificate hash", issuedPin.signatureHash !== cIssuedPin.signatureHash);

  // ── 8. Isolamento multi-tenant ────────────────────────────────────────
  const B = seedOrg("B");
  const draB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dra B", registrationNumber: "0000", council: "CRM/MG" }, B.actorId);
  ClinicAgendaService.setProfessionalPin(B.orgId, draB.id, "5555", B.actorId);
  const rxB = await seedDraft(B.orgId, B.actorId, B.contactId, draB, "rx");
  const issuedB = ClinicDocumentsService.issuePrescription(B.orgId, rxB.id, B.actorId, { pin: "5555" });
  check("hash de B != hash de A (mesmo template)", issuedB.signatureHash !== issuedPin.signatureHash);
  // getPrescription de A com id de B retorna null (isolamento existente do service)
  check("cross-org get retorna null", ClinicDocumentsService.getPrescription(A.orgId, rxB.id) === null);

  // ── 9. Auditoria carrega signatureHash ────────────────────────────────
  const auditRow = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_PRESCRIPTION_ISSUED'
        AND metadata_json LIKE '%signatureHash%'
      ORDER BY created_at DESC LIMIT 1`
  ).get(A.orgId) as any;
  check("audit ISSUED tem signatureHash no metadata", !!auditRow?.metadata_json);
  if (auditRow) {
    const meta = JSON.parse(auditRow.metadata_json);
    check("audit metadata.signatureHash bate com o persistido",
      meta.signatureHash === issuedPin2.signatureHash || meta.signatureHash === issuedPin.signatureHash);
  }

  // ── 10. Reemissão de doc já emitido é idempotente (não muda hash) ─────
  const reissued = ClinicDocumentsService.issuePrescription(A.orgId, rxPin.id, A.actorId, { pin: "1234" });
  check("reemissão de doc issued → hash preservado", reissued.signatureHash === issuedPin.signatureHash);
  check("reemissão de doc issued → timestamp preservado", reissued.signatureTimestamp === issuedPin.signatureTimestamp);

  console.log("\n=== Assinatura visível no PDF (ADR-080 Fase 16) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
