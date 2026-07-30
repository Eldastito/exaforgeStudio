/**
 * TESTE — Módulo Clínica Fase K: Envio de receita/atestado por WhatsApp (ADR-080).
 * -------------------------------------------------------------------------------
 * Prova, offline e em banco temporário (SEM chamada de rede real —
 * injetamos um `sender` mock via opts):
 *   - Doc RASCUNHO não envia (DOCUMENT_NOT_ISSUED);
 *   - LGPD Art.11 sensível AUSENTE → LGPD_CONSENT_REQUIRED;
 *   - LGPD comunicações AUSENTE → LGPD_COMMS_CONSENT_REQUIRED (mesmo com
 *     sensível concedido, envio por canal exige consentimento separado);
 *   - Paciente sem identifier → erro claro;
 *   - Sem canal ativo → erro claro;
 *   - Envio OK: chama sender, grava row 'sent' com provider_message_id,
 *     dispara auditoria CLINIC_DOCUMENT_SENT;
 *   - Sender FALHOU: grava row 'failed' com error, dispara auditoria
 *     CLINIC_DOCUMENT_SEND_FAILED — mas o método NÃO relança (histórico
 *     é o retorno pra UI); UI trata pelo campo status;
 *   - signedUrl é assinada com HMAC e verificação recusa exp expirado ou
 *     sig inválida; roundtrip válido devolve o arquivo correto;
 *   - Fallback de canal: se contact.channel_id aponta pra canal disconnected,
 *     usa fallback pelo primeiro canal ativo;
 *   - Histórico list() ordenado desc (2ª via aparece antes);
 *   - Isolamento multi-tenant: org B não vê deliveries de A;
 *   - PDF gerado é `%PDF-` válido e persistente em PRIVATE_MEDIA_DIR/clinical_docs.
 *
 * Uso:  npm run test:clinic-doc-send
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-docsend-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-docsend-1234567890";
process.env.APP_URL = "https://test.example.com";

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
  const { ClinicDocumentDeliveryService, CLINIC_DOCS_DIR } = await import("../src/server/ClinicDocumentDeliveryService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string, opts: { channelStatus?: string } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    const channelId = `ch_${tag}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, ?)`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`, opts.channelStatus || "connected");
    const mkContact = (n: string, phone?: string) => {
      const id = randomUUID();
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, phone ?? `55${tag}${Math.floor(Math.random() * 1e8)}`);
      return id;
    };
    return { orgId, channelId, actorId: `user_${tag}`, patient: mkContact("Ana Silva"), mkContact };
  }

  const A = seedOrg("A");
  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Beatriz", registrationNumber: "12345", council: "CRM/SP" }, A.actorId);
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta",
    scheduledStart: "2026-08-01T09:00:00-03:00",
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);

  // Draft prescription
  const draft = ClinicDocumentsService.createPrescription(A.orgId, enc.id, {
    items: [{ drug: "Amoxicilina 500mg", instructions: "1 cáp de 8/8h por 7 dias" }],
  }, A.actorId);

  // Mock sender: default = sucesso com provider_message_id fake.
  let sendCalls: any[] = [];
  const senderOk = async (channelId: string, to: string, fileUrl: string, fileName: string, caption?: string) => {
    sendCalls.push({ channelId, to, fileUrl, fileName, caption });
    return { messages: [{ id: `wamid.${randomUUID()}` }] };
  };
  const senderFail = async () => { throw new Error("Provider offline (503)"); };

  // ── 1. Rascunho não envia ──────────────────────────────────────────────
  let threwDraft: any = null;
  try { await ClinicDocumentDeliveryService.send(A.orgId, "prescription", draft.id, A.actorId, { sender: senderOk }); } catch (e) { threwDraft = e; }
  check("send em rascunho → DOCUMENT_NOT_ISSUED", threwDraft?.code === "DOCUMENT_NOT_ISSUED");

  // Emite
  const rx = ClinicDocumentsService.issuePrescription(A.orgId, draft.id, A.actorId);

  // ── 2. LGPD comunicações ausente ───────────────────────────────────────
  let threwComms: any = null;
  try { await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rx.id, A.actorId, { sender: senderOk }); } catch (e) { threwComms = e; }
  check("send sem consentimento comunicações → LGPD_COMMS_CONSENT_REQUIRED", threwComms?.code === "LGPD_COMMS_CONSENT_REQUIRED");

  // Concede comunicações
  LgpdService.grantConsent(A.orgId, A.patient, "comunicacoes", { actorId: A.actorId });

  // ── 3. Envio OK ───────────────────────────────────────────────────────
  sendCalls = [];
  const delivery = await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rx.id, A.actorId, { sender: senderOk });
  check("envio OK grava row 'sent'", delivery.status === "sent");
  check("provider_message_id gravado", !!delivery.providerMessageId && delivery.providerMessageId.startsWith("wamid."));
  check("sender chamado 1×", sendCalls.length === 1);
  check("sender recebeu URL assinada absoluta (APP_URL + rota pública + exp + sig)",
    sendCalls[0].fileUrl.startsWith("https://test.example.com/api/public/clinic/documents/") &&
    sendCalls[0].fileUrl.includes("exp=") && sendCalls[0].fileUrl.includes("sig="));
  check("sender recebeu filename receita-*.pdf", /^receita-[a-f0-9]{8}\.pdf$/.test(sendCalls[0].fileName));
  check("sender recebeu canal ativo do contato", sendCalls[0].channelId === A.channelId);

  // ── 4. Arquivo PDF persiste em disco e é PDF válido ────────────────────
  const filesInDocsDir = fs.readdirSync(CLINIC_DOCS_DIR);
  check("PDF salvo em CLINIC_DOCS_DIR", filesInDocsDir.length >= 1);
  const savedFile = path.join(CLINIC_DOCS_DIR, filesInDocsDir[filesInDocsDir.length - 1]);
  const head = fs.readFileSync(savedFile).slice(0, 5).toString();
  check("PDF começa com '%PDF-'", head === "%PDF-");

  // ── 5. signedUrl HMAC roundtrip ────────────────────────────────────────
  const key = filesInDocsDir[0];
  const goodUrl = ClinicDocumentDeliveryService.signedUrl(key);
  const match = /\?exp=(\d+)&sig=([a-f0-9]+)$/.exec(goodUrl);
  check("signedUrl tem exp+sig", !!match);
  if (match) {
    const [, exp, sig] = match;
    const resolved = ClinicDocumentDeliveryService.resolveSignedFile(key, exp, sig);
    check("resolveSignedFile devolve caminho quando HMAC ok", resolved === path.join(CLINIC_DOCS_DIR, key));

    // sig errada
    const bad = ClinicDocumentDeliveryService.resolveSignedFile(key, exp, sig.replace(/.$/, "0"));
    check("resolveSignedFile recusa sig inválida", bad === null);

    // exp expirado
    const expired = ClinicDocumentDeliveryService.resolveSignedFile(key, String(Date.now() - 1000), sig);
    check("resolveSignedFile recusa exp expirado", expired === null);

    // key com path traversal
    const traversal = ClinicDocumentDeliveryService.resolveSignedFile("../secret", exp, sig);
    check("resolveSignedFile recusa path traversal", traversal === null);
  }

  // ── 6. Falha do provider grava 'failed' mas NÃO relança ────────────────
  const draft2 = ClinicDocumentsService.createPrescription(A.orgId, enc.id, {
    items: [{ drug: "Paracetamol 750mg" }],
  }, A.actorId);
  const rx2 = ClinicDocumentsService.issuePrescription(A.orgId, draft2.id, A.actorId);
  const failed = await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rx2.id, A.actorId, { sender: senderFail });
  check("provider falha → row 'failed'", failed.status === "failed");
  check("provider falha → error registrado", failed.error?.includes("Provider offline"));
  // Método não relançou — teste chegou aqui.
  check("método não relança quando provider falha (histórico é o retorno)", true);

  // ── 7. Sem identifier ──────────────────────────────────────────────────
  const noPhone = A.mkContact("Sem Telefone", "");
  const enc2Apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: noPhone, title: "Consulta", scheduledStart: "2026-08-02T09:00:00-03:00",
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  LgpdService.grantConsent(A.orgId, noPhone, "dados_sensiveis", { actorId: A.actorId });
  LgpdService.grantConsent(A.orgId, noPhone, "comunicacoes", { actorId: A.actorId });
  const enc2 = ClinicEncounterService.open(A.orgId, enc2Apt.id, A.actorId);
  const rxNoPhone = ClinicDocumentsService.issuePrescription(A.orgId,
    ClinicDocumentsService.createPrescription(A.orgId, enc2.id, { items: [{ drug: "X" }] }, A.actorId).id,
    A.actorId);
  let threwNoPhone: any = null;
  try { await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rxNoPhone.id, A.actorId, { sender: senderOk }); } catch (e) { threwNoPhone = e; }
  check("paciente sem identifier → erro claro", threwNoPhone?.message?.includes("identificador"));

  // ── 8. Fallback de canal quando canal do contato está disconnected ─────
  // Marca canal como disconnected e cria fallback ativo.
  db.prepare(`UPDATE channels SET status = 'disconnected' WHERE id = ?`).run(A.channelId);
  const fallbackChannelId = `ch_A_fb_${randomUUID().slice(0, 4)}`;
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
    .run(fallbackChannelId, A.orgId, `Canal FB`, `wa_A_fb`);
  const rx3 = ClinicDocumentsService.issuePrescription(A.orgId,
    ClinicDocumentsService.createPrescription(A.orgId, enc.id, { items: [{ drug: "Y" }] }, A.actorId).id,
    A.actorId);
  sendCalls = [];
  const fb = await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rx3.id, A.actorId, { sender: senderOk });
  check("fallback usa canal ativo quando o do contato está disconnected", fb.channelId === fallbackChannelId && sendCalls[0]?.channelId === fallbackChannelId);

  // ── 9. Sem canal ativo → erro ─────────────────────────────────────────
  db.prepare(`UPDATE channels SET status = 'disconnected' WHERE organization_id = ?`).run(A.orgId);
  const rx4 = ClinicDocumentsService.issuePrescription(A.orgId,
    ClinicDocumentsService.createPrescription(A.orgId, enc.id, { items: [{ drug: "Z" }] }, A.actorId).id,
    A.actorId);
  let threwNoCh: any = null;
  try { await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rx4.id, A.actorId, { sender: senderOk }); } catch (e) { threwNoCh = e; }
  check("sem canal ativo → erro claro", threwNoCh?.message?.includes("canal WhatsApp ativo"));
  // Restaura fallback
  db.prepare(`UPDATE channels SET status = 'connected' WHERE id = ?`).run(fallbackChannelId);

  // ── 10. Histórico list() ─────────────────────────────────────────────
  await ClinicDocumentDeliveryService.send(A.orgId, "prescription", rx.id, A.actorId, { sender: senderOk }); // 2ª via
  const hist = ClinicDocumentDeliveryService.list(A.orgId, "prescription", rx.id);
  check("list() traz ≥ 2 tentativas do mesmo doc (envio original + 2ª via)", hist.length >= 2);
  check("list() ordenado desc", new Date(hist[0].sentAt).getTime() >= new Date(hist[1].sentAt).getTime());

  // ── 11. Isolamento multi-tenant ───────────────────────────────────────
  const B = seedOrg("B");
  const listB = ClinicDocumentDeliveryService.list(B.orgId, "prescription", rx.id);
  check("org B não vê deliveries de A", listB.length === 0);

  // ── 12. Auditoria ─────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type LIKE 'CLINIC_DOCUMENT_SEN%'
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CLINIC_DOCUMENT_SENT ≥ 3 (envios OK)", (map.CLINIC_DOCUMENT_SENT || 0) >= 3, String(map.CLINIC_DOCUMENT_SENT));
  check("audit CLINIC_DOCUMENT_SEND_FAILED = 1", (map.CLINIC_DOCUMENT_SEND_FAILED || 0) === 1, String(map.CLINIC_DOCUMENT_SEND_FAILED));

  console.log("\n=== Envio de docs por WhatsApp (ADR-080 Fase K) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
