/**
 * TEST — Comigo/Mesa-QR pay-first (ADR-119 / ADR-088 D4).
 *
 * Uso: npm run test:comigo-mesa
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-mesa-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-mesa-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoMesaService: M } = await import("../src/server/ComigoMesaService.js");
  const { ComigoPixService: Pix } = await import("../src/server/ComigoPixService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
  const galeto = randomUUID(), refri = randomUUID(), inativo = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Galeto', 45, 1)`).run(galeto, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Refri', 5, 1)`).run(refri, orgId);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Fora de linha', 9, 0)`).run(inativo, orgId);

  // ===== 1. Token resolve a org =====
  const token = M.ensureToken(orgId);
  check("ensureToken gera token", !!token && token.startsWith("mesa_"));
  check("ensureToken é idempotente", M.ensureToken(orgId) === token);
  check("orgByToken resolve a org", M.orgByToken(token) === orgId);
  check("token inválido não resolve", M.orgByToken("mesa_xxx") === null);

  // ===== 2. Cardápio só com ativos e preço do servidor =====
  const menu = M.menu(orgId);
  check("cardápio traz os ativos", menu.length === 2);
  check("cardápio NÃO traz produto inativo", !menu.some((m) => m.id === inativo));

  // ===== 3. placeOrder: preço do SERVIDOR, cria pedido mesa + cobrança =====
  const placed = M.placeOrder(orgId, { items: [{ productId: galeto, qty: 1 }, { productId: refri, qty: 2 }], sessionAlias: "Mesa 3", consumo: "local" }) as any;
  check("pedido criado", placed.ok === true && !!placed.orderId);
  check("total usa preço do servidor (45 + 2×5 = 55)", near(placed.total, 55));
  check("gerou cobrança Pix (txid)", !!placed.txid && !!placed.qrPayload);
  check("pedido é source='mesa'", (db.prepare("SELECT source FROM comigo_orders WHERE id=?").get(placed.orderId) as any).source === "mesa");

  // ===== 3b. Cliente não consegue forjar preço (só manda productId+qty) =====
  const placed2 = M.placeOrder(orgId, { items: [{ productId: galeto, qty: 1 } as any] }) as any;
  check("2º pedido também precifica pelo servidor (45)", near(placed2.total, 45));

  // ===== 3c. Item inválido/inativo é ignorado; carrinho vazio falha =====
  const onlyInvalid = M.placeOrder(orgId, { items: [{ productId: inativo, qty: 1 }, { productId: "nao_existe", qty: 1 }] }) as any;
  check("pedido só com itens inválidos falha", onlyInvalid.ok === false);
  check("carrinho vazio falha", (M.placeOrder(orgId, { items: [] }) as any).ok === false);

  // ===== 4. PAY-FIRST: não entra na fila de preparo até pagar =====
  check("antes de pagar: fora da fila de preparo", M.prepQueue(orgId).length === 0);
  check("status do cliente: não pago", M.orderStatus(orgId, placed.orderId).paid === false);

  // ===== 5. Confirmado o Pix → entra na fila =====
  Pix.confirmByTxid(orgId, placed.txid);
  const queue = M.prepQueue(orgId);
  check("após pagar: aparece na fila de preparo", queue.length === 1 && queue[0].id === placed.orderId);
  check("fila traz os itens do pedido", (queue[0].items || []).length === 2);
  check("status do cliente: pago", M.orderStatus(orgId, placed.orderId).paid === true);

  // ===== 6. markFulfilled tira da fila =====
  check("markFulfilled ok", M.markFulfilled(orgId, placed.orderId) === true);
  check("após entregar: sai da fila", M.prepQueue(orgId).length === 0);
  check("marcar entregue de novo não faz nada", M.markFulfilled(orgId, placed.orderId) === false);

  // ===== 7. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  check("isolamento: outra org não vê o pedido", M.orderStatus(other, placed.orderId).found === false);
  check("isolamento: fila da outra org vazia", M.prepQueue(other).length === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Mesa/QR pay-first (ADR-119) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Mesa/QR pay-first OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
