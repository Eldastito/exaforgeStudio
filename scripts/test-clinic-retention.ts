/**
 * TESTE — Módulo Clínica Fase U: Retenção LGPD / purge automático
 * ---------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - Config default: enabled=true, deliveryDays=30, attachmentDays=730;
 *   - runForOrg com retention disabled → stats zerados;
 *   - Anexo RECENTE (dentro da janela) → NÃO apaga;
 *   - Anexo VELHO (fora da janela) → apaga arquivo + marca purged_at;
 *   - Row do anexo NÃO é deletada (preservado pra histórico);
 *   - PDF de delivery velho no CLINIC_DOCS_DIR → apaga;
 *   - PDF novo → mantém;
 *   - Row de delivery `sent` velha → marca file_purged_at;
 *   - Idempotência: rodar 2× não muda contadores;
 *   - Storage key inválido/path traversal → conta como erro, não apaga
 *     arquivo fora;
 *   - Isolamento multi-tenant: purge de A não afeta B;
 *   - Auditoria CLINIC_RETENTION_PURGE só se apagou algo.
 *
 * Uso:  npm run test:clinic-retention
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-ret-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-ret-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

const PNG_1x1 = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c62000100000005000101" +
  "0d0a2db40000000049454e44ae426082", "hex");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicAttachmentService, PRIVATE_CLINICAL_DIR } = await import("../src/server/ClinicAttachmentService.js");
  const { CLINIC_DOCS_DIR } = await import("../src/server/ClinicDocumentDeliveryService.js");
  const { ClinicRetentionService } = await import("../src/server/ClinicRetentionService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string, opts: { enabled?: boolean; deliveryDays?: number; attachmentDays?: number } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, clinic_retention_enabled, clinic_retention_days_deliveries, clinic_retention_days_attachments) VALUES (?, ?, ?, 'active', ?, ?, ?)`)
      .run(randomUUID(), orgId, `Clínica ${tag}`, opts.enabled === false ? 0 : 1, opts.deliveryDays ?? 30, opts.attachmentDays ?? 730);
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
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra." }, A.actorId);
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "T", scheduledStart: new Date(Date.now() - 800 * 86400_000).toISOString(),
    professionalId: dra.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);

  // Anexos: 1 recente (agora), 1 velho (1000 dias atrás — fora da janela 730)
  const attRecent = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PNG_1x1, mime: "image/png", originalFilename: "recente.png", label: "Recente",
  }, A.actorId);
  const attOld = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PNG_1x1, mime: "image/png", originalFilename: "velho.png", label: "Velho",
  }, A.actorId);
  db.prepare(`UPDATE clinical_encounter_attachments SET uploaded_at = datetime('now', ?) WHERE id = ?`)
    .run("-1000 days", attOld.id);

  const oldPath = path.join(PRIVATE_CLINICAL_DIR, A.orgId, enc.id, attOld.storageKey);
  const recPath = path.join(PRIVATE_CLINICAL_DIR, A.orgId, enc.id, attRecent.storageKey);
  check("arquivo do anexo velho existe (pré-purge)", fs.existsSync(oldPath));
  check("arquivo do anexo recente existe (pré-purge)", fs.existsSync(recPath));

  // PDFs de delivery: cria 2 arquivos no CLINIC_DOCS_DIR, um velho outro novo
  fs.mkdirSync(CLINIC_DOCS_DIR, { recursive: true });
  const oldPdf = path.join(CLINIC_DOCS_DIR, `${randomUUID()}.pdf`);
  const newPdf = path.join(CLINIC_DOCS_DIR, `${randomUUID()}.pdf`);
  fs.writeFileSync(oldPdf, "%PDF-old");
  fs.writeFileSync(newPdf, "%PDF-new");
  // Backdatea mtime do oldPdf pra fora da janela 30 dias
  const past = Date.now() - 60 * 86400_000;
  fs.utimesSync(oldPdf, past / 1000, past / 1000);

  // Insere row de delivery `sent` velha
  const deliveryId = randomUUID();
  db.prepare(
    `INSERT INTO clinical_document_deliveries (id, organization_id, doc_kind, doc_id, contact_id, channel_id, to_identifier, status, sent_at)
     VALUES (?, ?, 'prescription', 'doc-x', ?, ?, '55x', 'sent', datetime('now','-60 days'))`
  ).run(deliveryId, A.orgId, A.contactId, "ch_A");

  // ── 1. Config default respeitado ─────────────────────────────────────
  const stats = ClinicRetentionService.runForOrg(A.orgId);
  check("anexo velho apagado (attachmentsPurged=1)", stats.attachmentsPurged === 1);
  check("PDF velho apagado (deliveriesPurged >= 1)", stats.deliveriesPurged >= 1);
  check("erros = 0", stats.errors === 0);
  check("arquivo do anexo velho SUMIU do disco", !fs.existsSync(oldPath));
  check("arquivo do anexo recente MANTIDO", fs.existsSync(recPath));
  check("PDF velho SUMIU", !fs.existsSync(oldPdf));
  check("PDF novo MANTIDO", fs.existsSync(newPdf));

  // Row do anexo preservada + purged_at setado
  const attOldRow = db.prepare(`SELECT purged_at FROM clinical_encounter_attachments WHERE id = ?`).get(attOld.id) as any;
  check("row do anexo velho preservada", !!attOldRow);
  check("purged_at do anexo velho setado", !!attOldRow.purged_at);
  // Row do recente sem purged_at
  const attRecRow = db.prepare(`SELECT purged_at FROM clinical_encounter_attachments WHERE id = ?`).get(attRecent.id) as any;
  check("recente ainda sem purged_at", !attRecRow.purged_at);

  // Row de delivery preservada + file_purged_at setado
  const delRow = db.prepare(`SELECT status, file_purged_at FROM clinical_document_deliveries WHERE id = ?`).get(deliveryId) as any;
  check("delivery status preservado 'sent'", delRow.status === "sent");
  check("file_purged_at setado", !!delRow.file_purged_at);

  // ── 2. Idempotência: 2ª rodada não conta os mesmos ──────────────────
  const stats2 = ClinicRetentionService.runForOrg(A.orgId);
  check("2ª rodada: attachmentsPurged=0 (já limpo)", stats2.attachmentsPurged === 0);
  check("2ª rodada: PDF novo continua (deliveriesPurged=0)", stats2.deliveriesPurged === 0);

  // ── 3. Retention disabled → stats zerados ────────────────────────────
  const B = seedOrg("B", { enabled: false });
  const draB = ClinicAgendaService.createProfessional(B.orgId, { name: "Dr" }, B.actorId);
  const aptB = ClinicAgendaService.createAppointment(B.orgId, {
    contactId: B.contactId, title: "T", scheduledStart: new Date(Date.now() - 1000 * 86400_000).toISOString(),
    professionalId: draB.id, durationMinutes: 30, force: true,
  }, B.actorId);
  const encB = ClinicEncounterService.open(B.orgId, aptB.id, B.actorId);
  const attB = ClinicAttachmentService.add(B.orgId, encB.id, {
    buffer: PNG_1x1, mime: "image/png", originalFilename: "b.png", label: "B",
  }, B.actorId);
  db.prepare(`UPDATE clinical_encounter_attachments SET uploaded_at = datetime('now', ?) WHERE id = ?`).run("-1000 days", attB.id);
  const statsB = ClinicRetentionService.runForOrg(B.orgId);
  check("B disabled: stats zerados", statsB.attachmentsPurged === 0 && statsB.deliveriesPurged === 0);
  const attBPath = path.join(PRIVATE_CLINICAL_DIR, B.orgId, encB.id, attB.storageKey);
  check("B disabled: arquivo velho preservado", fs.existsSync(attBPath));

  // ── 4. Isolamento multi-tenant ───────────────────────────────────────
  // A já purgou; B não tem purge — verificar que A não afetou B
  const attBAfter = db.prepare(`SELECT purged_at FROM clinical_encounter_attachments WHERE id = ?`).get(attB.id) as any;
  check("cross-org isolamento: anexo de B sem purged_at", !attBAfter.purged_at);

  // ── 5. Storage key com path traversal → conta erro sem apagar fora ───
  // Manualmente sujar um row (drop no DB direto, simula legado corrompido):
  const badId = randomUUID();
  db.prepare(
    `INSERT INTO clinical_encounter_attachments (id, organization_id, encounter_id, appointment_id, contact_id, label, kind, mime_type, original_filename, storage_key, size_bytes, uploaded_by, uploaded_at)
     VALUES (?, ?, ?, ?, ?, ?, 'image', 'image/png', 'x.png', '../etc/passwd', 42, ?, datetime('now','-1000 days'))`
  ).run(badId, A.orgId, enc.id, apt.id, A.contactId, "bad", A.actorId);
  const statsBad = ClinicRetentionService.runForOrg(A.orgId);
  check("storage_key com traversal → conta como erro sem apagar fora", statsBad.errors >= 1);
  // O row bad ainda existe (não marca purged_at porque nunca chegou a apagar)
  const badRow = db.prepare(`SELECT purged_at FROM clinical_encounter_attachments WHERE id = ?`).get(badId) as any;
  check("row bad NÃO marcada purged_at", !badRow.purged_at);

  // ── 6. Auditoria só quando apagou algo ───────────────────────────────
  const auditsA = db.prepare(`SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id=? AND event_type='CLINIC_RETENTION_PURGE'`).get(A.orgId) as any;
  const auditsB = db.prepare(`SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id=? AND event_type='CLINIC_RETENTION_PURGE'`).get(B.orgId) as any;
  check("A: audit RETENTION_PURGE ≥ 1", Number(auditsA.c) >= 1, String(auditsA.c));
  check("B: audit RETENTION_PURGE = 0 (disabled, nada purgado)", Number(auditsB.c) === 0);

  console.log("\n=== Retenção LGPD (ADR-080 Fase U) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
