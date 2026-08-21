/**
 * TEST — Sinal advisory de base incoerente do resultado (ADR-184 F4). DB-backed, determinístico.
 * Prova: publishCostCoherenceSignal publica business_signal (pnl_cost/base_incoherent) quando
 * unknownCostRisk; hipótese + impactAmount null (nunca inventa); self-healing (resolve quando o
 * risco some, reopen quando recorre, respeita dismissed §65); dedupe por período; nunca cria
 * decision_action; pass() só orgs que venderam; isolamento.
 *
 * Uso: npm run test:pnl-cost-coherence-signal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlcohsig-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlcohsig-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { PnlCostReconciliationService: COST } = await import("../src/server/PnlCostReconciliationService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);

  const mkOrder = (org: string, cost: number) => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 200, '2026-06-10 10:00:00')`).run(oid, org);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', 200, 1, 200, ?)`).run(randomUUID(), oid, org, cost);
    return oid;
  };
  const sig = () => db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND domain='pnl_cost' AND dedupe_key=?`).get(A, `pnl_cost_coherence:${PERIOD}`) as any;

  // 1. Venda SEM custo → unknownCostRisk → publica sinal (hipótese, sem dinheiro).
  mkOrder(A, 0);
  const r1 = COST.publishCostCoherenceSignal(A, PERIOD);
  check("1.1 publicou o sinal", r1.published === true);
  const s = sig();
  check("1.2 sinal em business_signals (pnl_cost/base_incoherent)", !!s);
  const row = db.prepare(`SELECT basis, impact_amount, severity FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `pnl_cost_coherence:${PERIOD}`) as any;
  check("1.3 basis hypothesis + impact null (não inventa)", row.basis === "hypothesis" && row.impact_amount == null);
  check("1.4 severity attention", row.severity === "attention");

  // 2. Nunca cria decision_action.
  check("2.1 zero decision_action criada", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // 3. Dedupe: republicar não duplica (1 linha por período).
  COST.publishCostCoherenceSignal(A, PERIOD);
  check("3.1 dedupe por período (1 linha)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `pnl_cost_coherence:${PERIOD}`) as any).n === 1);

  // 4. Self-healing: cadastra custo → risco some → resolve.
  db.prepare(`UPDATE order_items SET unit_cost = 80 WHERE organization_id = ?`).run(A);
  const r4 = COST.publishCostCoherenceSignal(A, PERIOD);
  check("4.1 risco some → resolved", r4.published === false);
  check("4.2 sinal marcado resolved", sig()?.status === "resolved");

  // 5. Recorre: volta sem custo → reopen (respeita dismissed é do §65; aqui estava resolved auto).
  db.prepare(`UPDATE order_items SET unit_cost = 0 WHERE organization_id = ?`).run(A);
  const r5 = COST.publishCostCoherenceSignal(A, PERIOD);
  check("5.1 recorre → republica/reabre", r5.published === true && sig()?.status !== "resolved");

  // 6. pass(): só orgs que venderam no mês; B não vendeu → sem sinal.
  COST.pass();
  check("6.1 B (sem venda) não tem sinal", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND domain='pnl_cost'`).get(B));

  // 7. Isolamento: sinal de A não aparece em B.
  check("7.1 sinal só em A", !db.prepare(`SELECT 1 FROM business_signals WHERE organization_id=? AND domain='pnl_cost'`).get(B));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-cost-coherence-signal: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
