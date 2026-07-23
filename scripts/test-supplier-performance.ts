/**
 * TEST — Supplier Performance (Epic 5 — E5.4).
 * Preço × média, prazo prometido × realizado, completude, divergências, taxa
 * de resposta. Determinístico, sem chave de IA.
 *
 * Uso: npm run test:supplier-performance
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-perf-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-perf-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { SupplierQuoteService: Q } = await import("../src/server/SupplierQuoteService.js");
  const { PurchaseOrderService: PO } = await import("../src/server/PurchaseOrderService.js");
  const { GoodsReceiptService: GR } = await import("../src/server/GoodsReceiptService.js");
  const { SupplierPerformanceService: SP } = await import("../src/server/SupplierPerformanceService.js");

  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Loja X', 'active')`).run(randomUUID(), id); return id; };
  const orgA = mkOrg();

  // 1 requisição, 1 produto (pedido 10).
  const reqId = randomUUID(); const p = randomUUID();
  db.prepare("INSERT INTO purchase_requisitions (id, organization_id, status) VALUES (?, ?, 'approved')").run(reqId, orgA);
  db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Café')").run(p, orgA);
  db.prepare("INSERT INTO purchase_requisition_items (id, requisition_id, organization_id, product_service_id, suggested_qty) VALUES (?, ?, ?, ?, 10)").run(randomUUID(), reqId, orgA, p);

  const mkSupplier = (name: string) => { const id = randomUUID(); db.prepare("INSERT INTO contacts (id, organization_id, channel_id, identifier, name, is_supplier) VALUES (?, ?, 'ch', ?, ?, 1)").run(id, orgA, "55" + name, name); return id; };
  const supA = mkSupplier("Alfa"), supB = mkSupplier("Beta"), supC = mkSupplier("Gama");

  const mkQuote = (sup: string, opts: { total?: number | null; days?: number | null; status: string; answered: boolean; unit?: number }) => {
    const qid = randomUUID();
    db.prepare("INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status, delivery_days, total_amount, answered_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(qid, orgA, reqId, sup, opts.status, opts.days ?? null, opts.total ?? null, opts.answered ? "2026-07-01 10:00:00" : null);
    if (opts.unit != null) db.prepare("INSERT INTO purchase_quote_items (id, quote_id, organization_id, product_service_id, product_name, unit_price, available_qty, line_total) VALUES (?, ?, ?, ?, 'Café', ?, 10, ?)").run(randomUUID(), qid, orgA, p, opts.unit, opts.unit * 10);
    return qid;
  };
  // Alfa: 100 (barato), 5 dias. Beta: 120, 3 dias. Gama: só enviada (nunca respondeu).
  const qA = mkQuote(supA, { total: 100, days: 5, status: "answered", answered: true, unit: 10 });
  mkQuote(supB, { total: 120, days: 3, status: "answered", answered: true, unit: 12 });
  mkQuote(supC, { status: "sent", answered: false });

  // Aceita Alfa → gera ordem; recebe tudo; fixa datas p/ prazo realizado = 7 dias.
  const acc = Q.accept(orgA, qA);
  const order = PO.get(orgA, acc.orderId!);
  GR.receive(orgA, order.id, { items: [{ purchaseOrderItemId: order.items[0].id, receivedQty: 10, condition: "ok" }] });
  db.prepare("UPDATE purchase_orders SET created_at = '2026-07-01 00:00:00', received_at = '2026-07-08 00:00:00' WHERE id = ?").run(order.id);

  // ===== Alfa (vencedor) =====
  const a = SP.metricsFor(orgA, { contactId: supA });
  check("Alfa: taxa de resposta 100% (respondeu e ganhou)", a.quotes.responseRate === 100 && a.quotes.won === 1);
  check("Alfa: preço escolhido 100 vs média 110", a.price.chosen === 100 && a.price.avgOfQuotes === 110);
  check("Alfa: preço 90.9% da média (mais barato)", a.price.priceVsAvgPct === 90.9);
  check("Alfa: economia vs média = 10", a.price.savingsVsAvg === 10);
  check("Alfa: prazo prometido 5 × realizado 7", a.delivery.promisedAvgDays === 5 && a.delivery.realizedAvgDays === 7);
  check("Alfa: entregou ATRASADO (onTime=false)", a.delivery.onTime === false);
  check("Alfa: completude 100% (10/10)", a.fulfillment.completenessPct === 100 && a.fulfillment.receivedQty === 10);
  check("Alfa: sem divergências", a.divergences === 0);

  // ===== Beta (respondeu, perdeu) =====
  const b = SP.metricsFor(orgA, { contactId: supB });
  check("Beta: respondeu (100%) mas não ganhou (won=0)", b.quotes.responseRate === 100 && b.quotes.won === 0);
  check("Beta: sem ordem → prazo/completude nulos", b.delivery.measuredOrders === 0 && b.fulfillment.completenessPct === null);

  // ===== Gama (nunca respondeu; auto-rejeitada no aceite) =====
  const c = SP.metricsFor(orgA, { contactId: supC });
  check("Gama: taxa de resposta 0% (enviada, nunca respondeu)", c.quotes.responseRate === 0 && c.quotes.answered === 0);

  // ===== Divergência conta =====
  // Nova requisição/ordem p/ Alfa com avaria no recebimento.
  const req2 = randomUUID(); const p2 = randomUUID();
  db.prepare("INSERT INTO purchase_requisitions (id, organization_id, status) VALUES (?, ?, 'approved')").run(req2, orgA);
  db.prepare("INSERT INTO products_services (id, organization_id, type, name) VALUES (?, ?, 'product', 'Chá')").run(p2, orgA);
  db.prepare("INSERT INTO purchase_requisition_items (id, requisition_id, organization_id, product_service_id, suggested_qty) VALUES (?, ?, ?, ?, 5)").run(randomUUID(), req2, orgA, p2);
  const q2 = randomUUID();
  db.prepare("INSERT INTO purchase_quotes (id, organization_id, requisition_id, supplier_contact_id, status, delivery_days, total_amount, answered_at) VALUES (?, ?, ?, ?, 'answered', 2, 50, '2026-07-01')").run(q2, orgA, req2, supA);
  db.prepare("INSERT INTO purchase_quote_items (id, quote_id, organization_id, product_service_id, product_name, unit_price, available_qty, line_total) VALUES (?, ?, ?, ?, 'Chá', 10, 5, 50)").run(randomUUID(), q2, orgA, p2);
  const acc2 = Q.accept(orgA, q2);
  const order2 = PO.get(orgA, acc2.orderId!);
  GR.receive(orgA, order2.id, { items: [{ purchaseOrderItemId: order2.items[0].id, receivedQty: 5, condition: "damaged" }] });
  const a2 = SP.metricsFor(orgA, { contactId: supA });
  check("Alfa: divergência de avaria é contada", a2.divergences === 1);
  check("Alfa: completude cai (10/15) com a avaria não recebida", a2.fulfillment.orderedQty === 15 && a2.fulfillment.receivedQty === 10);

  // ===== Ranking + snapshot =====
  const ranking = SP.ranking(orgA);
  check("ranking cobre os 3 fornecedores", ranking.length === 3);
  check("ranking traz nome do fornecedor", ranking.some((r: any) => r.supplierName === "Alfa"));
  const n = SP.snapshot(orgA, "all");
  check("snapshot persiste 1 linha por fornecedor", n === 3 && (db.prepare("SELECT COUNT(*) n FROM supplier_performance_snapshots WHERE organization_id = ?").get(orgA) as any).n === 3);
  const n2 = SP.snapshot(orgA, "all");
  check("snapshot é idempotente por período (upsert)", n2 === 3 && (db.prepare("SELECT COUNT(*) n FROM supplier_performance_snapshots WHERE organization_id = ?").get(orgA) as any).n === 3);

  // ===== Isolamento =====
  check("isolamento: outra org tem ranking vazio", SP.ranking(mkOrg()).length === 0);

  console.log("\n=== TEST: Supplier Performance (Epic 5 — E5.4) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Supplier Performance OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
