/**
 * TEST — PRD 4 F8 (Policy + Execution Bridge): skill/plano → execução GOVERNADA,
 * SEM bypass (ADR-159/§67). DB-backed, isolado por tmpDir. Determinístico. Prova:
 *
 *   - propose cria uma decision_action (reusa DecisionActionService + ApprovalPolicy);
 *     correlationId/commandType/payload propagados;
 *   - SEM BYPASS: execute de ação NÃO aprovada → bloqueado (G3); ação aprovada mas
 *     SEM agent_policies → bloqueado (política ausente/G1); a ponte não tem sink próprio;
 *   - CADEIA COMPLETA: propose → aprovar → agent_policies(execute/approved_execution) →
 *     execute → o handler registrado roda (efeito só pelo choke-point único);
 *   - proposePlanStep: plano ready + passo resolvido → propõe; plano blocked / passo
 *     unresolved → NÃO propõe (RN-BR-3);
 *   - ISOLAMENTO por org.
 *
 * Uso: npm run test:skillos-execution-bridge
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-skillos-br-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-skillos-br-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SkillOsExecutionBridge: BR } = await import("../src/server/SkillOsExecutionBridge.js");
  const { DecisionActionService: DA } = await import("../src/server/DecisionActionService.js");
  const { CommandExecutorService: CE } = await import("../src/server/CommandExecutorService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);

  // handler de teste: efeito registrado (sem efeito externo real) — prova que o
  // efeito só corre pelo choke-point.
  const calls: string[] = [];
  CE.registerHandler({
    key: "skillos_test",
    commandTypes: ["skillos_test_effect"],
    prepare: () => ({ ok: true, mode: "prepare", handler: "skillos_test", draft: {} } as any),
    execute: async (_o: string, a: any) => { calls.push(a.id); return { ok: true }; },
  } as any);

  const effect = { domain: "sales", actionType: "skillos_test_action", commandType: "skillos_test_effect", commandPayload: { x: 1 }, title: "Efeito de teste" };
  const approveFully = (actionId: string) => {
    // aprova com atores distintos até satisfazer a política (none/single/role/two_step).
    for (const actor of ["u-boss-1", "u-boss-2"]) {
      const a = DA.get(org, actionId);
      if (a.status === "approved") break;
      try { DA.approve(org, actionId, actor); } catch { /* já aprovado */ }
    }
    return DA.get(org, actionId);
  };
  const seedPolicy = (domain: string, actionType: string) =>
    db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, execution_mode, active) VALUES (?, ?, ?, ?, 'execute', 'approved_execution', 1)`).run(randomUUID(), org, domain, actionType);

  // ═══════════════ 1. propose reusa DecisionActionService ═══════════════
  const a1 = BR.propose(org, { ...effect, correlationId: "corr-1", createdBy: "skillos" });
  check("1.1 criou decision_action", !!a1?.id && a1.domain === "sales" && a1.action_type === "skillos_test_action");
  check("1.2 commandType/payload + correlationId propagados", a1.command_type === "skillos_test_effect" && a1.correlation_id === "corr-1");
  check("1.3 status conforme política (approved OU awaiting_approval)", ["approved", "awaiting_approval"].includes(a1.status));
  check("1.4 propose sem commandType é rejeitado", (() => { try { BR.propose(org, { ...effect, commandType: "" } as any); return false; } catch { return true; } })());

  // ═══════════════ 2. SEM BYPASS ═══════════════
  // 2a: ação aprovada MAS sem agent_policies → executor barra (G1 política ausente).
  approveFully(a1.id);
  let blockedNoPolicy = false;
  try { await BR.execute(org, a1.id); } catch { blockedNoPolicy = true; }
  check("2.1 aprovada sem agent_policies → execução BARRADA (guarda do choke-point)", blockedNoPolicy && calls.length === 0);
  // 2b: ação NÃO aprovada (rejeitada) → executor barra (G3/terminal).
  const a2 = BR.propose(org, { ...effect, createdBy: "skillos" });
  DA.reject(org, a2.id, "u-boss-1", { reason: "não" });
  let blockedRejected = false;
  try { await BR.execute(org, a2.id); } catch { blockedRejected = true; }
  check("2.2 ação rejeitada → execução BARRADA (não aprovada/terminal)", blockedRejected);

  // ═══════════════ 3. CADEIA COMPLETA (governada) ═══════════════
  seedPolicy("sales", "skillos_test_action");
  const a3 = BR.propose(org, { ...effect, correlationId: "corr-3", createdBy: "skillos" });
  approveFully(a3.id);
  check("3.1 ação aprovada", DA.get(org, a3.id).status === "approved");
  const before = calls.length;
  const exec = await BR.execute(org, a3.id);
  check("3.2 execute pelo choke-point → handler rodou (efeito só governado)", exec?.ok === true && calls.length === before + 1 && calls.includes(a3.id));
  check("3.3 a ponte é passthrough do CommandExecutorService (mesmo resultado)", exec.handler === "skillos_test");

  // ═══════════════ 4. proposePlanStep (F7 → F8) ═══════════════
  const readyStep: any = { stepId: "s1", capabilityId: "cap", dependsOn: [], resolvedSkillId: "sk1", resolution: "resolved", reason: "ok", riskLevel: "low", requiredContextProfile: "minimal" };
  const readyPlan: any = { planId: "p1", correlationId: "corr-plan", goal: "g", intent: null, steps: [readyStep], riskLevel: "low", requiredContextProfile: "minimal", status: "ready", unresolvedCapabilities: [], issues: [] };
  const fromStep = BR.proposePlanStep(org, "u-boss-1", readyPlan, readyStep, effect);
  check("4.1 plano ready + passo resolvido → propõe (correlationId do plano)", !!fromStep?.id && fromStep.correlation_id === "corr-plan");
  const blockedPlan = { ...readyPlan, status: "blocked" };
  check("4.2 plano blocked → NÃO propõe (RN-BR-3)", BR.proposePlanStep(org, "u-boss-1", blockedPlan as any, readyStep, effect) === null);
  const unresolvedStep = { ...readyStep, resolution: "unresolved", resolvedSkillId: null };
  check("4.3 passo unresolved → NÃO propõe", BR.proposePlanStep(org, "u-boss-1", readyPlan, unresolvedStep as any, effect) === null);

  // ═══════════════ 5. isolamento ═══════════════
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), org2);
  let crossBlocked = false;
  try { await BR.execute(org2, a3.id); } catch { crossBlocked = true; }
  check("5.1 execute de ação de outro tenant → barrado (ação não encontrada)", crossBlocked);

  console.log("\n=== TEST: SkillOS Execution Bridge (PRD 4 F8) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ SkillOS Execution Bridge (F8) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
