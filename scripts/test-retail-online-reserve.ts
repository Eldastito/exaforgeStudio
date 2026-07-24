/**
 * TESTE — Loja Virtual → PDV, Fase 0 (ADR-143): reserva e-commerce + baixa
 * pendente + reconciliação anti-clobber. Offline, sem Alterdata.
 *
 * Prova:
 *   - OFF (default): recordSale é no-op; pedido com store_id não é bloqueado;
 *   - ON: a loja virtual vende SÓ da reserva (sem oversell); cada venda vira
 *     baixa pendente; idempotente por pedido;
 *   - netStoreQty desconta as pendentes do saldo do ERP;
 *   - o Saldo sync (AlterdataStockMapper) NÃO apaga a venda online (anti-clobber);
 *   - confirmar a baixa (lançou no PDV) para de descontar;
 *   - OrdersService.createOrder com store_id registra a baixa e BLOQUEIA o oversell;
 *   - isolado por organização.
 *
 * Uso:  npm run test:retail-online-reserve
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-online-reserve-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-online-reserve-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { AlterdataStockMapper } = await import("../src/server/AlterdataStockMapper.js");
  const { RetailOnlineReserveService } = await import("../src/server/RetailOnlineReserveService.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Toulon 1079", code: "10" });
  const P = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled, external_ref) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0, 'SKU1')`).run(P, A);

  // ===== 1. OFF (default) — no-op e sem bloqueio =====
  const off = RetailOnlineReserveService.recordSale(A, { orderId: "o0", storeId: store.id, items: [{ productId: P, qty: 2 }] });
  check("OFF: recordSale é no-op", off.ok === true && off.skipped === true);
  const ord0 = OrdersService.createOrder(A, { items: [{ productId: P, name: "Camisa", unitPrice: 100, quantity: 2 }], storeId: store.id, autoClose: true });
  const ord0Row = db.prepare(`SELECT store_id FROM orders WHERE id=?`).get(ord0.id) as any;
  check("OFF: pedido criado com store_id (D2), sem bloqueio", !!ord0.id && ord0Row.store_id === store.id);

  // ===== 2. Liga + define a reserva e-commerce = 5 =====
  RetailOnlineReserveService.setEnabled(A, true);
  RetailOnlineReserveService.setReserve(A, store.id, P, null, 5);
  check("reserva definida: available = 5", RetailOnlineReserveService.available(A, store.id, P, null) === 5);

  // ===== 3. Venda online debita a reserva; vira baixa pendente =====
  const r1 = RetailOnlineReserveService.recordSale(A, { orderId: "order1", storeId: store.id, items: [{ productId: P, qty: 3 }] });
  check("venda online: registrada", r1.ok === true && r1.recorded === 1);
  check("available cai p/ 2; pendente = 3", RetailOnlineReserveService.available(A, store.id, P, null) === 2 && RetailOnlineReserveService.pendingQty(A, store.id, P, null) === 3);

  // ===== 4. Sem oversell: pedir 3 com só 2 disponíveis é BLOQUEADO =====
  const r2 = RetailOnlineReserveService.recordSale(A, { orderId: "order2", storeId: store.id, items: [{ productId: P, qty: 3 }] });
  check("oversell bloqueado (pediu 3, tinha 2)", r2.ok === false && r2.blocked?.[0]?.available === 2 && r2.blocked?.[0]?.requested === 3);

  // ===== 5. Vende os 2 restantes; idempotência =====
  const r3 = RetailOnlineReserveService.recordSale(A, { orderId: "order3", storeId: store.id, items: [{ productId: P, qty: 2 }] });
  check("vende os 2 restantes: available 0", r3.ok === true && RetailOnlineReserveService.available(A, store.id, P, null) === 0);
  const rDup = RetailOnlineReserveService.recordSale(A, { orderId: "order1", storeId: store.id, items: [{ productId: P, qty: 3 }] });
  check("idempotente: re-registrar order1 não duplica", rDup.deduped === true && RetailOnlineReserveService.pendingQty(A, store.id, P, null) === 5);

  // ===== 6. netStoreQty + reconciliação no sync (anti-clobber) =====
  check("netStoreQty: ERP 10 − pendente 5 = 5", RetailOnlineReserveService.netStoreQty(A, store.id, P, null, 10) === 5);
  AlterdataStockMapper.upsertSaldos(A, [{ filial: "10", produto: "SKU1", saldoAtual: 10 }]);
  const inv = RetailInventoryService.get(A, store.id, P, null);
  check("sync NÃO apaga a venda online: estoque loja = 5 (10−5)", inv && Number(inv.quantity_available) === 5, JSON.stringify(inv));

  // ===== 7. Confirmar a baixa (operador lançou no PDV) para de descontar =====
  const c = RetailOnlineReserveService.confirmByOrder(A, "order1");
  check("confirmar order1: 1 baixa confirmada", c.ok === true && c.confirmed === 1);
  check("pendente cai p/ 2 (order3)", RetailOnlineReserveService.pendingQty(A, store.id, P, null) === 2);
  AlterdataStockMapper.upsertSaldos(A, [{ filial: "10", produto: "SKU1", saldoAtual: 10 }]);
  const inv2 = RetailInventoryService.get(A, store.id, P, null);
  check("após confirmar: estoque loja = 8 (10−2)", inv2 && Number(inv2.quantity_available) === 8, JSON.stringify(inv2));

  // ===== 8. createOrder integra: registra baixa e BLOQUEIA oversell =====
  // available agora = reserva 5 − pendente 2 = 3.
  const ordX = OrdersService.createOrder(A, { items: [{ productId: P, name: "Camisa", unitPrice: 100, quantity: 3 }], storeId: store.id, autoClose: true });
  check("createOrder (qtd 3) ok; available 0", !!ordX.id && RetailOnlineReserveService.available(A, store.id, P, null) === 0);
  let threw = false;
  try { OrdersService.createOrder(A, { items: [{ productId: P, name: "Camisa", unitPrice: 100, quantity: 1 }], storeId: store.id, autoClose: true }); } catch { threw = true; }
  check("createOrder bloqueia oversell (throw)", threw === true);
  check("oversell não criou pendência (available segue 0)", RetailOnlineReserveService.available(A, store.id, P, null) === 0);

  // ===== 8b. Editor de reservas: nomes + disponível + remover =====
  const list = RetailOnlineReserveService.listReserves(A);
  check("listReserves traz nome do produto e 'available'", list.length === 1 && list[0].product_name === "Camisa" && typeof list[0].available === "number", JSON.stringify(list[0]));
  const rm = RetailOnlineReserveService.removeReserve(A, store.id, P, null);
  check("removeReserve apaga a reserva", rm.ok === true && RetailOnlineReserveService.listReserves(A).length === 0 && RetailOnlineReserveService.available(A, store.id, P, null) === 0);

  // ===== 9. Isolamento por organização =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("isolamento: org B sem reservas", RetailOnlineReserveService.listReserves(B).length === 0 && RetailOnlineReserveService.available(B, store.id, P, null) === 0);

  console.log("\n=== Loja Virtual → PDV, Fase 0 (ADR-143) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
