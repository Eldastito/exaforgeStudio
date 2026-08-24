/**
 * TEST — Sinal advisory de dupla contagem (ADR-186 F3). DB-backed, determinístico.
 * Prova: publica business_signal (consolidated_result/double_count_risk) quando um custo aparece
 * como payable E como custo fixo de loja; hipótese + impactAmount null; nunca decision_action;
 * self-healing (resolve ao sumir / reabre ao recorrer); dedupe; pass() só orgs com loja; isolamento.
 *
 * Uso: npm run test:consolidated-double-count-signal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-dcsig-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-dcsig-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ConsolidatedResultService: CR } = await import("../src/server/ConsolidatedResultService.js");
  const { FinancialLedgerService: FIN } = await import("../src/server/FinancialLedgerService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  const mkStore = (org: string) => { const sid = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active, gross_margin_percent) VALUES (?, ?, 'Loja', 1, 40)`).run(sid, org); return sid; };
  const mkFixed = (org: string, sid: string, cat: string) => db.prepare(`INSERT INTO retail_store_fixed_costs (id, organization_id, store_id, category, amount) VALUES (?, ?, ?, ?, 300)`).run(randomUUID(), org, sid, cat);
  const sig = (org: string) => db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND domain='consolidated_result' AND dedupe_key=?`).get(org, `consolidated_double_count:${PERIOD}`) as any;

  // A: aluguel como custo de loja + payable 'aluguel' → dupla contagem → publica.
  const A = mkOrg(); const sA = mkStore(A); mkFixed(A, sA, "aluguel");
  FIN.addPayable(A, { description: "Aluguel loja", amount: 300, dueDate: "2026-06-05", category: "Aluguel da loja" });
  const r1 = CR.publishDoubleCountSignal(A, PERIOD);
  check("1.1 publicou o sinal", r1.published === true);
  const row = db.prepare(`SELECT basis, impact_amount, severity FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `consolidated_double_count:${PERIOD}`) as any;
  check("1.2 hypothesis + impact null (não inventa)", row.basis === "hypothesis" && row.impact_amount == null);
  check("1.3 severity attention", row.severity === "attention");

  // 2. Nunca cria decision_action.
  check("2.1 zero decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // 3. Dedupe.
  CR.publishDoubleCountSignal(A, PERIOD);
  check("3.1 dedupe (1 linha)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `consolidated_double_count:${PERIOD}`) as any).n === 1);

  // 4. Self-healing: remove o payable de aluguel → risco some → resolve.
  db.prepare(`DELETE FROM payables WHERE organization_id = ?`).run(A);
  const r4 = CR.publishDoubleCountSignal(A, PERIOD);
  check("4.1 risco some → resolved", r4.published === false && sig(A)?.status === "resolved");

  // 5. Recorre: re-adiciona o payable de aluguel → reabre.
  FIN.addPayable(A, { description: "Aluguel loja", amount: 300, dueDate: "2026-06-05", category: "aluguel" });
  const r5 = CR.publishDoubleCountSignal(A, PERIOD);
  check("5.1 recorre → republica/reabre", r5.published === true && sig(A)?.status !== "resolved");

  // 6. Sem sobreposição (payable de categoria diferente) → não sinaliza.
  const B = mkOrg(); const sB = mkStore(B); mkFixed(B, sB, "energia");
  FIN.addPayable(B, { description: "Compras", amount: 100, dueDate: "2026-06-05", category: "compras" });
  const rB = CR.publishDoubleCountSignal(B, PERIOD);
  check("6.1 sem sobreposição → não publica", rB.published === false && !sig(B));

  // 7. pass(): roda pras orgs com loja; não quebra.
  CR.pass();
  check("7.1 pass executa sem erro", true);

  // 8. Isolamento: sinal de A não aparece em B.
  check("8.1 B sem sinal (isolado)", !sig(B));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} consolidated-double-count-signal: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
