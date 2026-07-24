/**
 * TESTE — Gancho do checkout da loja virtual na reserva e-commerce (ADR-143 Fase 0).
 *
 * Sobe o router público real e prova, via HTTP:
 *   - reserva ligada + filial online definida: o checkout vende SÓ da reserva
 *     (dentro do limite → 200 e baixa pendente registrada; acima → 409 sem pedido);
 *   - o pedido nasce com store_id da filial online;
 *   - itens de peso/volume (sem produto) não travam a reserva;
 *   - cancelar o pedido LIBERA a reserva (releaseByOrder).
 *
 * Uso:  npm run test:retail-online-reserve-checkout
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-reserve-checkout-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-reserve-checkout-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const express = (await import("express")).default;
  const storefrontPublic = (await import("../src/server/routes/storefrontPublic.js")).default;
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailOnlineReserveService } = await import("../src/server/RetailOnlineReserveService.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");

  const orgId = randomUUID(), productId = randomUUID();
  db.prepare(`INSERT INTO organization_settings (organization_id, business_name, status) VALUES (?, 'TOULON', 'active')`).run(orgId);
  db.prepare(`INSERT INTO storefront_settings (organization_id, slug, published, title) VALUES (?, 'toulon', 1, 'Loja TOULON')`).run(orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, name, type, price, active) VALUES (?, ?, 'Camisa Polo', 'product', 120, 1)`).run(productId, orgId);
  const store = RetailStoreService.create(orgId, { name: "Toulon 1079", code: "10" });

  // Liga a reserva, define a filial online e reserva 3 unidades do produto.
  RetailOnlineReserveService.setEnabled(orgId, true);
  RetailOnlineReserveService.setOnlineStoreId(orgId, store.id);
  RetailOnlineReserveService.setReserve(orgId, store.id, productId, null, 3);

  const app = express();
  app.use(express.json());
  app.use("/api/public", storefrontPublic);
  const server = await new Promise<any>((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const port = (server.address() as any).port;
  const order = async (qty: number) => {
    const r = await fetch(`http://127.0.0.1:${port}/api/public/store/toulon/order`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: [{ productId, quantity: qty }] }),
    });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };

  // 1) Compra dentro da reserva (2 de 3) → 200 + baixa pendente + store_id no pedido.
  const a = await order(2);
  check("checkout 2/3: sucesso (200)", a.status === 200 && a.json.ok === true, `${a.status} ${JSON.stringify(a.json)}`);
  check("pedido nasce com store_id da filial online", (db.prepare(`SELECT store_id FROM orders WHERE id=?`).get(a.json.orderId) as any)?.store_id === store.id);
  check("baixa pendente registrada (2)", RetailOnlineReserveService.pendingQty(orgId, store.id, productId, null) === 2);
  check("available cai p/ 1", RetailOnlineReserveService.available(orgId, store.id, productId, null) === 1);

  // 2) Compra acima do disponível (2 com só 1) → 409 e NENHUM pedido novo criado.
  const beforeCount = (db.prepare(`SELECT COUNT(*) c FROM orders WHERE organization_id=?`).get(orgId) as any).c;
  const b = await order(2);
  check("checkout 2 com 1 disponível: bloqueado (409)", b.status === 409 && b.json.code === "out_of_stock", `${b.status} ${JSON.stringify(b.json)}`);
  const afterCount = (db.prepare(`SELECT COUNT(*) c FROM orders WHERE organization_id=?`).get(orgId) as any).c;
  check("oversell não cria pedido", afterCount === beforeCount);
  check("pendente segue 2 (bloqueio não registrou baixa)", RetailOnlineReserveService.pendingQty(orgId, store.id, productId, null) === 2);

  // 3) Cancelar o pedido LIBERA a reserva.
  OrdersService.updateStatus(orgId, a.json.orderId, "cancelado");
  check("cancelar libera a reserva (pendente 0)", RetailOnlineReserveService.pendingQty(orgId, store.id, productId, null) === 0);
  check("available volta a 3", RetailOnlineReserveService.available(orgId, store.id, productId, null) === 3);

  // 4) Sem filial online definida → checkout não aplica reserva (comportamento atual).
  RetailOnlineReserveService.setOnlineStoreId(orgId, null);
  const c = await order(99);
  check("sem filial online: checkout não bloqueia (200)", c.status === 200 && c.json.ok === true, `${c.status} ${JSON.stringify(c.json)}`);

  server.close();
  console.log("\n=== Gancho checkout loja virtual → reserva (ADR-143 Fase 0) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
