/**
 * TESTE — Módulo Clínica Fatia 27: Recibo particular
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - CRUD: create com valor válido em centavos, payment_method whitelist,
 *     description/notes trimados; update bloqueado após issued (DOCUMENT_ISSUED);
 *     validações RECEIPT_INVALID_AMOUNT / RECEIPT_INVALID_PAYMENT_METHOD /
 *     RECEIPT_INVALID_DOCUMENT_TYPE.
 *   - LGPD Art.11: create/update/get/issue lançam LGPD_CONSENT_REQUIRED
 *     sem consent; row inexistente NÃO gata (return null).
 *   - Issue idempotente + snapshot completo (profissional, negócio, CNPJ,
 *     paciente); depois de issued, o cadastro do profissional pode mudar
 *     sem afetar o recibo.
 *   - PIN opcional (reusa verifyPin da Fase T): sem PIN → signed=false;
 *     com PIN configurado → PIN_REQUIRED/PIN_INVALID/certo; certo →
 *     signed_with_pin=true + hash SHA-256 64 hex + timestamp ISO.
 *   - PDF (`renderPdf`): magic %PDF-, contém nome do paciente, valor em BRL,
 *     forma de pagamento em pt-BR, "Emitido por" com CNPJ quando presente,
 *     rodapé "Assinado eletronicamente" só quando signed_with_pin, PDF
 *     signed > PDF sem PIN, rascunho ganha "RASCUNHO" watermark.
 *   - Delivery ('receipt') via ClinicDocumentDeliveryService: gera PDF,
 *     envia via sender injetável, status='sent' + provider_message_id.
 *   - Timeline (Fase 21) traz kind='receipt_issued' com summary
 *     contendo o valor em BRL.
 *   - Métricas (`ClinicMetricsService.overview`) traz receiptsIssued e
 *     receiptsTotalCents somando só os issued.
 *   - Isolamento multi-tenant.
 *   - Auditoria: CREATED / UPDATED / ISSUED com metadata correto.
 *
 * Uso:  npm run test:clinic-receipt
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-receipt-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-receipt-1234567890";
process.env.APP_URL = "https://zappflow.test";

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
  const { ClinicReceiptService } = await import("../src/server/ClinicReceiptService.js");
  const { ClinicDocumentDeliveryService } = await import("../src/server/ClinicDocumentDeliveryService.js");
  const { ClinicPatientTimelineService } = await import("../src/server/ClinicPatientTimelineService.js");
  const { ClinicMetricsService } = await import("../src/server/ClinicMetricsService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string, opts: { cnpj?: string } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    if (opts.cnpj) {
      db.prepare(`UPDATE organization_settings SET clinic_receipt_business_document = ?, clinic_receipt_business_document_type = 'cnpj' WHERE organization_id = ?`)
        .run(opts.cnpj, orgId);
    }
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}${Math.floor(Math.random() * 1e8)}`);
    LgpdService.grantConsent(orgId, contactId, "dados_sensiveis", { actorId: `user_${tag}` });
    LgpdService.grantConsent(orgId, contactId, "comunicacoes", { actorId: `user_${tag}` });
    return { orgId, actorId: `user_${tag}`, contactId, channelId };
  }

  function openDraftEncounter(seed: { orgId: string; actorId: string; contactId: string }, profId: string, startISO: string) {
    const apt = ClinicAgendaService.createAppointment(seed.orgId, {
      contactId: seed.contactId, title: "T", scheduledStart: startISO,
      professionalId: profId, durationMinutes: 30, force: true,
    }, seed.actorId);
    return ClinicEncounterService.open(seed.orgId, apt.id, seed.actorId);
  }

  const A = seedOrg("A", { cnpj: "12.345.678/0001-90" });
  const draA = ClinicAgendaService.createProfessional(A.orgId, {
    name: "Dra. Ana", registrationNumber: "12345", council: "CRM/SP",
  }, A.actorId);
  const enc = openDraftEncounter(A, draA.id, "2026-11-01T09:00:00-03:00");

  // ── 1. CRUD básico ───────────────────────────────────────────────────────
  const r1 = ClinicReceiptService.create(A.orgId, enc.id, {
    amountCents: 25000, paymentMethod: "pix", description: "Consulta clínica",
    patientDocument: "123.456.789-00", patientDocumentType: "cpf",
  }, A.actorId);
  check("create devolve id", !!r1.id);
  check("amountCents preservado", r1.amountCents === 25000);
  check("paymentMethod preservado", r1.paymentMethod === "pix");
  check("description trimada", r1.description === "Consulta clínica");
  check("patientDocument preservado", r1.patientDocument === "123.456.789-00");
  check("status default draft", r1.status === "draft");
  check("signed_with_pin default false", r1.signedWithPin === false);

  // Validações
  let threwAmt: any = null;
  try { ClinicReceiptService.create(A.orgId, enc.id, { amountCents: 0, paymentMethod: "pix" }, A.actorId); } catch (e) { threwAmt = e; }
  check("amount 0 → RECEIPT_INVALID_AMOUNT", threwAmt?.code === "RECEIPT_INVALID_AMOUNT");

  let threwAmtNeg: any = null;
  try { ClinicReceiptService.create(A.orgId, enc.id, { amountCents: -100, paymentMethod: "pix" }, A.actorId); } catch (e) { threwAmtNeg = e; }
  check("amount negativo → RECEIPT_INVALID_AMOUNT", threwAmtNeg?.code === "RECEIPT_INVALID_AMOUNT");

  let threwMethod: any = null;
  try {
    // @ts-expect-error test
    ClinicReceiptService.create(A.orgId, enc.id, { amountCents: 100, paymentMethod: "bitcoin" }, A.actorId);
  } catch (e) { threwMethod = e; }
  check("payment_method fora da whitelist → RECEIPT_INVALID_PAYMENT_METHOD", threwMethod?.code === "RECEIPT_INVALID_PAYMENT_METHOD");

  let threwDocType: any = null;
  try {
    // @ts-expect-error test
    ClinicReceiptService.create(A.orgId, enc.id, { amountCents: 100, paymentMethod: "pix", patientDocumentType: "rg" }, A.actorId);
  } catch (e) { threwDocType = e; }
  check("documentType inválido → RECEIPT_INVALID_DOCUMENT_TYPE", threwDocType?.code === "RECEIPT_INVALID_DOCUMENT_TYPE");

  // Update
  const r1v2 = ClinicReceiptService.update(A.orgId, r1.id, A.actorId, {
    amountCents: 30000, notes: "revisão pré-emissão",
  });
  check("update amount OK", r1v2.amountCents === 30000);
  check("update notes preservadas", r1v2.notes === "revisão pré-emissão");

  // ── 2. LGPD gate ─────────────────────────────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.contactId, "dados_sensiveis", A.actorId);

  let threwGet: any = null;
  try { ClinicReceiptService.get(A.orgId, r1.id); } catch (e) { threwGet = e; }
  check("get após revoke → LGPD_CONSENT_REQUIRED", threwGet?.code === "LGPD_CONSENT_REQUIRED");

  let threwCreate: any = null;
  try { ClinicReceiptService.create(A.orgId, enc.id, { amountCents: 100, paymentMethod: "pix" }, A.actorId); } catch (e) { threwCreate = e; }
  check("create após revoke → LGPD_CONSENT_REQUIRED", threwCreate?.code === "LGPD_CONSENT_REQUIRED");

  let threwUpd: any = null;
  try { ClinicReceiptService.update(A.orgId, r1.id, A.actorId, { amountCents: 200 }); } catch (e) { threwUpd = e; }
  check("update após revoke → LGPD_CONSENT_REQUIRED", threwUpd?.code === "LGPD_CONSENT_REQUIRED");

  // Row inexistente NÃO gata consent (padrão)
  check("get inexistente devolve null (não gata)",
    ClinicReceiptService.get(A.orgId, randomUUID()) === null);

  LgpdService.grantConsent(A.orgId, A.contactId, "dados_sensiveis", { actorId: A.actorId });

  // ── 3. Issue idempotente + snapshot ──────────────────────────────────────
  const issued = ClinicReceiptService.issue(A.orgId, r1.id, A.actorId);
  check("issue OK", issued.status === "issued");
  check("issue devolve issuedAt", !!issued.issuedAt);
  check("issue snapshot profissional (nome)", issued.professionalNameSnapshot === "Dra. Ana");
  check("issue snapshot profissional (registro)", issued.professionalRegistrationSnapshot === "12345");
  check("issue snapshot profissional (conselho)", issued.professionalCouncilSnapshot === "CRM/SP");
  check("issue snapshot negócio (nome)", issued.businessNameSnapshot === "Clínica A");
  check("issue snapshot negócio (CNPJ)", issued.businessDocumentSnapshot === "12.345.678/0001-90");
  check("issue snapshot negócio (tipo)", issued.businessDocumentTypeSnapshot === "cnpj");
  check("issue snapshot paciente (nome)", issued.patientNameSnapshot === "Paciente A");
  check("sem PIN configurado: signedWithPin=false", issued.signedWithPin === false);
  check("sem PIN: signatureHash NULL", issued.signatureHash === null);

  // Idempotência
  const issuedAgain = ClinicReceiptService.issue(A.orgId, r1.id, A.actorId);
  check("issue idempotente", issuedAgain.id === issued.id && issuedAgain.issuedAt === issued.issuedAt);

  // Update bloqueado pós-issued
  let threwPost: any = null;
  try { ClinicReceiptService.update(A.orgId, r1.id, A.actorId, { amountCents: 999 }); } catch (e) { threwPost = e; }
  check("update pós-issued → DOCUMENT_ISSUED", threwPost?.code === "DOCUMENT_ISSUED");

  // Snapshot resistente: mudo cadastro do profissional depois — recibo mantém snap
  db.prepare(`UPDATE clinic_professionals SET name = ?, registration_number = ? WHERE id = ?`)
    .run("Dra. Ana OUTRO", "99999", draA.id);
  const stillIssued = ClinicReceiptService.get(A.orgId, r1.id);
  check("snapshot resistente: nome preservado mesmo após alterar cadastro",
    stillIssued?.professionalNameSnapshot === "Dra. Ana");
  check("snapshot resistente: registro preservado", stillIssued?.professionalRegistrationSnapshot === "12345");

  // ── 4. PIN opcional (reusa Fase T) ───────────────────────────────────────
  const drPin = ClinicAgendaService.createProfessional(A.orgId, { name: "Dr. PIN", registrationNumber: "77777", council: "CRM/SP" }, A.actorId);
  ClinicAgendaService.setProfessionalPin(A.orgId, drPin.id, "4242", A.actorId);
  const encPin = openDraftEncounter(A, drPin.id, "2026-11-02T10:00:00-03:00");
  const rPin = ClinicReceiptService.create(A.orgId, encPin.id, {
    amountCents: 40000, paymentMethod: "credit",
  }, A.actorId);

  let threwPinReq: any = null;
  try { ClinicReceiptService.issue(A.orgId, rPin.id, A.actorId); } catch (e) { threwPinReq = e; }
  check("issue prof com PIN sem PIN → PIN_REQUIRED", threwPinReq?.code === "PIN_REQUIRED");

  let threwPinBad: any = null;
  try { ClinicReceiptService.issue(A.orgId, rPin.id, A.actorId, { pin: "0000" }); } catch (e) { threwPinBad = e; }
  check("issue com PIN errado → PIN_INVALID", threwPinBad?.code === "PIN_INVALID");

  const issuedWithPin = ClinicReceiptService.issue(A.orgId, rPin.id, A.actorId, { pin: "4242" });
  check("issue com PIN certo: signedWithPin=true", issuedWithPin.signedWithPin === true);
  check("issue com PIN: signatureHash 64 hex", /^[a-f0-9]{64}$/.test(String(issuedWithPin.signatureHash)));
  check("issue com PIN: signatureTimestamp ISO", /^\d{4}-\d{2}-\d{2}T/.test(String(issuedWithPin.signatureTimestamp)));

  // ── 5. PDF ───────────────────────────────────────────────────────────────
  const pdfNoPin = await ClinicReceiptService.renderPdf(A.orgId, r1.id);
  check("PDF sem PIN: magic %PDF-", pdfNoPin.slice(0, 5).toString() === "%PDF-");
  const textNoPin = await pdfText(pdfNoPin);
  check("PDF sem PIN: nome do paciente", textNoPin.includes("Paciente A"));
  check("PDF sem PIN: valor em BRL (R$ 300,00)", textNoPin.includes("R$") && textNoPin.includes("300,00"));
  check("PDF sem PIN: forma de pagamento Pix", textNoPin.includes("Pix"));
  check("PDF sem PIN: CNPJ do negócio", textNoPin.includes("12.345.678/0001-90"));
  check("PDF sem PIN: nome do negócio", textNoPin.includes("Clínica A"));
  check("PDF sem PIN: SEM rodapé eletrônico", !textNoPin.includes("Assinado eletronicamente"));

  const pdfPin = await ClinicReceiptService.renderPdf(A.orgId, rPin.id);
  const textPin = await pdfText(pdfPin);
  check("PDF com PIN: contém 'Assinado eletronicamente'", textPin.includes("Assinado eletronicamente"));
  check("PDF com PIN: contém 'Hash SHA-256'", textPin.includes("Hash SHA-256"));
  check("PDF com PIN: hash literal aparece", textPin.includes(String(issuedWithPin.signatureHash)));
  check("PDF signed > PDF sem PIN", pdfPin.length > pdfNoPin.length);

  // Rascunho: watermark
  const rDraft = ClinicReceiptService.create(A.orgId, enc.id, { amountCents: 10000, paymentMethod: "cash" }, A.actorId);
  const pdfDraft = await ClinicReceiptService.renderPdf(A.orgId, rDraft.id);
  const textDraft = await pdfText(pdfDraft);
  check("PDF rascunho: watermark 'RASCUNHO'", textDraft.includes("RASCUNHO"));

  // ── 6. Delivery ('receipt') ──────────────────────────────────────────────
  const sends: Array<{ channelId: string; to: string; url: string }> = [];
  const sender = async (channelId: string, to: string, url: string) => {
    sends.push({ channelId, to, url });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };
  const delivery = await ClinicDocumentDeliveryService.send(A.orgId, "receipt" as any, r1.id, A.actorId, { sender: sender as any });
  check("delivery receipt: status=sent", delivery.status === "sent");
  check("delivery receipt: sender chamado 1×", sends.length === 1);
  check("delivery receipt: provider_message_id", !!delivery.providerMessageId);

  // ── 7. Timeline ──────────────────────────────────────────────────────────
  const tl = ClinicPatientTimelineService.getTimeline(A.orgId, A.contactId);
  // Busca pelo refId, não pelo "primeiro receipt_issued": r1 e rPin são do
  // mesmo kind e, quando os issued_at caem em segundos distintos, a ordem
  // DESC muda qual vem primeiro — o teste não pode depender desse empate.
  const recItem = tl.items.find((it: any) => it.kind === "receipt_issued" && it.refId === r1.id);
  check("timeline traz kind='receipt_issued' do r1 (refId)", !!recItem);
  check("timeline summary contém valor em BRL", recItem?.summary?.includes("R$") === true);
  check("timeline summary contém '300,00'", recItem?.summary?.includes("300,00") === true);

  // ── 8. Métricas ──────────────────────────────────────────────────────────
  // Janela ampla que cobre issue de r1 e rPin (hoje).
  const from = new Date(Date.now() - 30 * 86400_000).toISOString();
  const to = new Date(Date.now() + 30 * 86400_000).toISOString();
  const metrics = ClinicMetricsService.overview(A.orgId, { from, to });
  check("metrics receiptsIssued ≥ 2 (r1 + rPin)", metrics.documents.receiptsIssued >= 2, String(metrics.documents.receiptsIssued));
  check("metrics receiptsTotalCents inclui r1 (30000) + rPin (40000) = 70000",
    metrics.documents.receiptsTotalCents >= 70000, String(metrics.documents.receiptsTotalCents));

  // ── 9. Isolamento multi-tenant ───────────────────────────────────────────
  const B = seedOrg("B");
  check("cross-tenant: get de r1 na org B → null", ClinicReceiptService.get(B.orgId, r1.id) === null);
  check("cross-tenant: listByEncounter em B com encounter de A → []",
    ClinicReceiptService.listByEncounter(B.orgId, enc.id).length === 0);

  // ── 10. Auditoria ────────────────────────────────────────────────────────
  const createdAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_RECEIPT_CREATED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_RECEIPT_CREATED ≥ 3", Number(createdAudit?.c) >= 3, String(createdAudit?.c));

  const issuedAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_RECEIPT_ISSUED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_RECEIPT_ISSUED ≥ 2 (r1 + rPin)", Number(issuedAudit?.c) >= 2, String(issuedAudit?.c));

  const updAudit = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_RECEIPT_UPDATED'`
  ).get(A.orgId) as any;
  check("audit CLINIC_RECEIPT_UPDATED ≥ 1", Number(updAudit?.c) >= 1);

  const issuedMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_RECEIPT_ISSUED'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(issuedMeta?.metadata_json || "{}");
  check("audit metadata: receiptId presente", typeof meta.receiptId === "string" && meta.receiptId.length > 0);
  check("audit metadata: amountCents presente", meta.amountCents === 30000);
  check("audit metadata: signedWithPin explícito", typeof meta.signedWithPin === "boolean");

  console.log("\n=== Recibo particular (ADR-080 Fase 27) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
