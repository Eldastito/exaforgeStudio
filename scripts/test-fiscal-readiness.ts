/**
 * TEST — Prontidão fiscal agregada (ADR-187 F1). DB-backed, determinístico.
 * Prova: readyPct = só o tenant-controlado (identidade); blockers/warnings; referenceBase
 * covered×awaiting_curation (plataforma); senate pending SEMPRE (nunca gap do tenant nem alíquota
 * inventada); timeline factual com 2027 defined:false/dependsOn senate; regime nunca presumido;
 * issuance informativo; isolamento.
 *
 * Uso: npm run test:fiscal-readiness
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fiscalready-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fiscalready-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const ASOF = "2026-06-15";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FiscalReadinessService: FR } = await import("../src/server/FiscalReadinessService.js");
  const { TaxReferenceService } = await import("../src/server/TaxReferenceService.js");

  // Org completa: cnpj + regime + ibge + uf.
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_cnpj, fiscal_regime, fiscal_municipality_ibge, address_state) VALUES (?, ?, 'O', 'active', '12345678000199', 'presumido', '3550308', 'SP')`).run(randomUUID(), A);
  // Org incompleta: só cnpj + uf (falta regime + ibge).
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_cnpj, address_state) VALUES (?, ?, 'O', 'active', '99999999000199', 'RJ')`).run(randomUUID(), B);
  // Org Simples (decisão pendente).
  const C = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_cnpj, fiscal_regime, fiscal_municipality_ibge, address_state) VALUES (?, ?, 'O', 'active', '11111111000199', 'simples', '3304557', 'RJ')`).run(randomUUID(), C);

  const rA = FR.assess(A, { asOf: ASOF });

  // ── readyPct = tenant-controlado; org completa → 100 ──
  check("1.1 org completa → readyPct 100 + identity complete", rA.readyPct === 100 && rA.dimensions.identity.complete === true);
  check("1.2 sem tenantBlockers", rA.tenantBlockers.length === 0);

  // ── senate pending SEMPRE (nunca gap do tenant, nunca inventa alíquota) ──
  check("2.1 externalPending.senate presente (alíquota 2027)", rA.externalPending.senate.length === 1 && /Senado/.test(rA.externalPending.senate[0]));
  check("2.2 readyPct NÃO penalizado pelo Senado (100 mesmo assim)", rA.readyPct === 100);

  // ── referenceBase: sem curadoria → awaiting_curation (pendência de PLATAFORMA) ──
  check("3.1 CBS/IBS awaiting_curation sem base curada", rA.dimensions.referenceBase.tributes.cbs === "awaiting_curation" && rA.externalPending.platform.length === 2);

  // curar CBS pro período → covered; platform pending some pro CBS
  TaxReferenceService.curate({ tribute: "cbs", phase: "teste_2026", ratePercent: 0.9, effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31", reviewedBy: "fiscal@plataforma" });
  const rA2 = FR.assess(A, { asOf: ASOF });
  check("3.2 CBS curado → covered", rA2.dimensions.referenceBase.tributes.cbs === "covered" && rA2.externalPending.platform.length === 1);

  // ── timeline factual: 2027 defined:false / dependsOn senate ──
  const y2027 = rA.timeline.find((t) => t.when === "2027")!;
  check("4.1 timeline 2027 defined:false + dependsOn senate", y2027.defined === false && y2027.dependsOn === "senate");
  check("4.2 timeline 2026 defined:true (ano-teste)", rA.timeline.find((t) => t.when === "2026")?.defined === true);

  // ── org incompleta: readyPct parcial + blockers do que falta ──
  const rB = FR.assess(B, { asOf: ASOF });
  check("5.1 incompleta → readyPct 50 (2 de 4)", rB.readyPct === 50);
  check("5.2 blockers citam regime e IBGE (nunca presume)", rB.tenantBlockers.some((b) => /Regime/.test(b)) && rB.tenantBlockers.some((b) => /IBGE/.test(b)));
  check("5.3 regime não declarado → declared false", rB.dimensions.regime.declared === false && rB.dimensions.regime.regime === null);

  // ── Simples → decisão pendente (warning, não blocker) ──
  const rC = FR.assess(C, { asOf: ASOF });
  check("6.1 Simples → decisionPending + warning (não blocker)", rC.dimensions.regime.decisionPending === true && rC.tenantWarnings.length === 1 && rC.readyPct === 100);

  // ── issuance informativo + phase corrente ──
  check("7.1 issuance state presente (informativo)", typeof rA.dimensions.issuance.state === "string" && rA.dimensions.issuance.informative === true);
  check("7.2 currentPhase do asOf 2026", /2026/.test(rA.currentPhase));

  // ── isolamento (A completa não vaza pra B) ──
  check("8.1 A e B isolados", rA.dimensions.identity.complete === true && rB.dimensions.identity.complete === false);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} fiscal-readiness: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
