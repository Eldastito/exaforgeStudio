/**
 * TEST — Decision & Action Ledger (ADR-136, Epic 2 — C2): ação → aprovação.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:decision-actions
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-actions-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-actions-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { DecisionActionService: D } = await import("../src/server/DecisionActionService.js");
  const { ApprovalPolicyService: P } = await import("../src/server/ApprovalPolicyService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // ===== 1. Política padrão por tipo (PRD §10.2) =====
  check("create_task = none (baixo risco)", P.resolve(orgA, { domain: "tasks", actionType: "create_task" }).policy === "none");
  check("collection = single", P.resolve(orgA, { domain: "finance", actionType: "collection" }).policy === "single");
  check("change_price = role owner", (() => { const r = P.resolve(orgA, { domain: "sales", actionType: "change_price" }); return r.policy === "role" && r.requiredRole === "owner"; })());
  check("choose_supplier = two_step", P.resolve(orgA, { domain: "procurement", actionType: "choose_supplier" }).policy === "two_step");

  // ===== 2. Propor: 'none' nasce aprovada; demais aguardam aprovação =====
  const t = D.propose(orgA, { domain: "tasks", actionType: "create_task", title: "Conferir estoque" });
  check("ação de baixo risco já nasce aprovada", t.status === "approved" && !!t.approved_at);
  const c = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Cobrar R$ 4.200 vencidos", expectedImpact: 4200, signalId: "sig-1" });
  check("cobrança nasce aguardando aprovação", c.status === "awaiting_approval" && c.approval_policy === "single");

  // ===== 3. Aprovar single =====
  const c2 = D.approve(orgA, c.id, "user-1", { reason: "ok, cobrar" });
  check("uma aprovação satisfaz 'single' → approved", c2.status === "approved" && (c2.approvals || []).length === 1);

  // ===== 4. two_step exige 2 aprovadores DISTINTOS =====
  const s = D.propose(orgA, { domain: "procurement", actionType: "choose_supplier", title: "Escolher fornecedor X", expectedImpact: 30000 });
  D.approve(orgA, s.id, "user-1");
  check("1ª aprovação (two_step) ainda aguarda", D.get(orgA, s.id).status === "awaiting_approval");
  D.approve(orgA, s.id, "user-1"); // mesmo aprovador não conta de novo
  check("mesmo aprovador não fecha o two_step", D.get(orgA, s.id).status === "awaiting_approval");
  const sDone = D.approve(orgA, s.id, "user-2");
  check("2º aprovador distinto fecha o two_step → approved", sDone.status === "approved");

  // ===== 5. Concluir só aprovada; result_amount registrado =====
  let threwComplete = false;
  try { D.complete(orgA, D.propose(orgA, { domain: "finance", actionType: "collection", title: "Y" }).id); } catch { threwComplete = true; }
  check("não conclui ação que não foi aprovada", threwComplete);
  const done = D.complete(orgA, c.id, { resultAmount: 3800 });
  check("conclui aprovada com resultado", done.status === "done" && done.result_amount === 3800 && !!done.completed_at);

  // ===== 6. Rejeitar / cancelar =====
  const r = D.propose(orgA, { domain: "finance", actionType: "collection", title: "Z" });
  check("rejeitar leva a 'rejected'", D.reject(orgA, r.id, "user-1", { reason: "não vale" }).status === "rejected");
  const k = D.propose(orgA, { domain: "finance", actionType: "collection", title: "W" });
  check("cancelar leva a 'cancelled'", D.cancel(orgA, k.id).status === "cancelled");

  // ===== 7. Política da organização sobrepõe o padrão =====
  db.prepare("INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, active) VALUES (?, ?, 'tasks', 'create_task', 'observe', 1)").run(randomUUID(), orgA);
  check("autonomia 'observe' eleva create_task de none → single", P.resolve(orgA, { domain: "tasks", actionType: "create_task" }).policy === "single");

  // ===== 8. Isolamento =====
  const orgB = mkOrg();
  check("isolamento: org B não vê ações de A", D.list(orgB).length === 0 && D.get(orgB, c.id) === null);

  console.log("\n=== TEST: Decision & Action Ledger (ADR-136 C2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Decision & Action Ledger OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
