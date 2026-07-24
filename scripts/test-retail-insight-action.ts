/**
 * TESTE — Ação executável a partir do insight (kernel C2, ADR-136).
 *
 * Prova o "Agir" da tela de Insights: um sinal de varejo vira uma AÇÃO
 * (decision_action) com a política de aprovação, e o ciclo fecha em concluir →
 * medir (Impact Ledger).
 *
 * Uso:  npm run test:retail-insight-action
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-insight-action-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-insight-action-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { BusinessSignalService } = await import("../src/server/BusinessSignalService.js");
  const { ImpactPrioritizationService } = await import("../src/server/ImpactPrioritizationService.js");
  const { DecisionActionService } = await import("../src/server/DecisionActionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  // Um sinal de ruptura ativa (como o publicador criaria).
  const pub = BusinessSignalService.publish(A, {
    domain: "inventory", signalType: "retail_store_stockout", severity: "risk", basis: "fact", confidence: 1,
    impactAmount: 3, impactUnit: "units", sourceService: "RetailOpsSignalPublisher",
    evidence: { store: "Loja 1", alerts: 3 }, dedupeKey: "retail_ops:stockout:s1",
  });

  // actionFor mapeia o tipo → ação recomendada.
  const action = ImpactPrioritizationService.actionFor("retail_store_stockout");
  check("actionFor: sinal de ruptura → repor estoque", action.actionType === "create_task" && /estoque/i.test(action.label), JSON.stringify(action));
  check("actionFor: tipo desconhecido → default", ImpactPrioritizationService.actionFor("xpto").label === "Registrar e acompanhar");

  // Propor a ação a partir do sinal (o que a rota /insights/act faz).
  let act = DecisionActionService.propose(A, {
    signalId: pub.id, domain: "inventory", actionType: action.actionType, title: action.label,
    expectedImpact: 3, impactUnit: "units", basis: "fact", confidence: 1, createdBy: "u1",
  });
  check("ação criada a partir do sinal", !!act.id && act.signal_id === pub.id && act.action_type === "create_task", JSON.stringify({ id: act.id, s: act.signal_id, t: act.action_type }));
  check("status inicial coerente com a política", ["approved", "awaiting_approval"].includes(act.status), act.status);

  // Aprova (se preciso) e conclui com resultado → fecha no Impact Ledger.
  if (act.status === "awaiting_approval") act = DecisionActionService.approve(A, act.id, "u1");
  check("aprovada", DecisionActionService.get(A, act.id).status === "approved");
  const done = DecisionActionService.complete(A, act.id, { resultAmount: 5 });
  check("concluída (done) com resultado 5", done.status === "done" && Number(done.result_amount) === 5, JSON.stringify({ st: done.status, r: done.result_amount }));

  // Painel de ações do varejo (a query da rota /insights/actions).
  const panel = db.prepare(
    `SELECT a.id, a.status FROM decision_actions a JOIN business_signals s ON s.id = a.signal_id
      WHERE a.organization_id = ? AND s.source_service IN ('RetailOpsSignalPublisher','RetailPatternMemoryService')`
  ).all(A) as any[];
  check("painel lista a ação do insight", panel.length === 1 && panel[0].id === act.id && panel[0].status === "done", JSON.stringify(panel));

  // Isolamento.
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("isolamento: org B sem ações", DecisionActionService.list(B).length === 0);

  console.log("\n=== Ação executável a partir do insight (ADR-136 C2) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
