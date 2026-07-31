/**
 * TESTE — Módulo Clínica Fatia 33: Envio automático do relatório mensal
 * (ADR-080 extensão 2026-07).
 * -------------------------------------------------------------------
 * Prova, offline e em banco temporário:
 *   - sendForMonth com opt-in desativado (default) → skipped disabled,
 *     sender NÃO chamado.
 *   - Opt-in ativado sem recipient → skipped no_recipient.
 *   - Feliz: opt-in + recipient + consent → row 'sent' com
 *     provider_message_id; sender chamado com URL assinada
 *     `/api/public/clinic/monthly-reports/{orgId}/{uuid}.pdf?exp=&sig=`;
 *     PDF gravado em disco privado.
 *   - Dedup por (org, month): 2ª chamada sem force devolve existente,
 *     sender NÃO chamado 2×.
 *   - force:true bypassa dedup — nova row.
 *   - LGPD comms do destinatário revogado → skipped
 *     LGPD_COMMS_CONSENT_REQUIRED, sender NÃO chamado.
 *   - Recipient sem identifier → failed, sender NÃO chamado.
 *   - Sem canal ativo → failed, sender NÃO chamado.
 *   - Provider throw → failed com error preservado; PDF já salvo continua
 *     no disco (dá pra o operador reenviar via force).
 *   - dispatchForOrg com today < day → noop (dia ainda não chegou).
 *   - dispatchForOrg com today >= day → envia o mês anterior 1×.
 *   - dispatchForOrg 2× no mesmo mês → dedup, envio único.
 *   - dispatchForOrg com toggle off → noop.
 *   - resolveSignedFile: HMAC válido devolve caminho; sig errado → null;
 *     exp no passado → null; storageKey inválido (../..) → null.
 *   - Isolamento multi-tenant: dispatchAll só pega orgs opt-in.
 *   - Auditoria: SENT / SKIPPED / FAILED gravados com metadata; identifier
 *     mascarado no metadata do SENT (LGPD/Fase 32 padrão).
 *   - normalizeMonth default cai no mês ANTERIOR ao nowMs.
 *
 * Uso:  npm run test:clinic-monthly-report-delivery
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-clinic-monthly-report-delivery-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-monthly-report-delivery-1234567890";
process.env.APP_URL = "https://zappflow.test";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ClinicMonthlyReportDeliveryService, MONTHLY_REPORT_DIR } = await import(
    "../src/server/ClinicMonthlyReportDeliveryService.js"
  );
  const { normalizeMonth } = await import("../src/server/ClinicMonthlyReportService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  function seedOrg(tag: string, opts: { withChannel?: boolean } = {}) {
    const orgId = `org_${tag}_${randomUUID().slice(0, 6)}`;
    db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`)
      .run(randomUUID(), orgId, `Clínica ${tag}`);
    let channelId: string | null = null;
    if (opts.withChannel !== false) {
      channelId = `ch_${tag}_${randomUUID().slice(0, 4)}`;
      db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', ?, ?, 'connected')`)
        .run(channelId, orgId, `Canal ${tag}`, `wa_${tag}`);
    }
    const mkContact = (n: string, phone?: string) => {
      const id = randomUUID();
      const ident = phone !== undefined ? phone : `55${tag.replace(/\W/g, "")}${Math.floor(Math.random() * 1e8)}`;
      db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, ?, ?)`)
        .run(id, orgId, channelId, n, ident);
      return id;
    };
    return { orgId, actorId: `user_${tag}`, channelId, mkContact };
  }

  function enableAutomatic(orgId: string, recipientContactId: string, day = 5) {
    db.prepare(
      `UPDATE organization_settings
          SET clinic_monthly_report_enabled = 1,
              clinic_monthly_report_day = ?,
              clinic_monthly_report_recipient_contact_id = ?
        WHERE organization_id = ?`
    ).run(day, recipientContactId, orgId);
  }

  const sends: Array<{ channelId: string; to: string; url: string; fileName: string; caption?: string }> = [];
  const sender = async (channelId: string, to: string, fileUrl: string, fileName: string, caption?: string) => {
    sends.push({ channelId, to, url: fileUrl, fileName, caption });
    return { messages: [{ id: `wamid_${randomUUID().slice(0, 6)}` }] };
  };
  const failingSender = async () => { throw new Error("provider off"); };

  // ── 1. Opt-in default off → skipped disabled ─────────────────────────────
  const OFF = seedOrg("OFF");
  const recipOff = OFF.mkContact("Owner Off");
  LgpdService.grantConsent(OFF.orgId, recipOff, "comunicacoes", { actorId: OFF.actorId });
  // NÃO habilita — apenas seta recipient pra provar que enabled=0 blinda
  db.prepare(`UPDATE organization_settings SET clinic_monthly_report_recipient_contact_id = ? WHERE organization_id = ?`)
    .run(recipOff, OFF.orgId);
  const before1 = sends.length;
  const d1 = await ClinicMonthlyReportDeliveryService.sendForMonth(OFF.orgId, "2026-06", { sender });
  check("opt-in off: status=skipped", d1?.status === "skipped");
  check("opt-in off: error 'opt-in'", d1?.error?.includes("opt-in") === true, String(d1?.error));
  check("opt-in off: sender NÃO chamado", sends.length === before1);

  // ── 2. Enabled sem recipient → skipped no_recipient ──────────────────────
  const NOR = seedOrg("NOR");
  db.prepare(`UPDATE organization_settings SET clinic_monthly_report_enabled = 1 WHERE organization_id = ?`).run(NOR.orgId);
  const before2 = sends.length;
  const d2 = await ClinicMonthlyReportDeliveryService.sendForMonth(NOR.orgId, "2026-06", { sender });
  check("sem recipient: status=skipped", d2?.status === "skipped");
  check("sem recipient: error 'destinatário'", d2?.error?.includes("destinat") === true, String(d2?.error));
  check("sem recipient: sender NÃO chamado", sends.length === before2);

  // ── 3. Happy path ────────────────────────────────────────────────────────
  const A = seedOrg("A");
  const ownerA = A.mkContact("Dr. Owner A", "5511987654321");
  LgpdService.grantConsent(A.orgId, ownerA, "comunicacoes", { actorId: A.actorId });
  enableAutomatic(A.orgId, ownerA);

  const before3 = sends.length;
  const d3 = await ClinicMonthlyReportDeliveryService.sendForMonth(A.orgId, "2026-06", { actorId: A.actorId, sender });
  check("feliz: retornou row", !!d3);
  check("feliz: status=sent", d3?.status === "sent");
  check("feliz: provider_message_id gravado", !!d3?.providerMessageId);
  check("feliz: month gravado", d3?.month === "2026-06");
  check("feliz: contactId gravado", d3?.contactId === ownerA);
  check("feliz: channelId gravado", d3?.channelId === A.channelId);
  check("feliz: toIdentifier gravado", d3?.toIdentifier === "5511987654321");
  check("feliz: sender chamado 1×", sends.length === before3 + 1);

  const send3 = sends[sends.length - 1];
  check("feliz: fileName inclui mês", send3.fileName === "relatorio-2026-06.pdf");
  check("feliz: URL absoluta com APP_URL", send3.url.startsWith("https://zappflow.test/api/public/clinic/monthly-reports/"),
    send3.url);
  check("feliz: URL tem exp e sig", /[?&]exp=\d+/.test(send3.url) && /[?&]sig=[a-f0-9]+/.test(send3.url));
  check("feliz: caption menciona negócio", send3.caption?.includes("Clínica A") === true, send3.caption);
  check("feliz: caption menciona mês em pt-BR", send3.caption?.includes("junho de 2026") === true, send3.caption);

  // PDF gravado em disco privado
  const orgDir = path.join(MONTHLY_REPORT_DIR, A.orgId);
  const files = fs.existsSync(orgDir) ? fs.readdirSync(orgDir).filter((f) => f.endsWith(".pdf")) : [];
  check("feliz: PDF salvo em MONTHLY_REPORT_DIR/{orgId}/", files.length === 1, String(files));
  if (files.length === 1) {
    const pdfBytes = fs.readFileSync(path.join(orgDir, files[0]));
    check("feliz: PDF começa com %PDF", pdfBytes.slice(0, 4).toString() === "%PDF");
    check("feliz: PDF > 500 bytes", pdfBytes.length > 500, String(pdfBytes.length));
  }

  // ── 4. Dedup ─────────────────────────────────────────────────────────────
  const before4 = sends.length;
  const d4 = await ClinicMonthlyReportDeliveryService.sendForMonth(A.orgId, "2026-06", { actorId: A.actorId, sender });
  check("dedup: 2ª chamada devolve row existente", d4?.id === d3?.id);
  check("dedup: sender NÃO chamado 2×", sends.length === before4);

  const d4b = await ClinicMonthlyReportDeliveryService.sendForMonth(A.orgId, "2026-06", {
    actorId: A.actorId, sender, force: true,
  });
  check("force:true: cria row nova", d4b?.id !== d3?.id);
  check("force:true: sender chamado de novo", sends.length === before4 + 1);

  // ── 5. LGPD comms revogado ───────────────────────────────────────────────
  const NoComms = seedOrg("NoComms");
  const recipNoComms = NoComms.mkContact("Owner NoComms");
  LgpdService.grantConsent(NoComms.orgId, recipNoComms, "comunicacoes", { actorId: NoComms.actorId });
  enableAutomatic(NoComms.orgId, recipNoComms);
  LgpdService.revokeConsent(NoComms.orgId, recipNoComms, "comunicacoes", NoComms.actorId);
  const before5 = sends.length;
  const d5 = await ClinicMonthlyReportDeliveryService.sendForMonth(NoComms.orgId, "2026-06", { actorId: NoComms.actorId, sender });
  check("LGPD comms revogado: status=skipped", d5?.status === "skipped");
  check("LGPD comms revogado: error correto", d5?.error === "LGPD_COMMS_CONSENT_REQUIRED");
  check("LGPD comms revogado: sender NÃO chamado", sends.length === before5);

  // ── 6. Recipient sem identifier ──────────────────────────────────────────
  const NoId = seedOrg("NoId");
  const recipNoId = NoId.mkContact("Sem numero", "");
  LgpdService.grantConsent(NoId.orgId, recipNoId, "comunicacoes", { actorId: NoId.actorId });
  enableAutomatic(NoId.orgId, recipNoId);
  const before6 = sends.length;
  const d6 = await ClinicMonthlyReportDeliveryService.sendForMonth(NoId.orgId, "2026-06", { actorId: NoId.actorId, sender });
  check("sem identifier: status=failed", d6?.status === "failed");
  check("sem identifier: sender NÃO chamado", sends.length === before6);

  // ── 7. Sem canal ativo ───────────────────────────────────────────────────
  const NoCh = seedOrg("NoCh");
  db.prepare(`UPDATE channels SET status = 'disconnected' WHERE organization_id = ?`).run(NoCh.orgId);
  const recipNoCh = NoCh.mkContact("Owner NoCh", "5511111111111");
  LgpdService.grantConsent(NoCh.orgId, recipNoCh, "comunicacoes", { actorId: NoCh.actorId });
  enableAutomatic(NoCh.orgId, recipNoCh);
  const before7 = sends.length;
  const d7 = await ClinicMonthlyReportDeliveryService.sendForMonth(NoCh.orgId, "2026-06", { actorId: NoCh.actorId, sender });
  check("sem canal: status=failed", d7?.status === "failed");
  check("sem canal: sender NÃO chamado", sends.length === before7);

  // ── 8. Provider falha ────────────────────────────────────────────────────
  const F = seedOrg("F");
  const recipF = F.mkContact("Owner F", "5511222222222");
  LgpdService.grantConsent(F.orgId, recipF, "comunicacoes", { actorId: F.actorId });
  enableAutomatic(F.orgId, recipF);
  const dF = await ClinicMonthlyReportDeliveryService.sendForMonth(F.orgId, "2026-06", {
    actorId: F.actorId, sender: failingSender,
  });
  check("provider throw: status=failed", dF?.status === "failed");
  check("provider throw: error preservado", dF?.error?.includes("provider off") === true, String(dF?.error));

  // ── 9. dispatchForOrg com today < day → noop ────────────────────────────
  const T = seedOrg("T");
  const recipT = T.mkContact("Owner T", "5511333333333");
  LgpdService.grantConsent(T.orgId, recipT, "comunicacoes", { actorId: T.actorId });
  enableAutomatic(T.orgId, recipT, 10);
  const earlyNow = Date.parse("2026-07-03T09:00:00Z"); // today=3 < day=10
  const beforeE = sends.length;
  const sumE = await ClinicMonthlyReportDeliveryService.dispatchForOrg(T.orgId, { nowMs: earlyNow, sender });
  check("dispatch cedo: noop=1", sumE.noop === 1 && sumE.sent === 0, JSON.stringify(sumE));
  check("dispatch cedo: sender NÃO chamado", sends.length === beforeE);

  // ── 10. dispatchForOrg today >= day → envia mês anterior ────────────────
  const lateNow = Date.parse("2026-07-10T09:00:00Z"); // today=10 >= day=10
  const beforeL = sends.length;
  const sumL = await ClinicMonthlyReportDeliveryService.dispatchForOrg(T.orgId, { nowMs: lateNow, sender });
  check("dispatch no dia: sent=1", sumL.sent === 1, JSON.stringify(sumL));
  check("dispatch no dia: sender chamado 1×", sends.length === beforeL + 1);
  const sendL = sends[sends.length - 1];
  check("dispatch no dia: mês anterior (2026-06)", sendL.fileName === "relatorio-2026-06.pdf");

  // Dedup no dispatch
  const beforeD2 = sends.length;
  const sumL2 = await ClinicMonthlyReportDeliveryService.dispatchForOrg(T.orgId, { nowMs: lateNow, sender });
  check("dispatch 2×: dedup — noop=1, sent=0", sumL2.noop === 1 && sumL2.sent === 0, JSON.stringify(sumL2));
  check("dispatch 2×: sender NÃO chamado", sends.length === beforeD2);

  // ── 11. dispatchForOrg com toggle off → noop ────────────────────────────
  db.prepare(`UPDATE organization_settings SET clinic_monthly_report_enabled = 0 WHERE organization_id = ?`).run(T.orgId);
  const sumOff = await ClinicMonthlyReportDeliveryService.dispatchForOrg(T.orgId, { nowMs: lateNow, sender });
  check("dispatch toggle off: noop=1, sent=0", sumOff.noop === 1 && sumOff.sent === 0);

  // ── 12. resolveSignedFile — HMAC + traversal ─────────────────────────────
  // Reusar PDF gravado da org A no #3
  const keyA = files.length === 1 ? `${A.orgId}/${files[0]}` : "";
  const url = ClinicMonthlyReportDeliveryService.signedUrl(keyA);
  const expMatch = url.match(/[?&]exp=(\d+)/);
  const sigMatch = url.match(/[?&]sig=([a-f0-9]+)/);
  const exp = expMatch?.[1] || "";
  const sig = sigMatch?.[1] || "";
  const fp = ClinicMonthlyReportDeliveryService.resolveSignedFile(keyA, exp, sig);
  check("resolveSignedFile: HMAC válido devolve caminho", typeof fp === "string" && fs.existsSync(fp!));
  const bad = ClinicMonthlyReportDeliveryService.resolveSignedFile(keyA, exp, "0".repeat(sig.length));
  check("resolveSignedFile: sig errado → null", bad === null);
  const expired = ClinicMonthlyReportDeliveryService.resolveSignedFile(keyA, "1", sig);
  check("resolveSignedFile: exp no passado → null", expired === null);
  const traversal = ClinicMonthlyReportDeliveryService.resolveSignedFile("../../etc/passwd", exp, sig);
  check("resolveSignedFile: traversal → null", traversal === null);

  // ── 13. dispatchAll: só orgs opt-in ─────────────────────────────────────
  // Zera todos os opt-ins criados anteriormente pra isolar a asserção — só
  // as duas orgs abaixo (Y1 e Y2) participam desta rodada.
  db.prepare(`UPDATE organization_settings SET clinic_monthly_report_enabled = 0`).run();
  const Y1 = seedOrg("Y1");
  const recipY1 = Y1.mkContact("Owner Y1", "5511444444441");
  LgpdService.grantConsent(Y1.orgId, recipY1, "comunicacoes", { actorId: Y1.actorId });
  enableAutomatic(Y1.orgId, recipY1, 10);
  const Y2 = seedOrg("Y2");
  const recipY2 = Y2.mkContact("Owner Y2", "5511444444442");
  LgpdService.grantConsent(Y2.orgId, recipY2, "comunicacoes", { actorId: Y2.actorId });
  enableAutomatic(Y2.orgId, recipY2, 10);
  // OFF (org sem opt-in) NÃO deve ser tocada
  const beforeAll = sends.length;
  const sumAll = await ClinicMonthlyReportDeliveryService.dispatchAll({ nowMs: lateNow, sender });
  check("dispatchAll: orgs conta só opt-in (Y1 + Y2 = 2)", sumAll.orgs === 2, JSON.stringify(sumAll));
  check("dispatchAll: as 2 orgs enviaram (sent=2)", sumAll.sent === 2, JSON.stringify(sumAll));
  check("dispatchAll: sender chamado 2×", sends.length === beforeAll + 2);

  // ── 14. Isolamento multi-tenant do list ──────────────────────────────────
  const listA = ClinicMonthlyReportDeliveryService.list(A.orgId);
  check("list org A: histórico visível", listA.length >= 2, String(listA.length));
  const listY = ClinicMonthlyReportDeliveryService.list(Y1.orgId);
  check("list org Y1: só entrega própria", listY.length === 1 && listY[0].month === "2026-06");
  const listOff = ClinicMonthlyReportDeliveryService.list(OFF.orgId);
  check("list org OFF: 1 row skipped", listOff.length === 1 && listOff[0].status === "skipped");

  // ── 15. Auditoria ────────────────────────────────────────────────────────
  const sentCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'CLINIC_MONTHLY_REPORT_SENT'`
  ).get(A.orgId) as any;
  check("audit CLINIC_MONTHLY_REPORT_SENT ≥ 2 (feliz + force)", Number(sentCnt?.c) >= 2, String(sentCnt?.c));

  const skipCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE event_type = 'CLINIC_MONTHLY_REPORT_SKIPPED'`
  ).get() as any;
  check("audit SKIPPED ≥ 3 (disabled + no_recipient + LGPD)", Number(skipCnt?.c) >= 3, String(skipCnt?.c));

  const failCnt = db.prepare(
    `SELECT COUNT(*) AS c FROM auth_audit_logs WHERE event_type = 'CLINIC_MONTHLY_REPORT_FAILED'`
  ).get() as any;
  check("audit FAILED ≥ 3 (no_id + no_channel + provider throw)", Number(failCnt?.c) >= 3, String(failCnt?.c));

  const sentMeta = db.prepare(
    `SELECT metadata_json FROM auth_audit_logs
      WHERE organization_id = ? AND event_type = 'CLINIC_MONTHLY_REPORT_SENT'
      ORDER BY created_at ASC, rowid ASC LIMIT 1`
  ).get(A.orgId) as any;
  const meta = JSON.parse(sentMeta?.metadata_json || "{}");
  check("audit SENT metadata carrega month", meta.month === "2026-06");
  check("audit SENT metadata carrega deliveryId", typeof meta.deliveryId === "string" && meta.deliveryId.length > 0);
  check("audit SENT metadata carrega channelId", meta.channelId === A.channelId);
  check("audit SENT metadata mascara identifier (5511***4321)",
    meta.toIdentifier === "5511***4321", String(meta.toIdentifier));
  check("audit SENT metadata NÃO expõe identifier completo",
    meta.toIdentifier !== "5511987654321", String(meta.toIdentifier));

  // ── 16. normalizeMonth default = mês anterior ────────────────────────────
  const nowJul = Date.parse("2026-07-15T09:00:00Z");
  check("normalizeMonth default (jul → jun anterior)", normalizeMonth(undefined, nowJul) === "2026-06");
  const nowJan = Date.parse("2026-01-15T09:00:00Z");
  check("normalizeMonth em janeiro → dezembro do ano anterior", normalizeMonth(undefined, nowJan) === "2025-12");

  console.log("\n=== Envio automático do relatório mensal (ADR-080 Fase 33) ===");
  for (const rr of results) console.log(`${rr.ok ? "PASS" : "FAIL"}  ${rr.name}${rr.ok || !rr.detail ? "" : ` — ${rr.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
