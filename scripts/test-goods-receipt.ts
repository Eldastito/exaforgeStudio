/**
 * TEST — Goods Receipt / recebimento de compras (Epic 5 — E5.2).
 * Completo/parcial/divergência/avaria/nota ausente; estoque só do confirmado
 * bom; parcial não encerra saldo; divergência gera sinal+tarefa. Determinístico.
 *
 * Uso: npm run test:goods-receipt
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-gr-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-gr-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SupplierQuoteService: Q } = await import("../src/server/SupplierQuoteService.js");
  const { PurchaseOrderService: PO } = await import("../src/server/PurchaseOrderService.js");
  const { GoodsReceiptService: GR } = await import("../src/server/GoodsReceiptService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), id); return id; };
  const stockOf = (org: string, pid: string) => { const r = db.prepare("SELECT quantity_available q FROM inventory_items WHERE organization_id = ? AND product_service_id = ?").get(org, pid) as any; return r ? Number(r.q) : 0; };
  const signalCount = (org: string, type: string) => (db.prepare("SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND signal_type = ?").get(org, type) as any).n;
  const taskCount = (org: string) => (db.prepare("SELECT COUNT(*) n FROM tasks WHERE organization_id = ?").get(org) as any).n;

  // Helper: monta uma ordem aceita com N itens {pid, ordered, unit}.
  const mkOrder = (org: string, items: { pid: string; qty: number; unit: number }[]) => {
    const reqId = randomUUID();
    db.prepare("INSERT INTO purchase_requisitions (id, organization_id, status) VALUES (?, ?, 'approved')").run(reqId, org);
    const supId = randomUUID();
    db.prepare("INSERT INTO contacts (id, organization_id, channel_id, identifier, name, is_supplier) VALUES (?, ?, 'ch', '551199', 'Fornecedor', 1)").run(supId, org);
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
  const cafe = randomUUID(), acucar = randomUUID();
  const order = mkOrder(orgA, [{ pid: cafe, qty: 10, unit: 10 }, { pid: acucar, qty: 10, unit: 5 }]);
  const cafeItem = order.items.find((i: any) => i.product_service_id === cafe);
  const acucarItem = order.items.find((i: any) => i.product_service_id === acucar);

  // ===== 1. Recebimento PARCIAL (Café 6 ok) + AVARIA (Açúcar 3 damaged) =====
  const r1 = GR.receive(orgA, order.id, { items: [
    { purchaseOrderItemId: cafeItem.id, receivedQty: 6, condition: "ok" },
    { purchaseOrderItemId: acucarItem.id, receivedQty: 3, condition: "damaged" },
  ] }, "user-1");
  check("Café: 6 confirmados entram no estoque", stockOf(orgA, cafe) === 6);
  check("Açúcar avariado NÃO entra no estoque", stockOf(orgA, acucar) === 0);
  check("ordem fica 'receiving' (parcial)", r1.poStatus === "receiving");
  check("recebimento reporta a divergência de avaria", r1.divergences.length === 1 && r1.divergences[0].divergence === "damaged");
  check("divergência gera SINAL (não baixa silenciosa)", signalCount(orgA, "goods_receipt_divergence") === 1);
  check("divergência gera TAREFA", taskCount(orgA) === 1);

  // saldo pendente preservado (parcial não encerra): Café pendente 4, Açúcar 10.
  const afterR1 = PO.get(orgA, order.id);
  check("parcial não encerra saldo: Café received_qty=6", afterR1.items.find((i: any) => i.product_service_id === cafe).received_qty === 6);
  check("avaria não conta como recebido: Açúcar received_qty=0", afterR1.items.find((i: any) => i.product_service_id === acucar).received_qty === 0);

  // ===== 2. Completa o restante (Café 4, Açúcar 10) → ordem 'received' =====
  const r2 = GR.receive(orgA, order.id, { items: [
    { purchaseOrderItemId: cafeItem.id, receivedQty: 4, condition: "ok" },
    { purchaseOrderItemId: acucarItem.id, receivedQty: 10, condition: "ok" },
  ] }, "user-1");
  check("Café estoque acumulado 10", stockOf(orgA, cafe) === 10);
  check("Açúcar estoque 10", stockOf(orgA, acucar) === 10);
  check("ordem completa vira 'received'", r2.poStatus === "received");
  check("recebimento que fecha a ordem é 'complete'", GR.get(orgA, r2.receiptId).kind === "complete");
  check("sem nova divergência no recebimento bom", r2.divergences.length === 0);

  // ===== 3. Ordem finalizada não recebe mais =====
  let threwFinal = false;
  try { GR.receive(orgA, order.id, { items: [{ purchaseOrderItemId: cafeItem.id, receivedQty: 1 }] }); } catch { threwFinal = true; }
  check("ordem 'received' não aceita novo recebimento", threwFinal);

  // ===== 4. Entrega A MAIS = divergência 'over' (mas entra no estoque) =====
  const orgB = mkOrg();
  const p = randomUUID();
  const o2 = mkOrder(orgB, [{ pid: p, qty: 5, unit: 2 }]);
  const r3 = GR.receive(orgB, o2.id, { items: [{ purchaseOrderItemId: o2.items[0].id, receivedQty: 7, condition: "ok" }] });
  check("entrega a mais é divergência 'over'", r3.divergences.length === 1 && r3.divergences[0].divergence === "over");
  check("entrega a mais entra no estoque (7)", stockOf(orgB, p) === 7);

  // ===== 5. Nota ausente gera sinal + tarefa =====
  const orgC = mkOrg();
  const p2 = randomUUID();
  const o3 = mkOrder(orgC, [{ pid: p2, qty: 4, unit: 3 }]);
  GR.receive(orgC, o3.id, { invoicePresent: false, items: [{ purchaseOrderItemId: o3.items[0].id, receivedQty: 4, condition: "ok" }] });
  check("nota ausente gera sinal", signalCount(orgC, "goods_receipt_no_invoice") === 1);
  check("recebimento sem nota é marcado has_divergence", (db.prepare("SELECT has_divergence h FROM goods_receipts WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").get(orgC) as any).h === 1);

  // ===== 6. Isolamento por organização =====
  let threwIso = false;
  try { GR.receive(mkOrg(), order.id, { items: [{ purchaseOrderItemId: cafeItem.id, receivedQty: 1 }] }); } catch { threwIso = true; }
  check("isolamento: outra org não recebe a ordem de A", threwIso);

  console.log("\n=== TEST: Goods Receipt (Epic 5 — E5.2) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Goods Receipt OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
