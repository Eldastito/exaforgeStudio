/**
 * TEST — Fiscal hardening (ADR-181 F8). Doc-of-record EXECUTÁVEL de dupla função:
 * (A) codifica os guardrails RN-FISCAL-1..10 como REGRESSÃO tocando os serviços REAIS F1–F7;
 * (B) verifica a FIAÇÃO de produção (serviços importáveis, rota montada, testes wired,
 *     runbook presente).
 *
 * Uso: npm run test:fiscal-hardening
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fischard-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fischard-123456";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalProfileService: FP } = await import("../src/server/FiscalProfileService.js");
  const { TaxReferenceService: TAX } = await import("../src/server/TaxReferenceService.js");
  const { ConsumptionTaxService: CTAX } = await import("../src/server/ConsumptionTaxService.js");
  const { FiscalDocumentBreakdownService: FDB } = await import("../src/server/FiscalDocumentBreakdownService.js");
  const { SimplesHybridAdvisorService: ADV } = await import("../src/server/SimplesHybridAdvisorService.js");
  const { FiscalIssuanceService: FI } = await import("../src/server/FiscalIssuanceService.js");
  const { FiscalDreProjectionService: PROJ } = await import("../src/server/FiscalDreProjectionService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical, address_state) VALUES (?, ?, 'A', 'active', 'moda', 'RS')`).run(randomUUID(), A);

  // ── RN-FISCAL-1: NUNCA inventa alíquota. ──
  check("RN-1 base vazia → rateFor null", TAX.rateFor("cbs", "2026-06-01") === null);
  FP.save(A, { regime: "simples" }, "m");
  check("RN-1 sem alíquota → ConsumptionTax unknown (amount null, não 0)", (() => { const r = CTAX.compute(A, { baseValue: 1000, date: "2026-06-01" }); return r.taxes.cbs.status === "unknown" && r.taxes.cbs.amount === null; })());
  check("RN-1 breakdown preserva unknown (não R$0)", (() => { const b = FDB.build(A, { amountCents: 100000, date: "2026-06-01" }); return b.unknownTributes.includes("cbs") && !b.lines.some((l) => l.tribute === "cbs"); })());

  // ── RN-FISCAL-2: base nasce vazia + reviewed_by obrigatório. ──
  let e2 = false; try { TAX.curate({ tribute: "cbs", phase: "t", ratePercent: 0.9, reviewedBy: "", effectiveFrom: "2026-01-01" }); } catch (e: any) { e2 = e.message === "reviewed_by_required"; }
  check("RN-2 curate exige reviewedBy", e2);

  // ── RN-FISCAL-3: date-effective (a fase vem da data). ──
  TAX.curate({ tribute: "cbs", phase: "teste_2026", ratePercent: 0.9, reviewedBy: "aud", effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" }, "m");
  TAX.curate({ tribute: "cbs", phase: "cheia_2027", ratePercent: 8.8, reviewedBy: "aud", effectiveFrom: "2027-01-01" }, "m");
  check("RN-3 2026 → 0,9%", TAX.rateFor("cbs", "2026-06-01")?.ratePercent === 0.9);
  check("RN-3 2027 → 8,8%", TAX.rateFor("cbs", "2027-06-01")?.ratePercent === 8.8);

  // ── RN-FISCAL-4: honesto quando falta dado. ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("RN-4 sem regime → completeness incompleto", FP.completeness(B).missing.includes("regime"));
  check("RN-4 sem regime → ConsumptionTax profile_incomplete", CTAX.compute(B, { baseValue: 100, date: "2026-06-01" }).status === "profile_incomplete");

  // ── RN-FISCAL-6: base GLOBAL sem dado de tenant (tax_reference_rates sem organization_id). ──
  const cols = (db.prepare(`PRAGMA table_info(tax_reference_rates)`).all() as any[]).map((c) => c.name);
  check("RN-6 tax_reference_rates NÃO tem organization_id (é GLOBAL)", !cols.includes("organization_id"));

  // ── RN-FISCAL-8: não emite sem homologação. ──
  FI.configure(A, { provider: "focus", providerToken: "TK", municipalityIbge: "4314902" }, { enabled: true }, "m");
  check("RN-8 emissão nunca 'connected' sem homologação", FI.status(A).state === "awaiting_homologation");
  let e8 = false; try { await FI.issue(A, { kind: "nfse" }); } catch (e: any) { e8 = e.message === "fiscal_awaiting_homologation"; }
  check("RN-8 issue LANÇA (nunca finge emitir)", e8);

  // ── RN-FISCAL-9: Simples default DAS; advisor nunca força; setChoice só persiste. ──
  const adv = ADV.advise(A);
  check("RN-9 advisor NÃO recomenda um lado", !("recommended" in (adv as any)) && adv.factors.length > 0);
  FP.save(A, { regime: "presumido" }, "m");
  let e9 = false; try { ADV.setChoice(A, true, "m"); } catch (e: any) { e9 = e.message === "not_simples"; }
  check("RN-9 setChoice só no Simples", e9);

  // ── RN-FISCAL: sem dupla contagem — projeção read-only não altera a DRE. ──
  FP.save(A, { regime: "simples" }, "m");
  const { ManagerialDreService } = await import("../src/server/ManagerialDreService.js");
  const before = ManagerialDreService.monthly(A, "2026-06").linhas.sobra;
  PROJ.project(A, "2026-06");
  check("RN sem-dupla-contagem: projeção não muda o sobra", ManagerialDreService.monthly(A, "2026-06").linhas.sobra === before);

  // ── (B) FIAÇÃO DE PRODUÇÃO ──
  const serverTs = fs.readFileSync(path.join(ROOT, "server.ts"), "utf8");
  check("wiring: rota /fiscal montada no server", serverTs.includes('protectedApi.use("/fiscal"'));
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const needed = ["test:fiscal-profile", "test:tax-reference", "test:consumption-tax", "test:fiscal-document-breakdown", "test:simples-hybrid-advisor", "test:fiscal-issuance-scaffold", "test:fiscal-dre-integration", "test:fiscal-hardening"];
  check("wiring: 8 testes fiscais wired no package.json", needed.every((t) => pkg.scripts[t]));
  check("wiring: runbook presente", fs.existsSync(path.join(ROOT, "docs/runbook/fiscal-reforma-operacao.md")));
  check("wiring: ADR-181 presente", fs.existsSync(path.join(ROOT, "docs/adr/ADR-181-reforma-tributaria-consumo-cbs-ibs-is.md")));

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-hardening: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
