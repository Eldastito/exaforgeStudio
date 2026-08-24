/**
 * TEST — Sinal advisory de despesa não apropriada (ADR-185 F3). DB-backed, determinístico.
 * Prova: publica business_signal (cost_center/unallocated_expense) quando a maioria da despesa
 * está solta e material; hipótese + impactAmount null; nunca cria decision_action; só orgs com
 * centro ativo; self-healing (resolve ao apropriar, reopen ao recorrer); dedupe; pass(); isolamento.
 *
 * Uso: npm run test:cost-center-signal
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ccsig-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ccsig-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

const PERIOD = "2026-06";

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { CostCenterExpenseSignalService: SIG } = await import("../src/server/CostCenterExpenseSignalService.js");
  const { CostCenterService: CC } = await import("../src/server/CostCenterService.js");
  const { FinancialLedgerService: FIN } = await import("../src/server/FinancialLedgerService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`, C = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B, C]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);

  const loja = CC.create(A, { name: "Loja" });
  const sig = (org: string) => db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND domain='cost_center' AND dedupe_key=?`).get(org, `cc_unallocated:${PERIOD}`) as any;

  // A: despesa 1000, só 200 apropriada → 800 solto (80% > 50%, material) → publica.
  FIN.addPayable(A, { description: "Aluguel", amount: 800, dueDate: "2026-06-10" });                       // solto
  FIN.addPayable(A, { description: "Energia", amount: 200, dueDate: "2026-06-12", costCenterId: loja.id }); // apropriado
  const r1 = SIG.publishUnallocatedExpenseSignal(A, PERIOD);
  check("1.1 publicou sinal (maioria solta)", r1.published === true);
  const row = db.prepare(`SELECT basis, impact_amount, severity FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `cc_unallocated:${PERIOD}`) as any;
  check("1.2 hypothesis + impact null (não inventa)", row.basis === "hypothesis" && row.impact_amount == null);
  check("1.3 severity attention", row.severity === "attention");

  // 2. Nunca cria decision_action.
  check("2.1 zero decision_action", (db.prepare(`SELECT COUNT(*) n FROM decision_actions WHERE organization_id=?`).get(A) as any).n === 0);

  // 3. Dedupe: republicar não duplica.
  SIG.publishUnallocatedExpenseSignal(A, PERIOD);
  check("3.1 dedupe (1 linha)", (db.prepare(`SELECT COUNT(*) n FROM business_signals WHERE organization_id=? AND dedupe_key=?`).get(A, `cc_unallocated:${PERIOD}`) as any).n === 1);

  // 4. Self-healing: apropria as contas soltas → maioria deixa de estar solta → resolve.
  db.prepare(`UPDATE payables SET cost_center_id = ? WHERE organization_id = ? AND cost_center_id IS NULL`).run(loja.id, A);
  const r4 = SIG.publishUnallocatedExpenseSignal(A, PERIOD);
  check("4.1 apropriou → resolved", r4.published === false && sig(A)?.status === "resolved");

  // 5. Recorre: nova despesa solta grande (> total já apropriado) → maioria volta a estar solta → reabre.
  FIN.addPayable(A, { description: "Serviço", amount: 1200, dueDate: "2026-06-25" });
  const r5 = SIG.publishUnallocatedExpenseSignal(A, PERIOD);
  check("5.1 recorre → republica/reabre", r5.published === true && sig(A)?.status !== "resolved");

  // 6. Org SEM centro de custo (B) → nunca sinaliza (a dimensão não foi adotada).
  FIN.addPayable(B, { description: "Aluguel B", amount: 500, dueDate: "2026-06-10" });
  const rB = SIG.publishUnallocatedExpenseSignal(B, PERIOD);
  check("6.1 sem centro → não publica", rB.published === false && !sig(B));

  // 7. Valor solto pequeno (< floor) → não incomoda. C tem centro + só R$50 solto.
  CC.create(C, { name: "Único" });
  FIN.addPayable(C, { description: "Cafezinho", amount: 50, dueDate: "2026-06-10" });
  const rC = SIG.publishUnallocatedExpenseSignal(C, PERIOD);
  check("7.1 valor pequeno solto → não sinaliza", rC.published === false);

  // 8. pass(): roda pras orgs com centro; não quebra.
  SIG.pass();
  check("8.1 pass executa sem erro", true);

  // 9. Isolamento: sinal de A não aparece em B.
  check("9.1 B sem sinal (isolado)", !sig(B));

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} cost-center-signal: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
