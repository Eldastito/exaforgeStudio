/**
 * TEST — Base de Referência Tributária curada (ADR-181 F2). DB-backed, determinístico.
 * Prova: NASCE VAZIA (RN-FISCAL-1/2); curate valida forma + exige reviewedBy; rateFor é
 * DATE-EFFECTIVE (janela from..to) e retorna null fora da vigência (nunca inventa); precedência
 * de recorte (simples_das > geral); archive não apaga; status honesto.
 *
 * Uso: npm run test:tax-reference
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-taxref-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-taxref-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { TaxReferenceService: TAX } = await import("../src/server/TaxReferenceService.js");

  // 0. NASCE VAZIA (RN-FISCAL-1/2): sem seed embutida, rateFor devolve null p/ qualquer data.
  check("0.1 base vazia no boot", TAX.status().empty === true && TAX.status().total === 0);
  check("0.2 rateFor sem base → null (nunca inventa)", TAX.rateFor("cbs", "2026-06-01") === null);

  // 1. curate valida FORMA (RN-FISCAL-2).
  let e1 = false; try { TAX.curate({ tribute: "xpto", phase: "t", ratePercent: 1, reviewedBy: "r", effectiveFrom: "2026-01-01" }); } catch (e: any) { e1 = e.message === "tribute_invalid"; }
  check("1.1 tributo inválido lança", e1);
  let e2 = false; try { TAX.curate({ tribute: "cbs", phase: "t", ratePercent: -1, reviewedBy: "r", effectiveFrom: "2026-01-01" }); } catch (e: any) { e2 = e.message === "rate_invalid"; }
  check("1.2 alíquota negativa lança", e2);
  let e3 = false; try { TAX.curate({ tribute: "cbs", phase: "t", ratePercent: 0.9, reviewedBy: "", effectiveFrom: "2026-01-01" }); } catch (e: any) { e3 = e.message === "reviewed_by_required"; }
  check("1.3 reviewedBy obrigatório", e3);
  let e4 = false; try { TAX.curate({ tribute: "cbs", phase: "t", ratePercent: 0.9, reviewedBy: "r", effectiveFrom: "01/2026" }); } catch (e: any) { e4 = e.message === "effective_from_invalid"; }
  check("1.4 data de início inválida lança", e4);
  let e5 = false; try { TAX.curate({ tribute: "cbs", phase: "t", ratePercent: 0.9, reviewedBy: "r", effectiveFrom: "2027-01-01", effectiveTo: "2026-01-01" }); } catch (e: any) { e5 = e.message === "effective_range_invalid"; }
  check("1.5 fim antes do início lança", e5);

  // 2. Cura a fase-teste 2026 (CBS 0,9% / IBS 0,1%, janela fechada no ano) + a fase cheia 2027 (aberta).
  const cbsTest = TAX.curate({ tribute: "cbs", phase: "teste_2026", ratePercent: 0.9, reviewedBy: "auditor-fiscal", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", source: "LC 214/2025" }, "master");
  TAX.curate({ tribute: "ibs", phase: "teste_2026", ratePercent: 0.1, reviewedBy: "auditor-fiscal", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "master");
  TAX.curate({ tribute: "cbs", phase: "cheia_2027", ratePercent: 8.8, reviewedBy: "auditor-fiscal", effectiveFrom: "2027-01-01" }, "master");
  check("2.1 curou com id", !!cbsTest.id && cbsTest.ratePercent === 0.9);
  check("2.2 status não mais vazio", TAX.status().empty === false && TAX.status().byTribute.cbs === 2);

  // 3. DATE-EFFECTIVE (RN-FISCAL-3): a alíquota vale pela data do fato gerador.
  check("3.1 mid-2026 → CBS teste 0,9%", TAX.rateFor("cbs", "2026-06-15")?.ratePercent === 0.9);
  check("3.2 mid-2027 → CBS cheia 8,8%", TAX.rateFor("cbs", "2027-06-15")?.ratePercent === 8.8);
  check("3.3 antes da vigência (2025) → null", TAX.rateFor("cbs", "2025-12-31") === null);
  check("3.4 IS não curado → null (nunca inventa)", TAX.rateFor("is", "2027-06-15") === null);
  check("3.5 borda inicial inclusiva", TAX.rateFor("ibs", "2026-01-01")?.ratePercent === 0.1);
  check("3.6 borda final inclusiva", TAX.rateFor("ibs", "2026-12-31")?.ratePercent === 0.1);
  check("3.7 IBS em 2027 (só tinha teste até dez/26) → null", TAX.rateFor("ibs", "2027-01-01") === null);

  // 4. Precedência de recorte: MEI no DAS tem CBS 0,9% "cheia" também em 2027 (dentro do DAS).
  TAX.curate({ tribute: "cbs", phase: "mei_das_2027", ratePercent: 0.9, appliesTo: "mei", reviewedBy: "auditor-fiscal", effectiveFrom: "2027-01-01" }, "master");
  check("4.1 recorte mei ganha do geral em 2027", TAX.rateFor("cbs", "2027-06-15", { appliesTo: "mei" })?.ratePercent === 0.9);
  check("4.2 sem recorte cai no geral (8,8%)", TAX.rateFor("cbs", "2027-06-15")?.ratePercent === 8.8);
  check("4.3 recorte inexistente cai no geral", TAX.rateFor("cbs", "2027-06-15", { appliesTo: "simples_das" })?.ratePercent === 8.8);

  // 5. archive não apaga (histórico) e tira do rateFor.
  const arch = TAX.archive(cbsTest.id, "master");
  check("5.1 arquivou", arch.archived === true);
  check("5.2 arquivada some do rateFor de 2026", TAX.rateFor("cbs", "2026-06-15") === null);
  check("5.3 arquivar de novo → false (idempotente)", TAX.archive(cbsTest.id, "master").archived === false);
  check("5.4 list padrão não traz arquivada", !TAX.list().some((r) => r.id === cbsTest.id));
  check("5.5 includeArchived traz de volta", TAX.list({ includeArchived: true }).some((r) => r.id === cbsTest.id));

  // 6. Audit + tributo inválido no rateFor lança (não silencia).
  const audit = db.prepare(`SELECT COUNT(*) n FROM auth_audit_logs WHERE event_type = 'TAX_RATE_CURATE'`).get() as any;
  check("6.1 audit TAX_RATE_CURATE gravado", Number(audit?.n) >= 4);
  let e6 = false; try { TAX.rateFor("pis", "2026-01-01"); } catch (e: any) { e6 = e.message === "tribute_invalid"; }
  check("6.2 rateFor com tributo inválido lança", e6);
  let e7 = false; try { TAX.rateFor("cbs", "hoje"); } catch (e: any) { e7 = e.message === "date_invalid"; }
  check("6.3 rateFor com data inválida lança", e7);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} tax-reference: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
