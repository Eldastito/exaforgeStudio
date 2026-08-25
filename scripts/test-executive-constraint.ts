/**
 * TEST — Executive Constraint & Worst-Pillar (ADR-190 F5, CEO Operating Layer).
 * Company-level "onde focar" sobre o snapshot (F4): pilar em pior forma + a
 * RESTRIÇÃO nº1 (desvio de maior score) como HIPÓTESE (§5), nunca causa provada.
 *
 * Cobre: sem desvio → constraint/worstPillar null (null≠zero) · constraint = maior
 * score · pilar em pior forma pela saúde · meta ameaçada de affectedGoal · rótulo
 * hipótese · redação de dinheiro (§73) · isolamento multi-tenant.
 *
 * Uso: npm run test:executive-constraint
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-econstr-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-econstr-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ExecutiveConstraintService: C } = await import("../src/server/ExecutiveConstraintService.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Clínica', 'active')`).run(randomUUID(), A);

  // ── 1. Sem desvio → constraint/worstPillar null (honesto, não inventa gargalo) ──
  const a0 = C.assess(A);
  check("1.1 sem desvio → constraint null", a0.constraint === null);
  check("1.2 sem desvio → worstPillar null", a0.worstPillar === null);
  check("1.3 pillarsRanked traz os 3 pilares", a0.pillarsRanked.length === 3);

  // ── 2. Dois desvios: financeiro crítico (score alto) + comercial de risco ──
  BusinessSignalService.publish(A, {
    domain: "finance", signalType: "overdue_spike", severity: "critical", basis: "fact", confidence: 1,
    impactAmount: 8000, impactUnit: "BRL", sourceService: "test", evidence: { n: 5 }, dedupeKey: "fin-crit-1",
  });
  BusinessSignalService.publish(A, {
    domain: "sales", signalType: "conversion_drop", severity: "risk", basis: "fact", confidence: 0.7,
    sourceService: "test", evidence: { pct: -15 }, dedupeKey: "sales-risk-1",
  });
  const a1 = C.assess(A);

  // ── 3. Constraint = o desvio de MAIOR score (financeiro crítico) ──
  check("3.1 constraint existe", !!a1.constraint);
  check("3.2 constraint é o desvio financeiro crítico", a1.constraint?.type === "overdue_spike" && a1.constraint?.pillar === "finance");
  check("3.3 constraint tem severidade normalizada (critical)", a1.constraint?.severity === "critical");
  check("3.4 constraint carrega ação recomendada + score", !!a1.constraint?.recommendedAction && typeof a1.constraint?.score === "number");

  // ── 4. É HIPÓTESE (§5), nunca causa provada ──
  check("4.1 rationale rotulado hypothesis", (a1.constraint?.rationale || "").startsWith("hypothesis"));

  // ── 5. Pilar em pior forma = finance (tem o crítico) ──
  check("5.1 worstPillar = finance", a1.worstPillar?.pillar === "finance" && a1.worstPillar?.health === "critical");
  check("5.2 finance no topo do ranking; criticalCount ≥ 1", a1.pillarsRanked[0].pillar === "finance" && a1.pillarsRanked[0].criticalCount >= 1);

  // ── 6. Redação de dinheiro (§73): includeMoney:false zera o impacto BRL ──
  const aR = C.assess(A, { includeMoney: false });
  check("6.1 impacto BRL redigido", aR.constraint?.impact?.amount === null && (aR.constraint?.impact as any)?.redacted === true);
  // default (true) mantém o valor.
  check("6.2 default expõe R$ do impacto", a1.constraint?.impact?.amount === 8000);

  // ── 7. Isolamento multi-tenant ──
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja', 'active')`).run(randomUUID(), B);
  const b0 = C.assess(B);
  check("7.1 org B sem constraint (não vê desvios de A)", b0.constraint === null && b0.worstPillar === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} executive-constraint: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
