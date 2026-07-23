/**
 * TEST — Purchase Payable / conta a pagar da compra (Epic 5 — E5.3).
 * Idempotente ("não é criada duas vezes"); valor pelo recebido; alimenta caixa.
 * Determinístico, sem chave de IA.
 *
 * Uso: npm run test:purchase-payable
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pay-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-pay-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SupplierQuoteService: Q } = await import("../src/server/SupplierQuoteService.js");
  const { PurchaseOrderService: PO } = await import("../src/server/PurchaseOrderService.js");
  const { GoodsReceiptService: GR } = await import("../src/server/GoodsReceiptService.js");
  const { PurchasePayableService: PP } = await import("../src/server/PurchasePayableService.js");
  const { FinancialLedgerService: FL } = await import("../src/server/FinancialLedgerService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), id); return id; };
  const mkOrder = (org: string, items: { pid: string; qty: number; unit: number }[]) => {
    const reqId = randomUUID();
    db.prepare("INSERT INTO purchase_requisitions (id, organization_id, status) VALUES (?, ?, 'approved')").run(reqId, org);
    const supId = randomUUID();
    db.prepare("INSERT INTO contacts (id, organization_id, channel_id, identifier, name, is_supplier) VALUES (?, ?, 'ch', '551199', 'Distribuidora Sol', 1)").run(supId, org);
    const quoteId = randomUUID();
    db.prepare("INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status) VALUES (?, ?, ?, ?, 'answered')").run(quoteId, org, reqId, supId);
    for (const it of items) {
      db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', ?)").run(it.pid, org, it.pid.slice(0, 6));
      db.prepare("INSERT INTO purchase_requisition_items (id, requisition_id, organization_id, product_service_id, suggested_qty) VALUES (?, ?, ?, ?, ?)").run(randomUUID(), reqId, org, it.pid, it.qty);
      db.prepare("INSERT INTO purchase_quote_items (id, quote_id, organization_id, product_service_id, product_name, unit_price, available_qty, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(randomUUID(), quoteId, org, it.pid, it.pid.slice(0, 6), it.unit, it.qty, it.unit * it.qty);
    }
    const acc = Q.accept(org, quoteId);
    return PO.get(org, acc.orderId!);
  };

  const orgA = mkOrg();
  const p1 = randomUUID(), p2 = randomUUID();
  const order = mkOrder(orgA, [{ pid: p1, qty: 10, unit: 10 }, { pid: p2, qty: 10, unit: 5 }]); // total pedido 150

  // ===== 1. Sem recebimento, base 'received' → nada a faturar =====
  const empty = PP.createFromOrder(orgA, order.id, { dueDate: "2026-08-30" });
  check("sem recebimento não gera conta (valor devido 0)", empty.ok === false && empty.id === null);

  // Recebe: p1 8 (ok), p2 10 (ok). Devido = 8×10 + 10×5 = 130.
  GR.receive(orgA, order.id, { items: [
    { purchaseOrderItemId: order.items.find((i: any) => i.product_service_id === p1).id, receivedQty: 8, condition: "ok" },
    { purchaseOrderItemId: order.items.find((i: any) => i.product_service_id === p2).id, receivedQty: 10, condition: "ok" },
  ] });

  // ===== 2. Conta a pagar pelo RECEBIDO (não pelo pedido) =====
  check("valor devido = recebido (130), não o pedido (150)", PP.amountDue(orgA, order.id, "received") === 130);
  const pay = PP.createFromOrder(orgA, order.id, { dueDate: "2026-08-30" });
  check("cria a conta a pagar com o valor recebido", pay.ok === true && pay.deduped === false && pay.amount === 130);
  const row = db.prepare("SELECT * FROM payables WHERE id = ?").get(pay.id!) as any;
  check("conta vinculada à ordem + categoria compras + fornecedor", row.source_purchase_order_id === order.id && row.category === "compras" && row.supplier_name === "Distribuidora Sol");

  // ===== 3. Aparece no caixa/DRE (a pagar) =====
  check("entra no 'a pagar' do FinancialLedger (130)", FL.summary(orgA).aPagar === 130);

  // ===== 4. Idempotência: não cria duas vezes =====
  const again = PP.createFromOrder(orgA, order.id, { dueDate: "2026-09-30" });
  check("segunda chamada devolve a MESMA conta (deduped)", again.deduped === true && again.id === pay.id);
  check("existe só 1 conta a pagar para a ordem", (db.prepare("SELECT COUNT(*) n FROM payables WHERE organization_id = ? AND source_purchase_order_id = ?").get(orgA, order.id) as any).n === 1);
  check("getByOrder encontra a conta", PP.getByOrder(orgA, order.id).id === pay.id);

  // ===== 5. Base 'ordered' usa o total do pedido =====
  const orgB = mkOrg();
  const p3 = randomUUID();
  const o2 = mkOrder(orgB, [{ pid: p3, qty: 4, unit: 25 }]); // total 100
  const byOrdered = PP.createFromOrder(orgB, o2.id, { dueDate: "2026-08-30", basis: "ordered" });
  check("base 'ordered' fatura o total do pedido (100)", byOrdered.ok === true && byOrdered.amount === 100);

  // ===== 6. Ordem inexistente / cancelada =====
  check("ordem inexistente não gera conta", PP.createFromOrder(orgA, "nao-existe", { dueDate: "2026-08-30" }).ok === false);

  // ===== 7. Isolamento por organização =====
  check("isolamento: org B não vê a conta da ordem de A", PP.getByOrder(orgB, order.id) === null);

  console.log("\n=== TEST: Purchase Payable (Epic 5 — E5.3) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Purchase Payable OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
