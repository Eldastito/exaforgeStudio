/**
 * TESTE — Conferência PDV × Adquirente (ADR-083 Fase R1).
 * ---------------------------------------------------------------------------
 * Prova o cruzamento entre `retail_pdv_card_installments` (o que o PDV
 * Alterdata gravou) e `retail_card_acquirer_installments` (o que a Sicredi
 * diz que vai depositar).
 *
 * Cobre:
 *   - importManual: upsert por (source, numero_transacao, parcela);
 *   - reconcile: 4 buckets (match / diverge / só PDV / só adquirente);
 *   - tolerância de R$ 0,05 no valor;
 *   - stub da API (syncFromSicrediApi lança sicredi_api_not_configured);
 *   - isolamento multi-tenant;
 *   - audit registrado.
 *
 * Uso:  npm run test:retail-card-acquirer
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-card-acq-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-card-acquirer-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCardAcquirerService } = await import("../src/server/RetailCardAcquirerService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // ── Pré: 4 parcelas no lado do PDV (Alterdata) ────────────────────────────
  //   NSU 1001 (1/1, 300,00) — bate com adquirente
  //   NSU 1002 (1/1, 200,00) — diverge (adquirente diz 195,00)
  //   NSU 1003 (1/1, 500,00) — só no PDV (adquirente não confirma)
  const insPdv = db.prepare(
    `INSERT INTO retail_pdv_card_installments (id, organization_id, filial, sale_date, numero, parcela, seq, codigo_cartao, valor, liquido, taxa, vencimento)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?)`
  );
  insPdv.run(randomUUID(), A, "1", "2026-08-01", "1001", "1/1", "01", 300, 288, "2026-08-15");
  insPdv.run(randomUUID(), A, "1", "2026-08-01", "1002", "1/1", "03", 200, 192, "2026-08-15");
  insPdv.run(randomUUID(), A, "1", "2026-08-02", "1003", "1/1", "01", 500, 480, "2026-08-16");

  // ── Import manual: 3 linhas do adquirente ─────────────────────────────────
  //   NSU 1001 → bate
  //   NSU 1002 → diverge no valor
  //   NSU 2001 → só na Sicredi (PDV não tem)
  const imp1 = RetailCardAcquirerService.importManual(A, "sicredi", [
    { numeroTransacao: "1001", parcela: "1/1", dataVencimento: "2026-08-15", valorBruto: 300, valorLiquido: 288, bandeira: "Visa" },
    { numeroTransacao: "1002", parcela: "1/1", dataVencimento: "2026-08-15", valorBruto: 195, valorLiquido: 188, bandeira: "Master" },
    { numeroTransacao: "2001", parcela: "1/1", dataVencimento: "2026-08-15", valorBruto: 150, valorLiquido: 144, bandeira: "Elo" },
  ], "tester");
  check("importManual: 3 novas linhas", imp1.inserted === 3 && imp1.updated === 0);

  // Rodar de novo com valor diferente no 2001 = updated=3, inserted=0.
  const imp2 = RetailCardAcquirerService.importManual(A, "sicredi", [
    { numeroTransacao: "1001", parcela: "1/1", dataVencimento: "2026-08-15", valorBruto: 300, valorLiquido: 288, bandeira: "Visa" },
    { numeroTransacao: "1002", parcela: "1/1", dataVencimento: "2026-08-15", valorBruto: 195, valorLiquido: 188, bandeira: "Master" },
    { numeroTransacao: "2001", parcela: "1/1", dataVencimento: "2026-08-15", valorBruto: 155, valorLiquido: 148, bandeira: "Elo" }, // valor mudou
  ], "tester");
  check("importManual reexecuta como upsert (updated=3)", imp2.updated === 3 && imp2.inserted === 0, `imp2=${JSON.stringify(imp2)}`);

  // Linha inválida (sem NSU) é skipped.
  const impBad = RetailCardAcquirerService.importManual(A, "sicredi", [
    { numeroTransacao: "", dataVencimento: "2026-08-15", valorBruto: 10 } as any,
    { numeroTransacao: "9999", dataVencimento: "bad-date", valorBruto: 10 } as any,
  ], "tester");
  check("importManual pula linhas sem NSU / com vencimento inválido", impBad.skipped === 2 && impBad.inserted === 0);

  // ── reconcile ─────────────────────────────────────────────────────────────
  const recon = RetailCardAcquirerService.reconcile(A, "2026-08-01", "2026-08-31");
  check("reconcile: 1 match (NSU 1001 R$ 300)", recon.counts.matched === 1 && recon.matched[0].numero === "1001", JSON.stringify(recon.counts));
  check("reconcile: 1 diverge (NSU 1002 gap ~R$ 5)", recon.counts.diverged === 1 && Math.abs(recon.diverged[0].gap - 5) < 0.01, `diverged=${JSON.stringify(recon.diverged[0])}`);
  check("reconcile: 1 só PDV (NSU 1003)", recon.counts.onlyPdv === 1 && recon.onlyPdv[0].numero === "1003");
  check("reconcile: 1 só adquirente (NSU 2001)", recon.counts.onlyAcquirer === 1 && recon.onlyAcquirer[0].numero_transacao === "2001");
  check("reconcile: totais fecham (PDV 1000 vs Sicredi 650)", recon.totals.pdv === 1000 && recon.totals.acquirer === 650, JSON.stringify(recon.totals));

  // Tolerância de R$ 0,05 — diferença de 4 centavos deve virar match.
  insPdv.run(randomUUID(), A, "1", "2026-08-03", "1004", "1/1", "01", 100.04, 96, "2026-08-17");
  RetailCardAcquirerService.importManual(A, "sicredi", [{ numeroTransacao: "1004", parcela: "1/1", dataVencimento: "2026-08-17", valorBruto: 100.00, bandeira: "Visa" }], "tester");
  const rec2 = RetailCardAcquirerService.reconcile(A, "2026-08-01", "2026-08-31");
  const m1004 = rec2.matched.find((r: any) => r.numero === "1004");
  check("Tolerância 0,04 vira match, não diverge", !!m1004 && !rec2.diverged.some((r: any) => r.numero === "1004"), `m1004=${!!m1004} div1004=${rec2.diverged.some((r: any) => r.numero === "1004")}`);

  // ── Stub da API ────────────────────────────────────────────────────────────
  let stubError = "";
  try { await RetailCardAcquirerService.syncFromSicrediApi(A, { start: "2026-08-01", end: "2026-08-31" }); }
  catch (e: any) { stubError = e?.message || ""; }
  check("syncFromSicrediApi é stub — lança sicredi_api_not_configured", stubError === "sicredi_api_not_configured");

  // ── Isolamento ────────────────────────────────────────────────────────────
  const reconB = RetailCardAcquirerService.reconcile(B, "2026-08-01", "2026-08-31");
  check("org B não vê nada de A", reconB.counts.matched === 0 && reconB.counts.diverged === 0 && reconB.counts.onlyPdv === 0 && reconB.counts.onlyAcquirer === 0);

  // ── Audit ─────────────────────────────────────────────────────────────────
  const audit = db.prepare(`SELECT event_type FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_CARD_ACQUIRER_IMPORTED'`).all(A) as any[];
  check("audit: import registrado", audit.length >= 3);

  // ── wipe ──────────────────────────────────────────────────────────────────
  const removed = RetailCardAcquirerService.wipe(A, "sicredi");
  check("wipe(sicredi) remove todas as linhas da fonte", removed >= 4);
  const recAfterWipe = RetailCardAcquirerService.reconcile(A, "2026-08-01", "2026-08-31");
  check("Após wipe: tudo vira 'só PDV'", recAfterWipe.counts.matched === 0 && recAfterWipe.counts.onlyPdv === 4);

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  → ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} PASS`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
