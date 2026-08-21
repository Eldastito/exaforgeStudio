/**
 * TEST — Breakdown CBS/IBS/IS para documentos + congelamento no recibo (ADR-181 F4).
 * DB-backed, determinístico, isolado. Prova: o bloco é honesto (perfil incompleto → não
 * aplicável; unknown preserva lacuna, nunca R$ 0); centavos corretos; renderLines humano; e o
 * recibo CONGELA o bloco no issue (recurar alíquota depois NÃO muda o documento — convenção nº 3).
 *
 * Uso: npm run test:fiscal-document-breakdown
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fdbreak-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fdbreak-123456"; process.env.APP_URL = "https://zappflow.test";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalProfileService: FP } = await import("../src/server/FiscalProfileService.js");
  const { TaxReferenceService: TAX } = await import("../src/server/TaxReferenceService.js");
  const { FiscalDocumentBreakdownService: FDB } = await import("../src/server/FiscalDocumentBreakdownService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, address_state) VALUES (?, ?, 'A', 'active', 'clinica', 'RS')`).run(randomUUID(), A);

  // 1. Perfil incompleto → bloco não-aplicável, honesto (nunca fabrica linha).
  const b0 = FDB.build(A, { amountCents: 20000, date: "2026-06-01" });
  check("1.1 sem regime → applicable false", b0.applicable === false && b0.status === "profile_incomplete");
  check("1.2 sem linhas, total null", b0.lines.length === 0 && b0.totalCents === null);
  check("1.3 renderLines diz informativo indisponível", FDB.renderLines(b0)[0].includes("indisponível"));

  // 2. Declara Simples + cura teste 2026. Bloco em CENTAVOS: R$200,00 → CBS 0,9%=180c, IBS 0,1%=20c.
  FP.save(A, { regime: "simples" }, "u");
  TAX.curate({ tribute: "cbs", phase: "teste_2026", ratePercent: 0.9, reviewedBy: "aud", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "m");
  TAX.curate({ tribute: "ibs", phase: "teste_2026", ratePercent: 0.1, reviewedBy: "aud", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "m");
  const b1 = FDB.build(A, { amountCents: 20000, date: "2026-06-01" });
  check("2.1 aplicável e computed", b1.applicable === true && b1.status === "computed");
  check("2.2 CBS 180c (0,9% de 20000c)", b1.lines.find((l) => l.tribute === "cbs")?.amountCents === 180);
  check("2.3 IBS 20c (0,1% de 20000c)", b1.lines.find((l) => l.tribute === "ibs")?.amountCents === 20);
  check("2.4 total 200c", b1.totalCents === 200);
  check("2.5 modo DAS (Simples), sem crédito", b1.collectionMode === "das_embedded" && b1.creditEligible === false);
  check("2.6 schema versionado", b1.schema === "fiscal_breakdown_v1");
  const lines = FDB.renderLines(b1);
  check("2.7 render traz CBS/IBS + total DAS", lines.some((l) => l.includes("CBS")) && lines.some((l) => l.includes("dentro do DAS")));

  // 3. RN-FISCAL-1: IBS não curado em 2027 → unknownTributes, nunca R$ 0.
  TAX.curate({ tribute: "cbs", phase: "cheia_2027", ratePercent: 8.8, reviewedBy: "aud", effectiveFrom: "2027-01-01" }, "m");
  const b2 = FDB.build(A, { amountCents: 20000, date: "2027-06-01" });
  check("3.1 CBS 1760c (8,8% de 20000c)", b2.lines.find((l) => l.tribute === "cbs")?.amountCents === 1760);
  check("3.2 IBS não vira linha 0 — entra em unknownTributes", !b2.lines.some((l) => l.tribute === "ibs") && b2.unknownTributes.includes("ibs"));
  check("3.3 partial true", b2.partial === true);
  check("3.4 render mostra IBS aguardando alíquota (não R$ 0)", FDB.renderLines(b2).some((l) => l.includes("aguardando alíquota")));

  // 4. Congelamento no recibo: emite com breakdown, depois RECURA e prova que o snapshot não muda.
  const { ClinicAgendaService } = await import("../src/server/ClinicAgendaService.js");
  const { ClinicEncounterService } = await import("../src/server/ClinicEncounterService.js");
  const { ClinicReceiptService } = await import("../src/server/ClinicReceiptService.js");
  const { LgpdService } = await import("../src/server/LgpdService.js");

  const channelId = `ch_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'whatsapp_cloud', 'Canal', 'wa_fiscal', 'connected')`).run(channelId, A);
  const contactId = randomUUID();
  db.prepare(`INSERT INTO contacts (id, organization_id, channel_id, name, identifier) VALUES (?, ?, ?, 'Paciente Fiscal', ?)`).run(contactId, A, channelId, `55${Math.floor(Math.random() * 1e8)}`);
  LgpdService.grantConsent(A, contactId, "dados_sensiveis", { actorId: "u" });
  const dra = ClinicAgendaService.createProfessional(A, { name: "Dra. Fiscal", registrationNumber: "55555", council: "CRM/SP" }, "u");
  const appt = ClinicAgendaService.createAppointment(A, { contactId, title: "T", scheduledStart: "2026-11-01T09:00:00-03:00", professionalId: dra.id, durationMinutes: 30, force: true }, "u");
  const enc = ClinicEncounterService.open(A, appt.id, "u");
  const receipt = ClinicReceiptService.create(A, enc.id, { amountCents: 20000, paymentMethod: "pix", description: "Consulta" }, "u");
  const issued = ClinicReceiptService.issue(A, receipt.id, "u");
  check("4.1 recibo emitido congela o bloco (CBS 180c em 2026)", issued.fiscalBreakdownSnapshot?.applicable === true && issued.fiscalBreakdownSnapshot?.lines?.find((l: any) => l.tribute === "cbs")?.amountCents === 180);

  // RECURA a alíquota de 2026 pra 2% e reabre o recibo — o snapshot NÃO pode mudar.
  const beforeJson = JSON.stringify(ClinicReceiptService.get(A, receipt.id)!.fiscalBreakdownSnapshot);
  db.prepare(`UPDATE tax_reference_rates SET rate_percent = 2.0 WHERE tribute = 'cbs' AND phase = 'teste_2026'`).run();
  const afterJson = JSON.stringify(ClinicReceiptService.get(A, receipt.id)!.fiscalBreakdownSnapshot);
  check("4.2 congelado: recurar alíquota NÃO altera o recibo emitido", beforeJson === afterJson && afterJson.includes('"amountCents":180'));

  // 5. PDF traz o bloco informativo.
  const pdf = await ClinicReceiptService.renderPdf(A, receipt.id);
  check("5.1 PDF gerado (magic %PDF-)", pdf.slice(0, 5).toString() === "%PDF-");

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-document-breakdown: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
