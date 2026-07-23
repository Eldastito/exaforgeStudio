/**
 * TEST — Purchase Orders / fechamento cotação→ordem (Epic 5 — E5.1).
 * Ordem imutável (snapshot), idempotência "1 cotação = 1 ordem". Determinístico.
 *
 * Uso: npm run test:purchase-orders
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-po-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-po-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SupplierQuoteService: Q } = await import("../src/server/SupplierQuoteService.js");
  const { PurchaseOrderService: PO } = await import("../src/server/PurchaseOrderService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // Requisição + itens (2 produtos: pedidos 10 e 5).
  const reqId = randomUUID();
  db.prepare("INSERT INTO purchase_requisitions (id, organization_id, status) VALUES (?, ?, 'approved')").run(reqId, orgA);
  const p1 = randomUUID(), p2 = randomUUID();
  db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Café')").run(p1, orgA);
  db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Açúcar')").run(p2, orgA);
  db.prepare("INSERT INTO purchase_requisition_items (id, requisition_id, organization_id, product_service_id, suggested_qty) VALUES (?, ?, ?, ?, 10)").run(randomUUID(), reqId, orgA, p1);
  db.prepare("INSERT INTO purchase_requisition_items (id, requisition_id, organization_id, product_service_id, suggested_qty) VALUES (?, ?, ?, ?, 5)").run(randomUUID(), reqId, orgA, p2);

  // Fornecedor + cotação respondida (Café: 12,50 / disp 8; Açúcar: 4,00 / disp 20).
  const supId = randomUUID();
  db.prepare("INSERT INTO contacts (id, organization_id, channel_id, identifier, name, is_supplier) VALUES (?, ?, 'ch-1', '5511999990000', 'Distribuidora Sol', 1)").run(supId, orgA);
  const quoteId = randomUUID();
  db.prepare("INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status, delivery_days, total_amount) VALUES (?, ?, ?, ?, 'answered', 3, 180)").run(quoteId, orgA, reqId, supId);
  db.prepare("INSERT INTO purchase_quote_items (id, quote_id, organization_id, product_service_id, product_name, unit_price, available_qty, line_total) VALUES (?, ?, ?, ?, 'Café', 12.5, 8, 100)").run(randomUUID(), quoteId, orgA, p1);
  db.prepare("INSERT INTO purchase_quote_items (id, quote_id, organization_id, product_service_id, product_name, unit_price, available_qty, line_total) VALUES (?, ?, ?, ?, 'Açúcar', 4, 20, 20)").run(randomUUID(), quoteId, orgA, p2);

  // ===== 1. Aceitar gera a ordem =====
  const acc = Q.accept(orgA, quoteId);
  check("accept devolve ok + orderId", acc.ok === true && !!acc.orderId);
  check("requisição vira 'ordered'", (db.prepare("SELECT status FROM purchase_requisitions WHERE id = ?").get(reqId) as any).status === "ordered");
  check("cotação vira 'accepted'", (db.prepare("SELECT status FROM purchase_quotes WHERE id = ?").get(quoteId) as any).status === "accepted");

  // ===== 2. Ordem é snapshot imutável dos itens =====
  const order = PO.get(orgA, acc.orderId!);
  check("ordem tem 2 itens", order.items.length === 2);
  const cafe = order.items.find((i: any) => i.product_name === "Café");
  const acucar = order.items.find((i: any) => i.product_name === "Açúcar");
  check("Café: qty = min(pedido 10, disp 8) = 8", cafe.ordered_qty === 8 && cafe.unit_price === 12.5);
  check("Açúcar: qty = min(pedido 5, disp 20) = 5", acucar.ordered_qty === 5 && acucar.unit_price === 4);
  check("total da ordem = 8×12,50 + 5×4 = 120", order.total_amount === 120);
  check("snapshot do fornecedor no cabeçalho", order.supplier_name === "Distribuidora Sol" && order.delivery_days === 3);
  check("received_qty começa em 0 (recebimento é fatia seguinte)", cafe.received_qty === 0);

  // ===== 3. Imutabilidade: alterar a cotação depois NÃO muda a ordem =====
  db.prepare("UPDATE purchase_quote_items SET unit_price = 99 WHERE quote_id = ? AND product_name = 'Café'").run(quoteId);
  const order2 = PO.get(orgA, acc.orderId!);
  check("preço da ordem permanece congelado (12,50)", order2.items.find((i: any) => i.product_name === "Café").unit_price === 12.5);

  // ===== 4. Idempotência: uma cotação aceita gera EXATAMENTE uma ordem =====
  const again = Q.accept(orgA, quoteId);
  check("aceitar de novo devolve a MESMA ordem", again.orderId === acc.orderId);
  const direct = PO.createFromQuote(orgA, quoteId);
  check("createFromQuote é idempotente (deduped)", direct.deduped === true && direct.id === acc.orderId);
  check("existe só 1 ordem para a requisição", PO.listByRequisition(orgA, reqId).length === 1);

  // ===== 5. Não cria ordem para cotação não aceita =====
  const otherQuote = randomUUID();
  db.prepare("INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status) VALUES (?, ?, ?, ?, 'sent')").run(otherQuote, orgA, reqId, supId);
  const noPo = PO.createFromQuote(orgA, otherQuote);
  check("cotação não aceita não gera ordem", noPo.ok === false && noPo.id === null);

  // ===== 6. Isolamento por organização =====
  const orgB = mkOrg();
  check("isolamento: org B não vê a ordem de A", PO.get(orgB, acc.orderId!) === null && PO.getByQuote(orgB, quoteId) === null);

  console.log("\n=== TEST: Purchase Orders (Epic 5 — E5.1) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Purchase Orders OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
