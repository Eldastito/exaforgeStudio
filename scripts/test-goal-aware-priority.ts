/**
 * TEST — PRD 2 F5 (§30-31, CA7): goal-aware prioritization. Um sinal que ameaça
 * uma META ATRASADA sobe na prioridade. Boost MULTIPLICATIVO, 0 sem meta →
 * comportamento pré-F5 idêntico (zero regressão).
 *
 * Prova (determinístico; progress() mockado):
 *   - sinal de domínio da meta atrasada ganha goalRelevance + affectedGoal +
 *     score boostado; domínio fora da meta não muda;
 *   - non-regression: sem meta atrasada, o score é o mesmo do base (boost 0);
 *   - fail-safe: erro ao ler metas não derruba a priorização;
 *   - isolamento multi-tenant.
 *
 * Uso: npm run test:goal-aware-priority
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-goal-prio-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-goal-prio-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 1e-3) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ImpactPrioritizationService: IP } = await import("../src/server/ImpactPrioritizationService.js");
  const { BusinessSignalService: BS } = await import("../src/server/BusinessSignalService.js");
  const { BusinessGoalService: BG } = await import("../src/server/BusinessGoalService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const org = mkOrg();
  BS.publish(org, { domain: "sales", signalType: "sales_drop", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", impactAmount: 5000, impactUnit: "BRL", evidence: {}, dedupeKey: "s1" });
  BS.publish(org, { domain: "tasks", signalType: "tasks_x", severity: "risk", basis: "fact", confidence: 0.9, sourceService: "test", impactAmount: 5000, impactUnit: "BRL", evidence: {}, dedupeKey: "t1" });

  const goalBehind = () => ({ generatedAt: "", period: "2026-08", goals: [{ metric: "revenue", label: "Receita mensal", unit: "BRL", target: 100000, current: 37000, remaining: 63000, attainmentPct: 37, reached: false, expectedByNow: 48000, paceStatus: "behind" }] });
  const noGoals = () => ({ generatedAt: "", period: "2026-08", goals: [] as any[] });
  const find = (out: any, dom: string) => (out.byDomain[dom] || [])[0];
  const gap = (48000 - 37000) / 48000; // 0.2291…

  // ===== 1. Sem meta (base) =====
  (BG as any).progress = noGoals;
  const base = IP.prioritize(org);
  const salesBase = find(base, "sales"), tasksBase = find(base, "tasks");
  check("1.1 sem meta: goalRelevance 0 + affectedGoal null (ambos)", salesBase.components.goalRelevance === 0 && salesBase.affectedGoal == null && tasksBase.components.goalRelevance === 0);

  // ===== 2. Com meta de receita atrasada =====
  (BG as any).progress = goalBehind;
  const withGoal = IP.prioritize(org);
  const salesG = find(withGoal, "sales"), tasksG = find(withGoal, "tasks");
  check("2.1 sales (domínio de receita): goalRelevance = gap + affectedGoal", near(salesG.components.goalRelevance, gap) && salesG.affectedGoal?.metric === "revenue");
  check("2.2 sales: score BOOSTADO = base * (1 + 0.5*gap)", near(salesG.score, salesBase.score * (1 + 0.5 * gap)));
  check("2.3 tasks (fora da meta): NÃO boosta (goalRelevance 0, affectedGoal null, score igual)", tasksG.components.goalRelevance === 0 && tasksG.affectedGoal == null && near(tasksG.score, tasksBase.score));
  check("2.4 affectedGoal traz o gapPct legível", near(salesG.affectedGoal.gapPct, Math.round(gap * 100 * 100) / 100));

  // ===== 3. Meta no ritmo (on_track) → sem boost =====
  (BG as any).progress = () => ({ generatedAt: "", period: "", goals: [{ metric: "revenue", label: "x", unit: "BRL", target: 100000, current: 50000, remaining: 50000, attainmentPct: 50, reached: false, expectedByNow: 48000, paceStatus: "on_track" }] });
  check("3.1 meta no ritmo não boosta", find(IP.prioritize(org), "sales").components.goalRelevance === 0);

  // ===== 4. Fail-safe: erro ao ler metas não derruba =====
  (BG as any).progress = () => { throw new Error("metas indisponíveis"); };
  const safe = IP.prioritize(org);
  check("4.1 erro em progress() → prioriza mesmo assim (boost 0)", find(safe, "sales").components.goalRelevance === 0 && near(find(safe, "sales").score, salesBase.score));

  // ===== 5. Isolamento =====
  (BG as any).progress = goalBehind;
  const orgB = mkOrg();
  check("5.1 org sem sinais → priorização vazia", IP.prioritize(orgB).global.length === 0);

  console.log("\n=== TEST: Goal-aware prioritization F5 (PRD 2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Goal-aware prioritization F5 OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
