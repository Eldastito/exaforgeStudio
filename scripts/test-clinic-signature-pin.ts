/**
 * TESTE — Módulo Clínica Fase T: Assinatura eletrônica com PIN
 * ------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - setProfessionalPin com PIN válido (4-8 dígitos) gera hash+salt;
 *   - PIN inválido (letras, curto, longo) → PIN_INVALID_FORMAT;
 *   - Salt novo a cada set — dois sets do MESMO PIN geram hashes diferentes;
 *   - setProfessionalPin(null) limpa PIN;
 *   - hasProfessionalPin reflete estado;
 *   - Compat: profissional SEM PIN → issuePrescription/Certificate emite
 *     normalmente sem exigir PIN (backward compat);
 *   - Profissional COM PIN + nenhum PIN fornecido → PIN_REQUIRED;
 *   - Profissional COM PIN + PIN errado → PIN_INVALID;
 *   - Profissional COM PIN + PIN certo → emite + signed_with_pin=1;
 *   - PIN certo pra Prescription E Certificate;
 *   - signed_with_pin=0 quando emitido sem PIN (compat);
 *   - Auditoria PIN_SET / PIN_CLEARED;
 *   - Auditoria ISSUED com signedWithPin no metadata;
 *   - Isolamento multi-tenant: PIN de outra org não confunde.
 *
 * Uso:  npm run test:clinic-signature-pin
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-pin-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-pin-1234567890";

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
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, "Paciente", `55${tag}`);
    LgpdService.grantConsent(orgId, contactId, "dados_sensiveis", { actorId: `user_${tag}` });
    return { orgId, actorId: `user_${tag}`, contactId };
  }
  const A = seedOrg("A");
  const draNoPin = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Sem PIN" }, A.actorId);
  const draPin = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Com PIN" }, A.actorId);

  // ── 1. setProfessionalPin válido ─────────────────────────────────────
  const s1 = ClinicAgendaService.setProfessionalPin(A.orgId, draPin.id, "1234", A.actorId);
  check("setPin('1234') retorna hasPin=true", s1.hasPin === true);
  const r1 = db.prepare(`SELECT pin_hash, pin_salt FROM clinic_professionals WHERE id=?`).get(draPin.id) as any;
  check("pin_hash gravado (64 hex chars)", /^[a-f0-9]{64}$/.test(r1.pin_hash));
  check("pin_salt gravado", !!r1.pin_salt);

  // ── 2. Salt novo a cada set (rehash mesmo PIN gera hash diferente) ──
  ClinicAgendaService.setProfessionalPin(A.orgId, draPin.id, "1234", A.actorId);
  const r2 = db.prepare(`SELECT pin_hash, pin_salt FROM clinic_professionals WHERE id=?`).get(draPin.id) as any;
  check("2º set com mesmo PIN gera salt novo", r2.pin_salt !== r1.pin_salt);
  check("2º set com mesmo PIN gera hash diferente", r2.pin_hash !== r1.pin_hash);

  // ── 3. Formatos inválidos ────────────────────────────────────────────
  const tryFmt = (v: any) => { try { ClinicAgendaService.setProfessionalPin(A.orgId, draPin.id, v, A.actorId); return null; } catch (e: any) { return e; } };
  check("PIN '123' (curto) → PIN_INVALID_FORMAT", tryFmt("123")?.code === "PIN_INVALID_FORMAT");
  check("PIN '123456789' (longo) → PIN_INVALID_FORMAT", tryFmt("123456789")?.code === "PIN_INVALID_FORMAT");
  check("PIN 'abcd' (letras) → PIN_INVALID_FORMAT", tryFmt("abcd")?.code === "PIN_INVALID_FORMAT");
  check("PIN '12a4' (mistura) → PIN_INVALID_FORMAT", tryFmt("12a4")?.code === "PIN_INVALID_FORMAT");

  // ── 4. hasProfessionalPin reflete ───────────────────────────────────
  check("hasPin=true depois de setar", ClinicAgendaService.hasProfessionalPin(A.orgId, draPin.id) === true);
  check("hasPin=false pro profissional sem PIN", ClinicAgendaService.hasProfessionalPin(A.orgId, draNoPin.id) === false);

  // Prepara appointment + encounter + prescription draft pra cada profissional
  async function seedDraftDoc(prof: any, kind: "rx" | "cert") {
    const now = Date.now();
    const apt = ClinicAgendaService.createAppointment(A.orgId, {
      contactId: A.contactId, title: "T", scheduledStart: new Date(now - 2 * 86400_000).toISOString(),
      professionalId: prof.id, durationMinutes: 30, force: true,
    }, A.actorId);
    const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);
    if (kind === "rx") {
      return ClinicDocumentsService.createPrescription(A.orgId, enc.id, { items: [{ drug: "X" }] }, A.actorId);
    }
    return ClinicDocumentsService.createCertificate(A.orgId, enc.id, { days: 3 }, A.actorId);
  }

  // ── 5. Compat: profissional SEM PIN → emite sem exigir PIN ──────────
  const rxNoPin = await seedDraftDoc(draNoPin, "rx");
  const issuedNoPin = ClinicDocumentsService.issuePrescription(A.orgId, rxNoPin.id, A.actorId);
  check("sem PIN cadastrado → emite normalmente", issuedNoPin.status === "issued");
  const nRow = db.prepare(`SELECT signed_with_pin FROM clinical_prescriptions WHERE id=?`).get(rxNoPin.id) as any;
  check("sem PIN → signed_with_pin=0", Number(nRow.signed_with_pin) === 0);

  // ── 6. Com PIN + nenhum PIN → PIN_REQUIRED ──────────────────────────
  const rxPin = await seedDraftDoc(draPin, "rx");
  const tryIssue = (opts: any) => { try { ClinicDocumentsService.issuePrescription(A.orgId, rxPin.id, A.actorId, opts); return null; } catch (e: any) { return e; } };
  check("com PIN + nenhum PIN → PIN_REQUIRED", tryIssue({})?.code === "PIN_REQUIRED");
  check("com PIN + '' vazio → PIN_REQUIRED", tryIssue({ pin: "" })?.code === "PIN_REQUIRED");

  // ── 7. Com PIN + PIN errado → PIN_INVALID ───────────────────────────
  check("com PIN + PIN errado → PIN_INVALID", tryIssue({ pin: "9999" })?.code === "PIN_INVALID");

  // ── 8. Com PIN + PIN certo → emite + signed_with_pin=1 ──────────────
  const issuedPin = ClinicDocumentsService.issuePrescription(A.orgId, rxPin.id, A.actorId, { pin: "1234" });
  check("com PIN + PIN certo → emite", issuedPin.status === "issued");
  const pRow = db.prepare(`SELECT signed_with_pin FROM clinical_prescriptions WHERE id=?`).get(rxPin.id) as any;
  check("com PIN certo → signed_with_pin=1", Number(pRow.signed_with_pin) === 1);

  // ── 9. Certificate segue mesma regra ────────────────────────────────
  const cert = await seedDraftDoc(draPin, "cert");
  const tryCert = (opts: any) => { try { ClinicDocumentsService.issueCertificate(A.orgId, cert.id, A.actorId, opts); return null; } catch (e: any) { return e; } };
  check("certificate com PIN + nenhum PIN → PIN_REQUIRED", tryCert({})?.code === "PIN_REQUIRED");
  const certOk = ClinicDocumentsService.issueCertificate(A.orgId, cert.id, A.actorId, { pin: "1234" });
  check("certificate com PIN certo → emite", certOk.status === "issued");
  const cRow = db.prepare(`SELECT signed_with_pin FROM clinical_medical_certificates WHERE id=?`).get(cert.id) as any;
  check("certificate signed_with_pin=1", Number(cRow.signed_with_pin) === 1);

  // ── 10. setPin(null) limpa e volta pro modo compat ───────────────────
  const s2 = ClinicAgendaService.setProfessionalPin(A.orgId, draPin.id, null, A.actorId);
  check("setPin(null) → hasPin=false", s2.hasPin === false);
  check("hasProfessionalPin=false após clear", ClinicAgendaService.hasProfessionalPin(A.orgId, draPin.id) === false);
  const rxAfterClear = await seedDraftDoc(draPin, "rx");
  const issuedAfterClear = ClinicDocumentsService.issuePrescription(A.orgId, rxAfterClear.id, A.actorId);
  check("após clear, emite sem PIN de novo", issuedAfterClear.status === "issued");

  // ── 11. Isolamento multi-tenant ──────────────────────────────────────
  const B = seedOrg("B");
  // Profissional B com PIN "5555"
  const draB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dr B" }, B.actorId);
  ClinicAgendaService.setProfessionalPin(B.orgId, draB.id, "5555", B.actorId);
  // Tentar chamar setPin do B via orgId de A não afeta B
  const tryCross = (() => { try { ClinicAgendaService.setProfessionalPin(A.orgId, draB.id, "9999", A.actorId); return null; } catch (e: any) { return e; } })();
  check("cross-org setPin lança Profissional não encontrado", tryCross?.message?.includes("Profissional não encontrado"));
  // PIN de B intacto
  check("PIN de B intacto", ClinicAgendaService.hasProfessionalPin(B.orgId, draB.id) === true);

  // ── 12. Auditoria ────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type LIKE 'CLINIC_PROFESSIONAL_PIN_%'
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit PIN_SET ≥ 2", (map.CLINIC_PROFESSIONAL_PIN_SET || 0) >= 2, String(map.CLINIC_PROFESSIONAL_PIN_SET));
  check("audit PIN_CLEARED = 1", (map.CLINIC_PROFESSIONAL_PIN_CLEARED || 0) === 1);
  const issuedAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_PRESCRIPTION_ISSUED'
        AND metadata_json LIKE '%signedWithPin%true%'`
  ).get(A.orgId) as any;
  check("audit ISSUED com signedWithPin:true ≥ 1", Number(issuedAudit.c) >= 1, String(issuedAudit.c));

  console.log("\n=== Assinatura eletrônica com PIN (ADR-080 Fase T) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
