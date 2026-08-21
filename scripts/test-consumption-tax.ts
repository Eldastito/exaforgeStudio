/**
 * TEST — Motor de cálculo CBS/IBS/IS (ADR-181 F3). DB-backed, determinístico, isolado.
 * Prova: honesto sem regime (profile_incomplete, RN-FISCAL-4); tributo sem alíquota vigente →
 * unknown (amount null, NUNCA 0 — RN-FISCAL-1); date-effective; recorte por regime
 * (MEI/Simples DAS × híbrido/regular geral) + modo de recolhimento + crédito; IS só em item
 * seletivo; aritmética correta; isolamento.
 *
 * Uso: npm run test:consumption-tax
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ctax-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ctax-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalProfileService: FP } = await import("../src/server/FiscalProfileService.js");
  const { TaxReferenceService: TAX } = await import("../src/server/TaxReferenceService.js");
  const { ConsumptionTaxService: CTAX } = await import("../src/server/ConsumptionTaxService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, address_state) VALUES (?, ?, 'A', 'active', 'moda', 'RS')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'B', 'active', 'petshop')`).run(randomUUID(), B);

  // 1. Sem regime declarado → profile_incomplete, NÃO calcula (RN-FISCAL-4).
  const r0 = CTAX.compute(A, { baseValue: 100, date: "2026-06-01" });
  check("1.1 sem regime → profile_incomplete", r0.status === "profile_incomplete" && r0.missing?.includes("regime") === true);
  check("1.2 nada é zero-inventado (amount null)", r0.taxes.cbs.amount === null && r0.totalTax === null);

  // 2. Declara Simples e curamos a fase-teste 2026 (CBS 0,9% geral, IBS 0,1% geral).
  FP.save(A, { regime: "simples" }, "userA");
  TAX.curate({ tribute: "cbs", phase: "teste_2026", ratePercent: 0.9, reviewedBy: "aud", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "m");
  TAX.curate({ tribute: "ibs", phase: "teste_2026", ratePercent: 0.1, reviewedBy: "aud", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "m");

  // 2a. Simples usa recorte simples_das, mas sem alíquota específica cai no GERAL (precedência F2).
  const r1 = CTAX.compute(A, { baseValue: 1000, date: "2026-06-01" });
  check("2.1 computed", r1.status === "computed" && r1.regime === "simples");
  check("2.2 recorte simples_das", r1.scope === "simples_das");
  check("2.3 CBS 0,9% de 1000 = 9,00", r1.taxes.cbs.rate === 0.9 && r1.taxes.cbs.amount === 9);
  check("2.4 IBS 0,1% de 1000 = 1,00", r1.taxes.ibs.amount === 1);
  check("2.5 total = 10,00 (só CBS+IBS; IS n/a)", r1.totalTax === 10);
  check("2.6 IS not_applicable sem selective", r1.taxes.is.status === "not_applicable");
  check("2.7 Simples recolhe DENTRO do DAS", r1.collectionMode === "das_embedded" && r1.creditEligible === false);
  check("2.8 partial false (CBS+IBS conhecidos)", r1.partial === false);

  // 3. RN-FISCAL-1: fora da vigência (2025) → cbs/ibs unknown, amount null, NUNCA 0.
  const r2 = CTAX.compute(A, { baseValue: 1000, date: "2025-06-01" });
  check("3.1 pré-vigência → cbs unknown (null, não 0)", r2.taxes.cbs.status === "unknown" && r2.taxes.cbs.amount === null);
  check("3.2 total null quando nada conhecido", r2.totalTax === null && r2.partial === true);

  // 4. date-effective: cura a fase cheia 2027 no geral (8,8%) e checa a virada.
  TAX.curate({ tribute: "cbs", phase: "cheia_2027", ratePercent: 8.8, reviewedBy: "aud", effectiveFrom: "2027-01-01" }, "m");
  const r3 = CTAX.compute(A, { baseValue: 1000, date: "2027-06-01" });
  check("4.1 2027 → CBS cheia 8,8% = 88,00", r3.taxes.cbs.amount === 88);
  check("4.2 IBS 2027 sem cura → unknown (partial)", r3.taxes.ibs.status === "unknown" && r3.partial === true);
  check("4.3 total só com CBS conhecido = 88", r3.totalTax === 88);

  // 5. Recorte MEI: cura CBS 0,9% 'mei' em 2027; MEI usa o recorte, não o geral 8,8%.
  FP.save(A, { regime: "mei" }, "userA");
  TAX.curate({ tribute: "cbs", phase: "mei_2027", ratePercent: 0.9, appliesTo: "mei", reviewedBy: "aud", effectiveFrom: "2027-01-01" }, "m");
  const r4 = CTAX.compute(A, { baseValue: 1000, date: "2027-06-01" });
  check("5.1 MEI usa recorte 'mei' 0,9% (não o geral 8,8%)", r4.scope === "mei" && r4.taxes.cbs.amount === 9);
  check("5.2 MEI dentro do DAS, sem crédito", r4.collectionMode === "das_embedded" && r4.creditEligible === false);

  // 6. Regime regular (híbrido) usa GERAL e gera crédito.
  FP.save(A, { regime: "simples_hibrido", regimeRegularOptin: true }, "userA");
  const r5 = CTAX.compute(A, { baseValue: 1000, date: "2027-06-01" });
  check("6.1 híbrido usa geral (8,8%)", r5.scope === "geral" && r5.taxes.cbs.amount === 88);
  check("6.2 híbrido recolhe por fora + gera crédito", r5.collectionMode === "separate" && r5.creditEligible === true);

  // 7. IS só em item seletivo.
  TAX.curate({ tribute: "is", phase: "is_2027", ratePercent: 10, reviewedBy: "aud", effectiveFrom: "2027-01-01" }, "m");
  const r6 = CTAX.compute(A, { baseValue: 1000, date: "2027-06-01", selective: true });
  check("7.1 IS 10% em item seletivo = 100", r6.taxes.is.status === "computed" && r6.taxes.is.amount === 100);
  const r7 = CTAX.compute(A, { baseValue: 1000, date: "2027-06-01", selective: false });
  check("7.2 IS not_applicable sem selective (não presume)", r7.taxes.is.status === "not_applicable");

  // 8. Validações + isolamento.
  let eB = false; try { CTAX.compute(A, { baseValue: -5, date: "2026-01-01" }); } catch (e: any) { eB = e.message === "base_value_invalid"; }
  check("8.1 base negativa lança", eB);
  let eD = false; try { CTAX.compute(A, { baseValue: 100, date: "ontem" }); } catch (e: any) { eD = e.message === "date_invalid"; }
  check("8.2 data inválida lança", eD);
  const rB = CTAX.compute(B, { baseValue: 1000, date: "2026-06-01" });
  check("8.3 org B (sem regime) → incomplete, isolado de A", rB.status === "profile_incomplete");

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} consumption-tax: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
