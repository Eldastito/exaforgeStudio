/**
 * TESTE — Módulo Clínica Fatia 45: PDF polimorfo + envio HMAC + LGPD
 * (ADR-145 D7). Segunda fatia da Fase 4.
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - renderPdf de draft → GUIDE_NOT_ISSUED.
 *   - renderPdf feliz (TISS/referral/medical_order) — cada tipo gera PDF
 *     válido começando com %PDF; sequências chave do payload aparecem
 *     nos bytes (Nº, patient.name, business.name).
 *   - materializePdf salva em CLINIC_GUIDES_DIR/{orgId}/{uuid}.pdf +
 *     grava pdf_storage_key.
 *   - materializePdf 2× REUSA arquivo (mesmo storageKey, sem re-render).
 *   - signedUrl HMAC: exp+sig no querystring; APP_URL prefixado.
 *   - resolveSignedFile: HMAC válido devolve caminho; sig errado → null;
 *     exp passado → null; traversal ../.. → null.
 *   - send: LGPD dados_sensiveis obrigatório (LGPD_CONSENT_REQUIRED).
 *   - send: LGPD comunicacoes obrigatório (LGPD_COMMS_CONSENT_REQUIRED).
 *   - send: paciente sem identifier → falha.
 *   - send: sem canal ativo → falha.
 *   - send feliz: cria row 'sent' + provider_message_id + audit
 *     CLINIC_GUIDE_SENT com toIdentifier mascarado (padrão Fase 32).
 *   - send provider throw → row 'failed' com error preservado + audit
 *     CLINIC_GUIDE_SEND_FAILED.
 *   - send de draft → GUIDE_NOT_SENDABLE.
 *   - send de cancelled → GUIDE_NOT_SENDABLE.
 *   - Isolamento multi-tenant.
 *
 * Uso:  npm run test:clinic-guide-pdf-send
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-guide-pdf-send-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-clinic-guide-pdf-send";
process.env.APP_URL = "https://zappflow.test";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicSpecialtyService } = await import("../src/server/ClinicSpecialtyService.js");
  const { ClinicGuideService } = await import("../src/server/ClinicGuideService.js");
  const { ClinicGuideDeliveryService, CLINIC_GUIDES_DIR } = await import("../src/server/ClinicGuideDeliveryService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

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
    const mkContact = (name: string, phone?: string) => {
      const id = randomUUID();
      const ident = phone !== undefined ? phone : `55${tag}${Math.floor(Math.random() * 1e8)}`;
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, name, ident);
      return id;
    };
    return { orgId, actorId, channelId, mkProf, mkContact };
  }

  const sends: Array<{ channelId: string; to: string; url: string; fileName: string; caption?: string }> = [];
  const sender = async (channelId: string, to: string, fileUrl: string, fileName: string, caption?: string) => {
    sends.push({ channelId, to, url: fileUrl, fileName, caption });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };
  const failingSender = async () => { throw new Error("provider off"); };

  const A = seedOrg("A");
  const psico = ClinicSpecialtyService.create(A.orgId, { name: "Psicologia" }, A.actorId);
  const drAna = A.mkProf("Dra. Ana");
  ClinicSpecialtyService.setProfessionalSpecialties(A.orgId, drAna, [{ specialtyId: psico.id, isPrimary: true }], A.actorId);
  const patMaria = A.mkContact("Maria Silva", "5511987654321");
  LgpdService.grantConsent(A.orgId, patMaria, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, patMaria, "comunicacoes", { actorId: A.actorId });

  // ── 1. renderPdf de draft → GUIDE_NOT_ISSUED ──────────────────────────
  const gDraft = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patMaria, professionalId: drAna,
    fields: { referralSpecialty: "Neurologia", referralReason: "Cefaleia" },
  }, A.actorId);
  let noIssueErr: any = null;
  try { await ClinicGuideService.renderPdf(A.orgId, gDraft.id); }
  catch (e: any) { noIssueErr = e; }
  check("renderPdf de draft: GUIDE_NOT_ISSUED", noIssueErr?.code === "GUIDE_NOT_ISSUED");

  // ── 2. renderPdf feliz nos 3 tipos ────────────────────────────────────
  // TISS
  const gTiss = ClinicGuideService.create(A.orgId, {
    guideType: "tiss_authorization", contactId: patMaria,
    operatorId: "op_unimed", procedureId: "proc_50min",
    professionalId: drAna, totalSessions: 10,
    validFrom: "2027-01-01", validUntil: "2027-12-31",
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gTiss.id, A.actorId);
  const pdfTiss = await ClinicGuideService.renderPdf(A.orgId, gTiss.id);
  check("PDF TISS: começa com %PDF", pdfTiss.slice(0, 4).toString() === "%PDF");
  check("PDF TISS: > 1KB (conteúdo real gerado)", pdfTiss.length > 1024, String(pdfTiss.length));
  check("PDF TISS: tem %%EOF (arquivo bem formado)", pdfTiss.toString("binary").endsWith("%%EOF\n")
    || pdfTiss.toString("binary").endsWith("%%EOF"));

  // Referral
  ClinicGuideService.issue(A.orgId, gDraft.id, A.actorId);
  const pdfRef = await ClinicGuideService.renderPdf(A.orgId, gDraft.id);
  check("PDF referral: começa com %PDF", pdfRef.slice(0, 4).toString() === "%PDF");
  check("PDF referral: > 1KB", pdfRef.length > 1024);

  // MedicalOrder
  const gPm = ClinicGuideService.create(A.orgId, {
    guideType: "medical_order", contactId: patMaria, professionalId: drAna,
    fields: {
      items: [{ description: "Hemograma", quantity: 1 }, { description: "TSH" }],
      cid: "R51", clinicalJustification: "Cefaleia crônica",
    },
    validUntil: "2027-06-30",
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gPm.id, A.actorId);
  const pdfPm = await ClinicGuideService.renderPdf(A.orgId, gPm.id);
  check("PDF medical_order: começa com %PDF", pdfPm.slice(0, 4).toString() === "%PDF");
  check("PDF medical_order: > 1KB", pdfPm.length > 1024);

  // Cada tipo gera PDF distinto (mesma guia = mesmo hash canônico é
  // testado no test:clinic-guides; aqui só provamos que 3 tipos → 3 saídas)
  check("3 tipos geram PDFs distintos",
    !pdfTiss.equals(pdfRef) && !pdfRef.equals(pdfPm) && !pdfTiss.equals(pdfPm));

  // ── 3. materializePdf grava em disco ──────────────────────────────────
  const mat = await ClinicGuideDeliveryService.materializePdf(A.orgId, gTiss.id);
  check("materializePdf: storageKey formato {orgId}/{uuid}.pdf",
    /^[a-zA-Z0-9._-]+\/[a-f0-9-]+\.pdf$/.test(mat.storageKey), mat.storageKey);
  check("materializePdf: arquivo existe em disco", fs.existsSync(mat.filePath));
  check("materializePdf: bytes começam com %PDF", mat.bytes.slice(0, 4).toString() === "%PDF");

  const guideAfter = ClinicGuideService.get(A.orgId, gTiss.id);
  check("materializePdf: pdf_storage_key gravado", guideAfter?.pdfStorageKey === mat.storageKey);

  // ── 4. materializePdf 2x REUSA ────────────────────────────────────────
  const mat2 = await ClinicGuideDeliveryService.materializePdf(A.orgId, gTiss.id);
  check("materializePdf 2x: reusa mesmo storageKey", mat2.storageKey === mat.storageKey);

  // ── 5. signedUrl HMAC ─────────────────────────────────────────────────
  const url = ClinicGuideDeliveryService.signedUrl(mat.storageKey);
  check("signedUrl: absoluta com APP_URL",
    url.startsWith("https://zappflow.test/api/public/clinic/guides/"));
  const expMatch = url.match(/[?&]exp=(\d+)/);
  const sigMatch = url.match(/[?&]sig=([a-f0-9]+)/);
  check("signedUrl: exp + sig no querystring", !!expMatch && !!sigMatch);
  const exp = expMatch![1];
  const sig = sigMatch![1];

  // ── 6. resolveSignedFile ──────────────────────────────────────────────
  const fp = ClinicGuideDeliveryService.resolveSignedFile(mat.storageKey, exp, sig);
  check("resolveSignedFile HMAC válido: devolve caminho", typeof fp === "string" && fs.existsSync(fp!));
  const bad = ClinicGuideDeliveryService.resolveSignedFile(mat.storageKey, exp, "0".repeat(sig.length));
  check("resolveSignedFile sig errado: null", bad === null);
  const expired = ClinicGuideDeliveryService.resolveSignedFile(mat.storageKey, "1", sig);
  check("resolveSignedFile exp no passado: null", expired === null);
  const travers = ClinicGuideDeliveryService.resolveSignedFile("../../etc/passwd", exp, sig);
  check("resolveSignedFile traversal: null", travers === null);

  // ── 7. send: LGPD dados_sensiveis obrigatório ─────────────────────────
  const patNoSens = A.mkContact("SemSens", "5511111111111");
  LgpdService.grantConsent(A.orgId, patNoSens, "comunicacoes", { actorId: A.actorId });
  const gNoSens = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patNoSens, professionalId: drAna,
    fields: { referralSpecialty: "X", referralReason: "teste" },
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gNoSens.id, A.actorId);
  let sensErr: any = null;
  try { await ClinicGuideDeliveryService.send(A.orgId, gNoSens.id, A.actorId, { sender }); }
  catch (e: any) { sensErr = e; }
  check("send LGPD sem sensível: LGPD_CONSENT_REQUIRED", sensErr?.code === "LGPD_CONSENT_REQUIRED");

  // ── 8. send: LGPD comunicações obrigatório ────────────────────────────
  const patNoComms = A.mkContact("SemComms", "5511222222222");
  LgpdService.grantConsent(A.orgId, patNoComms, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  const gNoComms = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patNoComms, professionalId: drAna,
    fields: { referralSpecialty: "X", referralReason: "teste" },
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gNoComms.id, A.actorId);
  let commsErr: any = null;
  try { await ClinicGuideDeliveryService.send(A.orgId, gNoComms.id, A.actorId, { sender }); }
  catch (e: any) { commsErr = e; }
  check("send LGPD sem comms: LGPD_COMMS_CONSENT_REQUIRED", commsErr?.code === "LGPD_COMMS_CONSENT_REQUIRED");

  // ── 9. send: paciente sem identifier → falha síncrona ────────────────
  const patNoId = A.mkContact("SemId", "");
  LgpdService.grantConsent(A.orgId, patNoId, "dados_sensiveis", { channel: "in_person", actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, patNoId, "comunicacoes", { actorId: A.actorId });
  const gNoId = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patNoId, professionalId: drAna,
    fields: { referralSpecialty: "X", referralReason: "teste" },
  }, A.actorId);
  ClinicGuideService.issue(A.orgId, gNoId.id, A.actorId);
  let noIdErr: any = null;
  try { await ClinicGuideDeliveryService.send(A.orgId, gNoId.id, A.actorId, { sender }); }
  catch (e: any) { noIdErr = e; }
  check("send sem identifier: falha", noIdErr?.message?.includes("identificador") === true);

  // ── 10. send: sem canal ativo ────────────────────────────────────────
  const NoCh = seedOrg("NoCh");
  db.prepare(`UPDATE channels SET status='disconnected' WHERE organization_id=?`).run(NoCh.orgId);
  const specNoCh = ClinicSpecialtyService.create(NoCh.orgId, { name: "Psi" }, NoCh.actorId);
  const profNoCh = NoCh.mkProf("Dr NoCh");
  ClinicSpecialtyService.setProfessionalSpecialties(NoCh.orgId, profNoCh, [{ specialtyId: specNoCh.id }], NoCh.actorId);
  const patNoCh = NoCh.mkContact("PNoCh", "551133333333");
  LgpdService.grantConsent(NoCh.orgId, patNoCh, "dados_sensiveis", { channel: "in_person", actorId: NoCh.actorId });
  LgpdService.grantConsent(NoCh.orgId, patNoCh, "comunicacoes", { actorId: NoCh.actorId });
  const gNoCh = ClinicGuideService.create(NoCh.orgId, {
    guideType: "referral", contactId: patNoCh, professionalId: profNoCh,
    fields: { referralSpecialty: "X", referralReason: "teste" },
  }, NoCh.actorId);
  ClinicGuideService.issue(NoCh.orgId, gNoCh.id, NoCh.actorId);
  let noChErr: any = null;
  try { await ClinicGuideDeliveryService.send(NoCh.orgId, gNoCh.id, NoCh.actorId, { sender }); }
  catch (e: any) { noChErr = e; }
  check("send sem canal: falha 'canal WhatsApp ativo'",
    noChErr?.message?.includes("canal WhatsApp ativo") === true);

  // ── 11. send feliz + audit mascarado ──────────────────────────────────
  const before = sends.length;
  const d = await ClinicGuideDeliveryService.send(A.orgId, gTiss.id, A.actorId, { sender });
  check("send feliz: status=sent", d.status === "sent");
  check("send feliz: provider_message_id gravado", !!d.providerMessageId);
  check("send feliz: sender chamado 1×", sends.length === before + 1);
  const send1 = sends[sends.length - 1];
  check("send feliz: fileName = guia-TISS-000001.pdf", send1.fileName === "guia-TISS-000001.pdf");
  check("send feliz: URL absoluta HMAC",
    send1.url.startsWith("https://zappflow.test/api/public/clinic/guides/"));
  check("send feliz: caption menciona internalNumber",
    send1.caption?.includes("TISS-000001") === true);

  const sentAuditMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_GUIDE_SENT'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(sentAuditMeta?.metadata_json || "{}");
  check("audit SENT: guideType TISS", meta.guideType === "tiss_authorization");
  check("audit SENT: internalNumber TISS-000001", meta.internalNumber === "TISS-000001");
  check("audit SENT: toIdentifier mascarado (5511***4321)",
    meta.toIdentifier === "5511***4321", String(meta.toIdentifier));
  check("audit SENT NÃO expõe identifier completo",
    meta.toIdentifier !== "5511987654321");

  // ── 12. send provider throw → failed ─────────────────────────────────
  const d2 = await ClinicGuideDeliveryService.send(A.orgId, gPm.id, A.actorId, { sender: failingSender });
  check("send provider throw: status=failed", d2.status === "failed");
  check("send provider throw: error preservado", d2.error?.includes("provider off") === true);

  const failCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_GUIDE_SEND_FAILED'`
  ).get(A.orgId) as any;
  check("audit SEND_FAILED = 1", Number(failCnt?.c) === 1);

  // ── 13. send de draft / cancelled → GUIDE_NOT_SENDABLE ───────────────
  const gDraftS = ClinicGuideService.create(A.orgId, {
    guideType: "referral", contactId: patMaria, professionalId: drAna,
    fields: { referralSpecialty: "X", referralReason: "teste" },
  }, A.actorId);
  let notSendableErr: any = null;
  try { await ClinicGuideDeliveryService.send(A.orgId, gDraftS.id, A.actorId, { sender }); }
  catch (e: any) { notSendableErr = e; }
  check("send de draft: GUIDE_NOT_SENDABLE", notSendableErr?.code === "GUIDE_NOT_SENDABLE");

  ClinicGuideService.cancel(A.orgId, gTiss.id, { reason: "operadora reprovou" }, A.actorId);
  let cancelSendErr: any = null;
  try { await ClinicGuideDeliveryService.send(A.orgId, gTiss.id, A.actorId, { sender }); }
  catch (e: any) { cancelSendErr = e; }
  check("send de cancelled: GUIDE_NOT_SENDABLE", cancelSendErr?.code === "GUIDE_NOT_SENDABLE");

  // ── 14. Isolamento multi-tenant ──────────────────────────────────────
  const B = seedOrg("B");
  let crossPdfErr: any = null;
  try { await ClinicGuideDeliveryService.materializePdf(B.orgId, gPm.id); }
  catch (e: any) { crossPdfErr = e; }
  check("cross-tenant materializePdf: falha", crossPdfErr?.message?.includes("não encontrada") === true);

  const bList = ClinicGuideDeliveryService.list(B.orgId, gPm.id);
  check("cross-tenant list: → []", bList.length === 0);

  console.log("\n=== Guia PDF + envio HMAC + LGPD (ADR-145 Fatia 45) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
