/**
 * TESTE — Módulo Clínica Fase J: Anexos ao prontuário (ADR-080 extensão).
 * ---------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - LGPD Art.11: sem consentimento 'dados_sensiveis', add()/remove() falham
 *     com LGPD_CONSENT_REQUIRED (mesmo guardrail do encounter/docs);
 *   - Whitelist de mime: PNG/JPG/WEBP/PDF passam; text/plain e outros rejeitam;
 *   - Tamanho: rejeita >15 MB e arquivo vazio;
 *   - add() grava row no DB + arquivo em PRIVATE_MEDIA_DIR/clinical/{org}/{enc}/;
 *   - Arquivo tem nome uuid+ext (não usa originalname — evita colisão/traversal);
 *   - read() devolve buffer+mime+filename corretos;
 *   - list() lista os anexos ordenados desc;
 *   - remove() apaga row + arquivo físico;
 *   - remove() BLOQUEADO após encounter signed (ATTACHMENT_FROZEN) — mesma
 *     lógica de integridade dos docs emitidos;
 *   - add() FUNCIONA após signed (paciente pode entregar exame de volta
 *     depois da consulta — o encounter fica assinado, mas anexo permanece
 *     adicionável); NÃO é regra hard aqui — apenas confirma que não bloqueia;
 *   - Isolamento multi-tenant: org B não vê/lê/deleta anexo de A;
 *   - Auditoria em auth_audit_logs (ADDED/REMOVED).
 *
 * Uso:  npm run test:clinic-attachments
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-attach-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-clinic-attachments-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// PNG mínimo válido (1×1) — o service não faz decode, só valida mime + tamanho.
const PNG_1x1 = Buffer.from(
  "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c62000100000005000101" +
  "0d0a2db40000000049454e44ae426082",
  "hex"
);
const PDF_MIN = Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n1 0 obj\n<< >>\nendobj\ntrailer\n<< >>\n%%EOF\n", "binary");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicAttachmentService, PRIVATE_CLINICAL_DIR, MAX_BYTES } = await import("../src/server/ClinicAttachmentService.js");
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

  const dra = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. Ana" }, A.actorId);
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.patient, title: "Consulta",
    scheduledStart: "2026-08-01T09:00:00-03:00",
    professionalId: dra.id, durationMinutes: 30,
  }, A.actorId);
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);

  // ── 1. LGPD block ──────────────────────────────────────────────────────
  LgpdService.revokeConsent(A.orgId, A.patient, "dados_sensiveis", A.actorId);
  let threwLgpd: any = null;
  try { ClinicAttachmentService.add(A.orgId, enc.id, { buffer: PNG_1x1, mime: "image/png" }, A.actorId); } catch (e) { threwLgpd = e; }
  check("add sem consentimento → LGPD_CONSENT_REQUIRED", threwLgpd?.code === "LGPD_CONSENT_REQUIRED");
  LgpdService.grantConsent(A.orgId, A.patient, "dados_sensiveis", { actorId: A.actorId });

  // ── 2. Whitelist de mime ───────────────────────────────────────────────
  let threwMime: any = null;
  try { ClinicAttachmentService.add(A.orgId, enc.id, { buffer: Buffer.from("hello"), mime: "text/plain" }, A.actorId); } catch (e) { threwMime = e; }
  check("mime não whitelistado (text/plain) rejeita", !!threwMime && threwMime.message.includes("não suportado"));

  // ── 3. Vazio e >15 MB ──────────────────────────────────────────────────
  let threwEmpty: any = null;
  try { ClinicAttachmentService.add(A.orgId, enc.id, { buffer: Buffer.alloc(0), mime: "image/png" }, A.actorId); } catch (e) { threwEmpty = e; }
  check("buffer vazio rejeita", !!threwEmpty);

  let threwBig: any = null;
  try {
    const huge = Buffer.alloc(MAX_BYTES + 1, 0x89); // > 15 MB
    ClinicAttachmentService.add(A.orgId, enc.id, { buffer: huge, mime: "image/png" }, A.actorId);
  } catch (e) { threwBig = e; }
  check("arquivo > 15 MB rejeita", !!threwBig);

  // ── 4. Add válido: PNG + PDF ───────────────────────────────────────────
  const attPng = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PNG_1x1, mime: "image/png",
    originalFilename: "raio-x-esquerdo.png", label: "Raio-X pré",
  }, A.actorId);
  check("add PNG cria row", !!attPng.id && attPng.kind === "image" && attPng.mimeType === "image/png");
  check("add PNG storageKey é uuid+ext (não usa originalname)", /^[a-f0-9-]{36}\.png$/.test(attPng.storageKey));
  check("add PNG grava contact_id do encounter", attPng.contactId === A.patient);

  const filePath = path.join(PRIVATE_CLINICAL_DIR, A.orgId, enc.id, attPng.storageKey);
  check("arquivo físico existe em PRIVATE_MEDIA_DIR/clinical/{org}/{enc}/", fs.existsSync(filePath));
  check("arquivo físico tem o tamanho certo", fs.statSync(filePath).size === PNG_1x1.length);

  const attPdf = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PDF_MIN, mime: "application/pdf", originalFilename: "laudo.pdf",
  }, A.actorId);
  check("add PDF cria row com kind='pdf'", attPdf.kind === "pdf");

  // ── 5. read() ──────────────────────────────────────────────────────────
  const readBack = ClinicAttachmentService.read(A.orgId, attPng.id);
  check("read() devolve buffer com mesmo conteúdo", Buffer.compare(readBack.buffer, PNG_1x1) === 0);
  check("read() devolve mime + filename", readBack.mime === "image/png" && readBack.filename === "raio-x-esquerdo.png");

  // ── 6. list() ──────────────────────────────────────────────────────────
  const list = ClinicAttachmentService.list(A.orgId, enc.id);
  check("list() devolve 2 anexos", list.length === 2);
  check("list() ordena desc (PDF adicionado depois vem primeiro)",
    list[0].id === attPdf.id && list[1].id === attPng.id);

  // ── 7. remove() em draft ───────────────────────────────────────────────
  ClinicAttachmentService.remove(A.orgId, attPdf.id, A.actorId);
  check("remove() apaga row", ClinicAttachmentService.get(A.orgId, attPdf.id) === null);
  const pdfPath = path.join(PRIVATE_CLINICAL_DIR, A.orgId, enc.id, attPdf.storageKey);
  check("remove() apaga arquivo físico (best-effort)", !fs.existsSync(pdfPath));

  // ── 8. Finalize → remove bloqueado, add permitido ─────────────────────
  ClinicEncounterService.finalize(A.orgId, enc.id, A.actorId);

  let threwFrozen: any = null;
  try { ClinicAttachmentService.remove(A.orgId, attPng.id, A.actorId); } catch (e) { threwFrozen = e; }
  check("remove após signed → ATTACHMENT_FROZEN", threwFrozen?.code === "ATTACHMENT_FROZEN");

  // add pós-signed: permite (paciente pode trazer exame depois da consulta)
  const attPost = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: PDF_MIN, mime: "application/pdf", originalFilename: "exame-posterior.pdf",
  }, A.actorId);
  check("add funciona pós-signed (anexo pode ser adicionado depois)", !!attPost.id);

  // ── 9. Isolamento multi-tenant ─────────────────────────────────────────
  const B = seedOrg("B");
  check("org B não vê anexo de A", ClinicAttachmentService.get(B.orgId, attPng.id) === null);
  let threwCross: any = null;
  try { ClinicAttachmentService.read(B.orgId, attPng.id); } catch (e) { threwCross = e; }
  check("org B read anexo de A → 404", threwCross?.message?.includes("não encontrado"));
  let threwCrossDel: any = null;
  try { ClinicAttachmentService.remove(B.orgId, attPng.id, B.actorId); } catch (e) { threwCrossDel = e; }
  check("org B delete anexo de A → 404", threwCrossDel?.message?.includes("não encontrado"));
  // Arquivo permanece
  check("arquivo de A permanece intocado", fs.existsSync(filePath));

  // ── 10. Auditoria ──────────────────────────────────────────────────────
  const audits = db.prepare(
    `SELECT event_type, COUNT(*) AS c FROM auth_audit_logs
      WHERE organization_id = ? AND event_type LIKE 'CLINIC_ATTACHMENT_%'
      GROUP BY event_type`
  ).all(A.orgId) as any[];
  const map = Object.fromEntries(audits.map((a) => [a.event_type, Number(a.c)]));
  check("audit CLINIC_ATTACHMENT_ADDED ≥ 3 (png + pdf + post-signed)", (map.CLINIC_ATTACHMENT_ADDED || 0) >= 3, String(map.CLINIC_ATTACHMENT_ADDED));
  check("audit CLINIC_ATTACHMENT_REMOVED = 1", (map.CLINIC_ATTACHMENT_REMOVED || 0) === 1, String(map.CLINIC_ATTACHMENT_REMOVED));

  console.log("\n=== Anexos ao prontuário (ADR-080 Fase J) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
