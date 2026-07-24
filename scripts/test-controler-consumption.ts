/**
 * TESTE — CONTROLER Fatia 2: requisição interna governada + ledger de consumo
 * (PRD-E-007, §11/§14).
 *
 * Cobre o ciclo solicitar → aprovar (maker-checker) → retirar (debita o local +
 * registra consumo) → confirmar → devolver (credita + estorna), a atomicidade da
 * retirada (saldo insuficiente não muda nada), as médias/cobertura derivadas do
 * ledger e o ISOLAMENTO multi-tenant.
 *
 * Uso:  npm run test:controler-consumption
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-controler-consumo-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-controler-consumo-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
function throws(fn: () => any): boolean { try { fn(); return false; } catch { return true; } }
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { MaterialRequestService } = await import("../src/server/MaterialRequestService.js");
  const { ConsumptionLedgerService } = await import("../src/server/ConsumptionLedgerService.js");
  const { InventoryLocationService } = await import("../src/server/InventoryLocationService.js");
  const { CostCenterService } = await import("../src/server/CostCenterService.js");
  const { DepartmentService } = await import("../src/server/DepartmentService.js");
  const { OperationalItemService } = await import("../src/server/OperationalItemService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const [org, name] of [[A, "A"], [B, "B"]] as const) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, ?, 'active')`).run(randomUUID(), org, name);
  const u1 = randomUUID(), u2 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Solicitante', ?)`).run(u1, A, `s_${u1.slice(0, 6)}@x.com`);
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Gestor', ?)`).run(u2, A, `g_${u2.slice(0, 6)}@x.com`);
  const dept = DepartmentService.create(A, { name: "Administrativo" }, u2);
  const cc = CostCenterService.create(A, { name: "Escritório", departmentId: dept.id }, u2);
  const loc = InventoryLocationService.create(A, { name: "Almox", type: "almoxarifado" }, u2);
  const prod = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Papel A4', 20, 1)`).run(prod, A);
  OperationalItemService.classify(A, prod, { operationalItemType: "consumable", consumptionControlEnabled: true, defaultUom: "folha" }, u2);
  InventoryLocationService.receive(A, { locationId: loc.id, productId: prod, quantity: 100 }, u2);

  // ===== Criação + validação =====
  check("create sem itens rejeitado", throws(() => MaterialRequestService.create(A, { items: [] } as any)));
  check("create com quantidade 0 rejeitado", throws(() => MaterialRequestService.create(A, { items: [{ productId: prod, quantity: 0 }] })));
  check("create com produto de outra org rejeitado", throws(() => MaterialRequestService.create(A, { items: [{ productId: randomUUID(), quantity: 1 }] })));

  const req = MaterialRequestService.create(A, { requesterUserId: u1, departmentId: dept.id, costCenterId: cc.id, purpose: "Impressão de provas", items: [{ productId: prod, quantity: 30 }] }, u1);
  check("cria requisição pendente com item", req.status === "pending" && req.items.length === 1 && Number(req.items[0].qty_requested) === 30, JSON.stringify({ s: req.status }));
  const itemId = req.items[0].id;

  // ===== Aprovação com segregação de funções =====
  check("solicitante não aprova a própria requisição", throws(() => MaterialRequestService.approve(A, req.id, u1)));
  check("aprovar qtd acima da solicitada rejeitado", throws(() => MaterialRequestService.approve(A, req.id, u2, { items: [{ itemId, qtyApproved: 50 }] })));
  const approved = MaterialRequestService.approve(A, req.id, u2);
  check("aprovada por outro usuário", approved.status === "approved" && Number(approved.items[0].qty_approved) === 30 && approved.approved_by === u2);

  // ===== Retirada: debita o local + registra consumo =====
  check("retirada exige local", throws(() => MaterialRequestService.issue(A, req.id, u2, { fromLocationId: "" } as any)));
  const issued = MaterialRequestService.issue(A, req.id, u2, { fromLocationId: loc.id });
  check("retirada → status issued, qty_issued 30", issued.status === "issued" && Number(issued.items[0].qty_issued) === 30);
  check("retirada debitou o saldo do local (100→70)", InventoryLocationService.balanceOf(A, loc.id, prod) === 70);
  check("consumo bruto registrado = 30", ConsumptionLedgerService.netConsumption(A, prod) === 30);

  // ===== Confirmação + devolução parcial =====
  const ack = MaterialRequestService.acknowledge(A, req.id, u1);
  check("recebedor confirma", ack.status === "acknowledged");
  const ret1 = MaterialRequestService.returnItems(A, req.id, { items: [{ itemId, quantity: 10 }] }, u1);
  check("devolução credita de volta (70→80)", InventoryLocationService.balanceOf(A, loc.id, prod) === 80 && Number(ret1.items[0].qty_returned) === 10);
  check("consumo líquido = 20 (30 saída − 10 devolução)", ConsumptionLedgerService.netConsumption(A, prod) === 20);
  check("devolver acima do retirado rejeitado", throws(() => MaterialRequestService.returnItems(A, req.id, { items: [{ itemId, quantity: 999 }] })));

  // ===== Médias e cobertura derivadas do ledger =====
  const avg = ConsumptionLedgerService.dailyAverage(A, prod, { windowDays: 30 });
  check("média diária ≈ 20/30", near(avg.average, 20 / 30) && avg.net === 20);
  const cov = ConsumptionLedgerService.coverageDays(A, prod, 80, { windowDays: 30 });
  check("cobertura ≈ 80 / média", cov != null && near(cov, 80 / (20 / 30), 1));
  check("consumo por centro de custo agrega", ConsumptionLedgerService.byCostCenter(A).some((r: any) => r.cost_center_id === cc.id && Number(r.net) === 20));

  // ===== Devolução total → 'returned' e consumo líquido zera =====
  const ret2 = MaterialRequestService.returnItems(A, req.id, { items: [{ itemId, quantity: 20 }] }, u1);
  check("devolução total → status returned", ret2.status === "returned" && InventoryLocationService.balanceOf(A, loc.id, prod) === 100);
  check("consumo líquido zera após devolver tudo", ConsumptionLedgerService.netConsumption(A, prod) === 0);
  check("sem consumo → cobertura null (§14.5)", ConsumptionLedgerService.coverageDays(A, prod, 100) === null);

  // ===== Atomicidade da retirada: saldo insuficiente não muda nada =====
  const big = MaterialRequestService.create(A, { requesterUserId: u1, items: [{ productId: prod, quantity: 200 }] }, u1);
  MaterialRequestService.approve(A, big.id, u2);
  check("retirada com saldo insuficiente rejeitada", throws(() => MaterialRequestService.issue(A, big.id, u2, { fromLocationId: loc.id })));
  check("falha na retirada não altera saldo (segue 100)", InventoryLocationService.balanceOf(A, loc.id, prod) === 100);
  check("falha na retirada mantém status approved", MaterialRequestService.get(A, big.id).status === "approved");

  // ===== Ordem do ciclo + cancelamento =====
  check("não confirma antes de retirar", throws(() => MaterialRequestService.acknowledge(A, big.id)));
  const cancelled = MaterialRequestService.cancel(A, big.id, u2);
  check("cancela requisição aprovada (antes da retirada)", cancelled.status === "cancelled");

  // ===== Isolamento =====
  check("isolamento: org B não vê requisição de A", MaterialRequestService.get(B, req.id) === null);
  check("isolamento: org B não lista requisições de A", MaterialRequestService.list(B).length === 0);
  check("isolamento: criar em B com depto de A falha", throws(() => MaterialRequestService.create(B, { departmentId: dept.id, items: [{ productId: prod, quantity: 1 }] })));
  check("isolamento: consumo de A não aparece em B", ConsumptionLedgerService.netConsumption(B, prod) === 0);

  console.log("\n=== CONTROLER Fatia 2 — Requisição governada + consumo ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
