/**
 * TEST — ADR-159 F3 (D4): Autonomy Contract — bandas valor→papel + 4 estados.
 *
 * Prova, determinístico:
 *   A) resolveContract devolve os 4 estados (allow/require_approval/escalate/deny)
 *      a partir de BANDAS (config_json.bands); ponte legada (max_auto_amount);
 *      default-deny p/ financeiro/destrutivo sem política (RN-159-1).
 *   B) setBands grava as bandas (upsert idempotente em config_json).
 *   C) propose IMPÕE o contrato quando há bandas (enforced): deny bloqueia, allow
 *      auto-aprova (policy none), require_approval/escalate exigem o papel da
 *      banda. Sem bandas → propose inalterado (0 regressão).
 *
 * Uso: npm run test:autonomy-contract
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-autonomy-contract-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-autonomy-contract-123456";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ApprovalPolicyService: P } = await import("../src/server/ApprovalPolicyService.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // ===== A) resolveContract — BANDAS =====
  P.setBands(orgA, "procurement", "create_purchase_order", [
    { upTo: 2000, state: "allow" },
    { upTo: 5000, state: "require_approval", role: "gerente" },
    { upTo: null, state: "escalate", role: "diretor" },
  ]);
  const c1 = P.resolveContract(orgA, { domain: "procurement", actionType: "create_purchase_order", amount: 1000 });
  check("banda: 1000 → allow (enforced)", c1.state === "allow" && c1.enforced === true);
  const c2 = P.resolveContract(orgA, { domain: "procurement", actionType: "create_purchase_order", amount: 3000 });
  check("banda: 3000 → require_approval + gerente", c2.state === "require_approval" && c2.requiredRole === "gerente");
  const c3 = P.resolveContract(orgA, { domain: "procurement", actionType: "create_purchase_order", amount: 9000 });
  check("banda: 9000 (teto) → escalate + diretor", c3.state === "escalate" && c3.requiredRole === "diretor");
  const cEdge = P.resolveContract(orgA, { domain: "procurement", actionType: "create_purchase_order", amount: 2000 });
  check("banda: limite inclusivo (2000 ≤ upTo=2000) → allow", cEdge.state === "allow");

  // ===== A') Ponte LEGADA (max_auto_amount, sem bandas) =====
  db.prepare(`INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, approval_role, max_auto_amount, active) VALUES (?, ?, 'sales', 'discount', 'execute', 'gerente', 500, 1)`).run(randomUUID(), orgA);
  const l1 = P.resolveContract(orgA, { domain: "sales", actionType: "discount", amount: 200 });
  check("legado: dentro do teto → allow (advisório)", l1.state === "allow" && l1.enforced === false);
  const l2 = P.resolveContract(orgA, { domain: "sales", actionType: "discount", amount: 900 });
  check("legado: acima do teto + papel → escalate (advisório)", l2.state === "escalate" && l2.requiredRole === "gerente" && l2.enforced === false);

  // ===== A'') Default-deny (RN-159-1) — sem política =====
  const dRefund = P.resolveContract(orgA, { domain: "finance", actionType: "refund", amount: 1000 });
  check("default-deny: refund sem política → deny (advisório)", dRefund.state === "deny" && dRefund.enforced === false);
  const dFinance = P.resolveContract(orgA, { domain: "finance", actionType: "qualquer", amount: 10 });
  check("default-deny: domínio finance sem política → deny", dFinance.state === "deny");
  const dSafe = P.resolveContract(orgA, { domain: "tasks", actionType: "create_task", amount: 0 });
  check("não-arriscado sem política → require_approval (não deny)", dSafe.state === "require_approval");

  // ===== B) setBands é idempotente e sobrescreve =====
  P.setBands(orgA, "procurement", "create_purchase_order", [{ upTo: null, state: "deny" }]);
  const cReset = P.resolveContract(orgA, { domain: "procurement", actionType: "create_purchase_order", amount: 100 });
  check("setBands sobrescreve as bandas anteriores", cReset.state === "deny");
  // restaura as bandas boas pro resto do teste
  P.setBands(orgA, "procurement", "create_purchase_order", [
    { upTo: 2000, state: "allow" },
    { upTo: 5000, state: "require_approval", role: "gerente" },
    { upTo: null, state: "escalate", role: "diretor" },
  ]);

  // ===== C) propose IMPÕE o contrato (bandas enforced) =====
  const mk = (amount: number) => D.propose(orgA, { domain: "procurement", actionType: "create_purchase_order", title: `Compra ${amount}`, expectedImpact: amount });
  const a1 = mk(1000);
  check("propose allow (1000): auto-aprovada (status approved, policy none)", a1.status === "approved" && a1.approval_policy === "none");
  const a2 = mk(3000);
  check("propose require_approval (3000): awaiting + policy role + gerente", a2.status === "awaiting_approval" && a2.approval_policy === "role" && a2.approval_role === "gerente");
  const a3 = mk(9000);
  check("propose escalate (9000): awaiting + policy role + diretor", a3.status === "awaiting_approval" && a3.approval_role === "diretor");

  // deny bloqueia a proposta
  P.setBands(orgA, "finance", "refund", [{ upTo: 500, state: "allow" }, { upTo: null, state: "deny" }]);
  const rOk = D.propose(orgA, { domain: "finance", actionType: "refund", title: "Estorno pequeno", expectedImpact: 100 });
  check("propose refund 100 (allow): aprovada", rOk.status === "approved");
  let denied = false;
  try { D.propose(orgA, { domain: "finance", actionType: "refund", title: "Estorno grande", expectedImpact: 5000 }); } catch { denied = true; }
  check("propose refund 5000 (deny): BLOQUEADA (lança)", denied);

  // ===== D) Sem bandas → propose inalterado (0 regressão) =====
  const orgB = mkOrg();
  const noband = D.propose(orgB, { domain: "procurement", actionType: "choose_supplier", title: "Fornecedor X", expectedImpact: 30000 });
  check("sem bandas: two_step da matriz padrão preservado", noband.approval_policy === "two_step" && noband.status === "awaiting_approval");
  const task = D.propose(orgB, { domain: "tasks", actionType: "create_task", title: "T" });
  check("sem bandas: create_task segue 'none' (auto)", task.approval_policy === "none" && task.status === "approved");

  // ===== E) Isolamento =====
  const cIso = P.resolveContract(orgB, { domain: "procurement", actionType: "create_purchase_order", amount: 1000 });
  check("isolamento: bandas de orgA não valem em orgB", cIso.enforced === false);

  console.log("\n=== TEST: Autonomy Contract (ADR-159 F3/D4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Autonomy Contract (F3) OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
