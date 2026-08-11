/**
 * TEST — PRD 4 F7 (Planner): objetivo + capabilities → ExecutionPlan. DB-backed,
 * isolado por tmpDir. Determinístico. Prova:
 *
 *   PURO (skillosModel): maxRisk/deepestProfile agregam; validatePlanDeps pega dep
 *     inexistente e ciclo; topoSortSteps respeita dependências.
 *   PLANNER (SkillOsPlannerService.plan): resolve cada capability via Resolver (F3);
 *     plano ready quando tudo resolve + deps OK; blocked com unresolvedCapabilities
 *     (§65 sem silêncio) e/ou issues de dependência; agrega risco/perfil de contexto;
 *     correlationId presente (ADR-158); NÃO executa (§12).
 *   BRIDGE: toPlaybook projeta na forma do ProcessRuntime/PlaybookEngine (reuso F8).
 *   ISOLAMENTO: catálogo de plataforma, gate por tenant no Resolver.
 *
 * Uso: npm run test:skillos-planner
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-plan-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-plan-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SkillOsRegistryService: REG } = await import("../src/server/SkillOsRegistryService.js");
  const { SkillOsPlannerService: PLN } = await import("../src/server/SkillOsPlannerService.js");
  const M = await import("../src/server/skillosModel.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const user = { userId: randomUUID(), role: "owner" };

  // ═══════════════ 0. primitivas puras ═══════════════
  check("0.1 maxRisk agrega", M.maxRisk(["low", "high", "medium"]) === "high" && M.maxRisk([null, undefined]) === "low");
  check("0.2 deepestProfile agrega", M.deepestProfile(["minimal", "deep", "standard"]) === "deep" && M.deepestProfile([null]) === "minimal");
  check("0.3 validatePlanDeps: dep inexistente", M.validatePlanDeps([{ stepId: "s1", dependsOn: ["s9"] }]).some((i: string) => i.includes("inexistente")));
  check("0.4 validatePlanDeps: ciclo", M.validatePlanDeps([{ stepId: "a", dependsOn: ["b"] }, { stepId: "b", dependsOn: ["a"] }]).some((i: string) => i.includes("ciclo")));
  check("0.5 validatePlanDeps: DAG válido → sem issues", M.validatePlanDeps([{ stepId: "a", dependsOn: [] }, { stepId: "b", dependsOn: ["a"] }]).length === 0);
  const topo = M.topoSortSteps([{ stepId: "b", dependsOn: ["a"] }, { stepId: "a", dependsOn: [] }]);
  check("0.6 topoSortSteps: dep antes do dependente", topo[0].stepId === "a" && topo[1].stepId === "b");

  // ═══════════════ setup catálogo ═══════════════
  const cap = (id: string) => REG.registerCapability({ capabilityId: id, version: 1, name: id, category: "x", riskLevel: "low", status: "active" } as any);
  const skill = (id: string, capId: string, over: any = {}) => REG.registerSkill({ skillId: id, version: 1, capabilityId: capId, riskLevel: "low", status: "active", allowedTools: ["x"], supportsFallback: false, ...over } as any);
  cap("find_customers"); skill("find_customers_v1", "find_customers", { budgetClass: "free" });
  cap("gen_message"); skill("gen_message_v1", "gen_message", { riskLevel: "medium", requiredContextProfile: "deep", budgetClass: "standard", modelRequirements: { needs: ["structured_output"] } });
  cap("no_skill_cap"); // capability sem skill

  // ═══════════════ 1. plano ready ═══════════════
  const p1 = PLN.plan(org, user, { goal: "Recuperar vendas", intent: "recover", steps: [{ capabilityId: "find_customers" }, { capabilityId: "gen_message", dependsOn: ["find_customers"] }] });
  check("1.1 status ready (tudo resolveu)", p1.status === "ready" && p1.unresolvedCapabilities.length === 0 && p1.issues.length === 0);
  check("1.2 cada passo resolveu numa skill (F3)", p1.steps[0].resolvedSkillId === "find_customers_v1" && p1.steps[1].resolvedSkillId === "gen_message_v1");
  check("1.3 deps normalizadas p/ stepId", p1.steps[1].dependsOn[0] === "s1");
  check("1.4 agrega risco (max=medium) e perfil (deep)", p1.riskLevel === "medium" && p1.requiredContextProfile === "deep");
  check("1.5 correlationId presente (ADR-158)", typeof p1.correlationId === "string" && p1.correlationId.length > 0);

  // ═══════════════ 2. plano blocked (capability sem skill) — §65 ═══════════════
  const p2 = PLN.plan(org, user, { goal: "X", steps: [{ capabilityId: "find_customers" }, { capabilityId: "no_skill_cap" }] });
  check("2.1 status blocked + unresolvedCapabilities (sem silêncio)", p2.status === "blocked" && p2.unresolvedCapabilities.includes("no_skill_cap"));
  check("2.2 o passo unresolved carrega razão", p2.steps[1].resolution === "unresolved" && p2.steps[1].reason.length > 0);
  const p3 = PLN.plan(org, user, { goal: "X", steps: [{ capabilityId: "cap_inexistente" }] });
  check("2.3 capability fora do catálogo → blocked", p3.status === "blocked" && p3.steps[0].resolution === "unresolved");

  // ═══════════════ 3. deps inválidas → blocked ═══════════════
  const p4 = PLN.plan(org, user, { goal: "X", steps: [{ capabilityId: "find_customers", stepId: "a", dependsOn: ["b"] }, { capabilityId: "gen_message", stepId: "b", dependsOn: ["a"] }] });
  check("3.1 ciclo de dependência → blocked + issue", p4.status === "blocked" && p4.issues.some((i: string) => i.includes("ciclo")));

  // ═══════════════ 4. NÃO executa (§12) — só planeja ═══════════════
  // (não há efeito externo observável; garantimos que nenhuma AI Run foi criada.)
  const runs = (db.prepare("SELECT COUNT(*) c FROM ai_usage_log WHERE organization_id = ? AND run_id IS NOT NULL").get(org) as any).c;
  check("4.1 planejar não gerou nenhuma execução (AI Run)", runs === 0);

  // ═══════════════ 5. bridge toPlaybook (reuso F8) ═══════════════
  const pb = PLN.toPlaybook(p1);
  check("5.1 projeta startStep + steps na forma do PlaybookEngine", pb.startStep === "s1" && pb.steps.length === 2);
  check("5.2 commandType = skillos:{skillId} + encadeamento next", pb.steps[0].commandType === "skillos:find_customers_v1" && pb.steps[0].next === "s2" && pb.steps[1].next === "$end");

  console.log("\n=== TEST: SkillOS Planner (PRD 4 F7) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Planner (F7) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
