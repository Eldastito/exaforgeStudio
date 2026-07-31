/**
 * TESTE — Módulo Clínica Fatia 30: Hardening
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *
 * ── Upload magic-byte + filename sanitize ──────────────────────────────
 *   - detectMime: reconhece PNG, JPEG, WEBP, PDF pelos bytes iniciais
 *   - detectMime: null pra buffer HTML, script, texto puro, buffer curto
 *   - add() rejeita buffer HTML com Content-Type: image/png declarado
 *     (INVALID_FILE_CONTENT), mesmo com o mime "válido" do multer
 *   - add() aceita PNG real (magic bate) + sobrescreve mime_type gravado
 *     pelo REAL (não usa o declarado do multer)
 *   - safeFilename: CRLF, aspas, ; , /, \, .. viram _; espaços preservados;
 *     nome vazio → "anexo"; dot-file → sem dot inicial
 *   - filename gravado no row já vem sanitizado (rota não precisa refazer)
 *
 * ── Race unique index parcial ──────────────────────────────────────────
 *   - CREATE UNIQUE INDEX idx_appointments_parent_unique existe no schema
 *   - scheduleFollowUp normal: cria retorno OK
 *   - Manipulação direta: INSERT + UPDATE parent = 2 vezes → 2ª falha por
 *     UNIQUE constraint (defesa em profundidade contra race real)
 *   - scheduleFollowUp já idempotente por SELECT prévio: 2ª chamada
 *     devolve existente
 *   - Cancel do retorno LIBERA re-agendamento (unique parcial: cancelled
 *     não conta)
 *
 * ── startCare async com dynamic import ──────────────────────────────────
 *   - startCare devolve Promise (async)
 *   - await startCare(...) funciona sem crash
 *   - Encounter é aberto best-effort (silencioso em falha)
 *
 * ── Webhook enforcement ────────────────────────────────────────────────
 *   - isWebhookEnforced() default false quando nenhuma org tem clínica
 *   - isWebhookEnforced() true quando alguma org tem 'clinica' em
 *     enabled_modules (default-ON pra fluxos SIM/NÃO/vaga)
 *
 * Uso:  npm run test:clinic-hardening
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-hardening-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-hardening-1234567890";
// Garantir que a env não força enforcement pra testar a lógica default-on
delete process.env.WEBHOOK_SECRET;

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicAttachmentService, detectMime, safeFilename } = await import("../src/server/ClinicAttachmentService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");
  const { isWebhookEnforced } = await import("../src/server/webhookSecurity.js");

  function seedOrg(tag: string, opts: { enableClinic?: boolean } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, enabled_modules) VALUES (?, ?, ?, 'active', ?)`)
      .run(randomUUID(), orgId, `Clínica ${tag}`, opts.enableClinic ? "clinica,agenda" : null);
    const channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
    db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
      .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    const contactId = randomUUID();
    db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
      .run(contactId, orgId, channelId, `Paciente ${tag}`, `55${tag}${Math.floor(Math.random() * 1e8)}`);
    LgpdService.grantConsent(orgId, contactId, "dados_sensiveis", { actorId: `user_${tag}` });
    return { orgId, actorId: `user_${tag}`, contactId };
  }

  // ── 1. detectMime ──────────────────────────────────────────────────────
  const pngBuf = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00]);
  check("detectMime PNG magic", detectMime(pngBuf) === "image/png");

  const jpegBuf = Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]);
  check("detectMime JPEG magic", detectMime(jpegBuf) === "image/jpeg");

  const webpBuf = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from("WEBP"), Buffer.from([0x00, 0x00, 0x00, 0x00])]);
  check("detectMime WEBP magic", detectMime(webpBuf) === "image/webp");

  const pdfBuf = Buffer.from("%PDF-1.4\nrest");
  check("detectMime PDF magic", detectMime(pdfBuf) === "application/pdf");

  const htmlBuf = Buffer.from("<html><script>alert(1)</script></html>");
  check("detectMime HTML → null (rejeita)", detectMime(htmlBuf) === null);

  const textBuf = Buffer.from("hello world");
  check("detectMime texto puro → null", detectMime(textBuf) === null);

  const emptyBuf = Buffer.alloc(0);
  check("detectMime buffer vazio → null", detectMime(emptyBuf) === null);

  const shortBuf = Buffer.from([0xFF, 0xD8]);
  check("detectMime buffer curto (2 bytes) → null", detectMime(shortBuf) === null);

  // ── 2. safeFilename ────────────────────────────────────────────────────
  check("safeFilename normal preserva letras/dígitos/espaço/hífen/ponto",
    safeFilename("Exame Sangue - 2026.pdf") === "Exame Sangue - 2026.pdf");
  check("safeFilename remove CRLF (viram espaço)",
    !safeFilename("evil\r\nX-Injected: yes\n.png").match(/[\r\n]/));
  check("safeFilename remove aspas e ;",
    !safeFilename('"; rm -rf /;.png').match(/[";]/));
  check("safeFilename remove path traversal (sem ../ literal)",
    !safeFilename("../../etc/passwd").includes("../"));
  check("safeFilename vazio → 'anexo'", safeFilename("") === "anexo");
  check("safeFilename só símbolos → underscores ou fallback", safeFilename("!!!") !== "!!!");
  check("safeFilename dot-file → sem dot inicial", safeFilename(".htaccess") === "htaccess");
  check("safeFilename trunca em 120 chars", safeFilename("a".repeat(200)).length === 120);

  // ── 3. Upload magic-byte no add() ──────────────────────────────────────
  const A = seedOrg("A", { enableClinic: true });
  const prof = ClinicAgendaService.createProfessional(A.orgId, { name: "Dra. A" }, A.actorId);
  const apt = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "T", scheduledStart: "2026-12-01T09:00:00-03:00",
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const enc = ClinicEncounterService.open(A.orgId, apt.id, A.actorId);

  // Atacante manda HTML mas declara image/png
  let threwFake: any = null;
  try {
    ClinicAttachmentService.add(A.orgId, enc.id, {
      buffer: htmlBuf, mime: "image/png", originalFilename: "innocent.png",
    }, A.actorId);
  } catch (e) { threwFake = e; }
  check("add() rejeita HTML declarado como image/png → INVALID_FILE_CONTENT",
    threwFake?.code === "INVALID_FILE_CONTENT");

  // PNG real com mime declarado errado (ex.: multer detectou "application/octet-stream")
  const realPngWithBadMime = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: pngBuf, mime: "application/octet-stream", originalFilename: "raio-x.png",
  }, A.actorId);
  check("add() aceita PNG real mesmo com mime declarado errado", !!realPngWithBadMime.id);
  check("add() sobrescreve mime_type gravado pelo REAL detectado",
    realPngWithBadMime.mimeType === "image/png");

  // Filename com CRLF → sanitizado no row
  const withCrlf = ClinicAttachmentService.add(A.orgId, enc.id, {
    buffer: pdfBuf, mime: "application/pdf", originalFilename: "laudo\r\nX-Injected: header\n.pdf",
  }, A.actorId);
  check("add() sanitiza CRLF no original_filename",
    !!withCrlf.originalFilename && !withCrlf.originalFilename.match(/[\r\n]/));

  // ── 4. Race unique index parcial ──────────────────────────────────────
  // scheduleFollowUp normal
  const ret1 = ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { inDays: 30 }, A.actorId);
  check("scheduleFollowUp cria retorno OK", !!ret1?.id && ret1.parent_appointment_id === apt.id);

  // 2ª chamada devolve existente (idempotente por SELECT)
  const ret1b = ClinicAgendaService.scheduleFollowUp(A.orgId, apt.id, { inDays: 30 }, A.actorId);
  check("scheduleFollowUp idempotente (2ª chamada devolve o mesmo)", ret1b?.id === ret1.id);

  // Simular race REAL: force INSERT direto + UPDATE parent → 2º UPDATE deve falhar
  const raceApptId = randomUUID();
  db.prepare(
    `INSERT INTO appointments (id, organization_id, contact_id, title, scheduled_start, scheduled_end, status, professional_id)
     VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?)`
  ).run(raceApptId, A.orgId, A.contactId, "Race Retorno", "2027-01-15T10:00:00Z", "2027-01-15T10:30:00Z", prof.id);
  let threwRace: any = null;
  try {
    db.prepare(`UPDATE appointments SET parent_appointment_id = ? WHERE id = ? AND organization_id = ?`)
      .run(apt.id, raceApptId, A.orgId);
  } catch (e) { threwRace = e; }
  check("UPDATE parent duplicado → SQLITE_CONSTRAINT_UNIQUE",
    String(threwRace?.code || threwRace?.message || "").toLowerCase().includes("unique") ||
    String(threwRace?.code || "").includes("CONSTRAINT"));

  // Cancel do retorno original LIBERA re-agendamento (índice é parcial)
  db.prepare(`UPDATE appointments SET status = 'cancelled' WHERE id = ? AND organization_id = ?`).run(ret1.id, A.orgId);
  // Agora consegue setar parent no raceApptId (retorno original está cancelled)
  let threwAfterCancel: any = null;
  try {
    db.prepare(`UPDATE appointments SET parent_appointment_id = ? WHERE id = ? AND organization_id = ?`)
      .run(apt.id, raceApptId, A.orgId);
  } catch (e) { threwAfterCancel = e; }
  check("cancel do retorno LIBERA parent (unique parcial)", !threwAfterCancel);

  // Limpa row de race pra não interferir nos próximos
  db.prepare(`DELETE FROM appointments WHERE id = ?`).run(raceApptId);

  // ── 5. startCare async ────────────────────────────────────────────────
  const apt2 = ClinicAgendaService.createAppointment(A.orgId, {
    contactId: A.contactId, title: "T2", scheduledStart: "2026-12-02T09:00:00-03:00",
    professionalId: prof.id, durationMinutes: 30, force: true,
  }, A.actorId);
  const startResult = ClinicAgendaService.startCare(A.orgId, apt2.id, A.actorId);
  check("startCare devolve Promise (é async)", startResult instanceof Promise);
  const started = await startResult;
  check("await startCare resolve sem crash", started?.status === "in_care");

  // ── 6. isWebhookEnforced ───────────────────────────────────────────────
  // Guarda config atual pra restaurar depois
  const originalConfig = db.prepare(`SELECT value FROM app_config WHERE key = 'webhook_enforce'`).get() as any;

  // Zera enforce manual pra testar a lógica default-on
  db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('webhook_enforce', '0')`).run();

  // A org A tem clinica ativa → enforced
  check("isWebhookEnforced true quando alguma org tem 'clinica' em enabled_modules",
    isWebhookEnforced() === true);

  // Desabilita clínica de A (fica sem nenhuma org clínica no banco)
  db.prepare(`UPDATE organization_settings SET enabled_modules = 'agenda' WHERE organization_id = ?`).run(A.orgId);
  check("isWebhookEnforced false quando NENHUMA org tem clinica ativa",
    isWebhookEnforced() === false);

  // Restaura clínica pra próxima
  db.prepare(`UPDATE organization_settings SET enabled_modules = 'clinica,agenda' WHERE organization_id = ?`).run(A.orgId);
  check("isWebhookEnforced volta a true após habilitar clínica de novo",
    isWebhookEnforced() === true);

  // Restaura config original
  if (originalConfig?.value) {
    db.prepare(`INSERT OR REPLACE INTO app_config (key, value) VALUES ('webhook_enforce', ?)`).run(originalConfig.value);
  } else {
    db.prepare(`DELETE FROM app_config WHERE key = 'webhook_enforce'`).run();
  }

  console.log("\n=== Hardening (ADR-080 Fase 30) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
