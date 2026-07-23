/**
 * TEST — Impact Prioritization / Pareto (ADR-136, Epic 2 — C3, PRD §9).
 * Score determinístico, reproduzível sem LLM. Sem chave de IA.
 *
 * Uso: npm run test:impact-prioritization
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pareto-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-pareto-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService: S } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService: P } = await import("../src/server/ImpactPrioritizationService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  const pub = (o: string, s: any) => S.publish(o, { sourceService: "test", evidence: { k: 1 }, ...s });

  // ===== 1. Sem sinais → sem prioridades =====
  check("org sem sinais devolve global vazio", P.prioritize(orgA).global.length === 0);

  // ===== 2. Ranqueia por impacto financeiro (mesma unidade) =====
  pub(orgA, { domain: "finance", signalType: "receivable_overdue", severity: "attention", basis: "fact", confidence: 0.9, impactAmount: 4200, impactUnit: "BRL", dedupeKey: "f:receivable" });
  pub(orgA, { domain: "finance", signalType: "payable_due_soon", severity: "attention", basis: "estimate", confidence: 0.7, impactAmount: 800, impactUnit: "BRL", dedupeKey: "f:payable" });
  pub(orgA, { domain: "tasks", signalType: "data_quality_low", severity: "info", basis: "estimate", confidence: 0.5, impactUnit: "score", dedupeKey: "t:dq" });
  const r1 = P.prioritize(orgA);
  check("no máximo 3 prioridades globais", r1.global.length <= 3);
  check("maior impacto financeiro fica em 1º (receivable 4200)", r1.global[0].signalType === "receivable_overdue" && r1.global[0].rank === 1);
  check("prioridade traz score e componentes", typeof r1.global[0].score === "number" && r1.global[0].components.normalizedImpact === 1);
  check("prioridade explica o ranking (reason)", typeof r1.global[0].reason === "string" && r1.global[0].reason.length > 0);
  check("saída §9.3: ação recomendada + como medir + aprovação", !!r1.global[0].recommendedAction && !!r1.global[0].howMeasured && r1.global[0].approvalNeeded?.policy === "single");

  // ===== 3. Determinístico: mesmo input → mesmo ranking =====
  const a = P.prioritize(orgA).global.map((p: any) => p.signalId).join(",");
  const b = P.prioritize(orgA).global.map((p: any) => p.signalId).join(",");
  check("ranking é reproduzível (sem LLM)", a === b && a.length > 0);

  // ===== 4. Crítico de segurança/compliance ultrapassa o financeiro =====
  pub(orgA, { domain: "security", signalType: "breach_suspected", severity: "critical", basis: "fact", confidence: 0.8, dedupeKey: "sec:breach" });
  const r2 = P.prioritize(orgA);
  check("evento crítico de segurança vai para o topo", r2.global[0].domain === "security" && r2.global[0].override === true);
  // O override rankeia ACIMA do financeiro mesmo tendo score menor (é o objetivo da regra).
  const secTop = r2.global[0];
  const recv2 = r2.global.find((p: any) => p.signalType === "receivable_overdue");
  check("override supera o financeiro mesmo com score menor", !!recv2 && secTop.rank < recv2.rank && secTop.score <= recv2.score);

  // ===== 5. Agrupamento de sinais do mesmo tipo/evento =====
  const orgC = mkOrg();
  pub(orgC, { domain: "inventory", signalType: "stockout_risk", severity: "risk", basis: "estimate", confidence: 0.7, impactAmount: 500, impactUnit: "BRL", dedupeKey: "inv:a" });
  pub(orgC, { domain: "inventory", signalType: "stockout_risk", severity: "risk", basis: "estimate", confidence: 0.7, impactAmount: 900, impactUnit: "BRL", dedupeKey: "inv:b" });
  const rc = P.prioritize(orgC);
  const invPriorities = rc.global.filter((p: any) => p.signalType === "stockout_risk");
  check("sinais do mesmo tipo agrupam em 1 prioridade", invPriorities.length === 1 && invPriorities[0].groupedCount === 2);
  check("o grupo mantém o de maior score (impacto 900)", invPriorities[0].impact.amount === 900);

  // ===== 6. Até 3 por domínio =====
  const orgD = mkOrg();
  for (let i = 0; i < 5; i++) pub(orgD, { domain: "sales", signalType: `opp_${i}`, severity: "attention", basis: "estimate", confidence: 0.6, impactAmount: 100 * (i + 1), impactUnit: "BRL", dedupeKey: `s:${i}` });
  const rd = P.prioritize(orgD);
  check("byDomain limita a 3 por domínio", rd.byDomain.sales.length === 3);
  check("byDomain ordena por score (maior impacto 1º)", rd.byDomain.sales[0].impact.amount === 500);

  // ===== 7. Isolamento por organização =====
  check("isolamento: org sem sinais não vê os de outra", P.prioritize(mkOrg()).global.length === 0);

  console.log("\n=== TEST: Impact Prioritization / Pareto (ADR-136 C3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Impact Prioritization OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
