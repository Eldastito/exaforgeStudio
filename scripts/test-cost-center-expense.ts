/**
 * TEST — Apropriação de despesa a centro de custo (ADR-185 F1). DB-backed, determinístico.
 * Prova: addPayable aceita/valida costCenterId; setPayableCostCenter apropria/desapropria/valida;
 * expensesByCostCenter agrupa por centro com `unallocated` sempre visível, ordenado desc, honesto;
 * nunca inventa centro (RN-CC-1/2); isolamento.
 *
 * Uso: npm run test:cost-center-expense
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ccexp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-ccexp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FinancialLedgerService: FIN } = await import("../src/server/FinancialLedgerService.js");
  const { CostCenterService: CC } = await import("../src/server/CostCenterService.js");

  const A = `org_${randomUUID().slice(0, 8)}`, B = `org_${randomUUID().slice(0, 8)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o);

  const loja = CC.create(A, { name: "Loja Centro" });
  const admin = CC.create(A, { name: "Administrativo" });
  const inativo = CC.create(A, { name: "Extinto" }); CC.setActive(A, inativo.id, false);
  const ccB = CC.create(B, { name: "Loja B" });

  // 1. addPayable com centro válido → apropriada.
  const p1 = FIN.addPayable(A, { description: "Aluguel", amount: 500, dueDate: "2026-06-10", costCenterId: loja.id });
  check("1.1 addPayable com centro válido ok", p1.ok === true);
  check("1.2 payable gravado com cost_center_id", (db.prepare(`SELECT cost_center_id FROM payables WHERE id=?`).get((p1 as any).id) as any).cost_center_id === loja.id);

  // 2. addPayable com centro inválido / inativo / de outra org → recusa (RN-CC-2), não inventa.
  check("2.1 centro inexistente → invalid_cost_center", FIN.addPayable(A, { description: "x", amount: 10, dueDate: "2026-06-10", costCenterId: "nao_existe" }).ok === false);
  check("2.2 centro inativo → invalid_cost_center", (FIN.addPayable(A, { description: "x", amount: 10, dueDate: "2026-06-10", costCenterId: inativo.id }) as any).error === "invalid_cost_center");
  check("2.3 centro de OUTRA org → invalid (isolamento)", (FIN.addPayable(A, { description: "x", amount: 10, dueDate: "2026-06-10", costCenterId: ccB.id }) as any).error === "invalid_cost_center");

  // 3. addPayable SEM centro → ok, fica unallocated (RN-CC-1/3).
  const p3 = FIN.addPayable(A, { description: "Serviço avulso", amount: 120, dueDate: "2026-06-12" });
  check("3.1 sem centro ok", p3.ok === true);
  check("3.2 cost_center_id null (unallocated)", (db.prepare(`SELECT cost_center_id FROM payables WHERE id=?`).get((p3 as any).id) as any).cost_center_id === null);

  // 4. setPayableCostCenter apropria a conta antes solta; depois desapropria (null).
  const s1 = FIN.setPayableCostCenter(A, (p3 as any).id, admin.id);
  check("4.1 apropria conta solta", s1.ok === true && (db.prepare(`SELECT cost_center_id FROM payables WHERE id=?`).get((p3 as any).id) as any).cost_center_id === admin.id);
  const s2 = FIN.setPayableCostCenter(A, (p3 as any).id, null);
  check("4.2 desapropria (null) volta a unallocated", s2.ok === true && (db.prepare(`SELECT cost_center_id FROM payables WHERE id=?`).get((p3 as any).id) as any).cost_center_id === null);
  check("4.3 set com centro inválido → invalid_cost_center", (FIN.setPayableCostCenter(A, (p3 as any).id, inativo.id) as any).error === "invalid_cost_center");
  check("4.4 set em payable inexistente → not_found", (FIN.setPayableCostCenter(A, "nao_existe", admin.id) as any).error === "not_found");

  // 5. Mais contas p/ o relatório: loja +300, admin +200.
  FIN.addPayable(A, { description: "Energia", amount: 300, dueDate: "2026-06-20", costCenterId: loja.id });
  FIN.addPayable(A, { description: "Contador", amount: 200, dueDate: "2026-06-22", costCenterId: admin.id });

  const rep = FIN.expensesByCostCenter(A, { from: "2026-06-01", to: "2026-06-30" });
  check("5.1 loja soma 800 (aluguel 500 + energia 300)", rep.items.find((i) => i.costCenterId === loja.id)?.total === 800);
  check("5.2 admin soma 200", rep.items.find((i) => i.costCenterId === admin.id)?.total === 200);
  check("5.3 unallocated = 120 (serviço avulso solto)", rep.unallocated === 120);
  check("5.4 total = 1120 (apropriado + não apropriado)", rep.total === 1120);
  check("5.5 ordenado desc (loja antes de admin)", rep.items[0].costCenterId === loja.id);
  check("5.6 nome do centro presente", rep.items[0].name === "Loja Centro");

  // 6. honesto: período vazio → items [], unallocated 0, total 0.
  const empty = FIN.expensesByCostCenter(A, { from: "2019-01-01", to: "2019-01-31" });
  check("6.1 período vazio → zeros", empty.items.length === 0 && empty.unallocated === 0 && empty.total === 0);

  // 7. isolamento: relatório de B não vê despesa de A.
  const repB = FIN.expensesByCostCenter(B, { from: "2026-06-01", to: "2026-06-30" });
  check("7.1 B isolado (total 0)", repB.total === 0);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} cost-center-expense: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
