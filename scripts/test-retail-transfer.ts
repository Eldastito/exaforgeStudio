/**
 * TEST — Transferência de estoque entre lojas (ADR-083, Fase G).
 *
 * Prova o ciclo com controle:
 *   - create despacha: baixa na ORIGEM, status 'in_transit', quantity_sent;
 *   - bloqueia enviar mais do que há na origem;
 *   - receive dá entrada no DESTINO (quantidade recebida, que pode diferir),
 *     fecha 'received';
 *   - cancel em trânsito ESTORNA a baixa da origem;
 *   - não recebe/cancela fora de 'in_transit';
 *   - isolado por organização.
 *
 * Uso: npm run test:retail-transfer
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-transfer-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-transfer-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailInventoryService } = await import("../src/server/RetailInventoryService.js");
  const { RetailTransferService } = await import("../src/server/RetailTransferService.js");

  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Rede', 'active')`).run(randomUUID(), A);
  const s1 = RetailStoreService.create(A, { name: "Loja Centro", code: "01", whatsappIdentifier: "5511900000001" });
  const s2 = RetailStoreService.create(A, { name: "Loja Shopping", code: "02", whatsappIdentifier: "5511900000002" });

  // Produto com variante (grade). Origem (s1) tem 5; destino (s2) tem 0.
  const prod = randomUUID(), variant = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active) VALUES (?, ?, 'product', 'Camisa', 100, 1)`).run(prod, A);
  db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, size, color) VALUES (?, ?, ?, 'M/Preto', 'M', 'Preto')`).run(variant, A, prod);
  RetailInventoryService.setQuantity(A, s1.id, prod, variant, 5);
  RetailInventoryService.setQuantity(A, s2.id, prod, variant, 0);
  const qtyAt = (store: string) => Number(RetailInventoryService.get(A, store, prod, variant)?.quantity_available ?? 0);

  // ===== 1. Despacho dá baixa na origem =====
  const t = RetailTransferService.create(A, { originStoreId: s1.id, destStoreId: s2.id, items: [{ productId: prod, variantId: variant, quantity: 3 }] }, "u1");
  check("transferência nasce em trânsito", t.status === "in_transit", t.status);
  check("baixa na origem (5 → 2)", qtyAt(s1.id) === 2, String(qtyAt(s1.id)));
  check("destino AINDA não recebeu (segue 0)", qtyAt(s2.id) === 0, String(qtyAt(s2.id)));
  check("item guarda quantity_sent = 3", t.items?.[0]?.quantity_sent === 3, JSON.stringify(t.items));

  // ===== 2. Não deixa enviar mais do que há (origem tem 2 agora) =====
  let blocked = false;
  try { RetailTransferService.create(A, { originStoreId: s1.id, destStoreId: s2.id, items: [{ productId: prod, variantId: variant, quantity: 99 }] }); }
  catch { blocked = true; }
  check("bloqueia enviar mais do que há na origem", blocked === true);
  check("origem intacta após a tentativa bloqueada (segue 2)", qtyAt(s1.id) === 2);

  // ===== 3. Recepção dá entrada no destino =====
  const recv = RetailTransferService.receive(A, t.id, {}, "u2");
  check("status vira 'received'", recv.status === "received", recv.status);
  check("entrada no destino (0 → 3)", qtyAt(s2.id) === 3, String(qtyAt(s2.id)));
  check("item registra quantity_received = 3", recv.items?.[0]?.quantity_received === 3, JSON.stringify(recv.items));

  // ===== 4. Não recebe de novo (fora de trânsito) =====
  let reReceive = false;
  try { RetailTransferService.receive(A, t.id, {}); } catch { reReceive = true; }
  check("não recebe uma transferência já recebida", reReceive === true);

  // ===== 5. Cancelar em trânsito estorna a origem =====
  const t2 = RetailTransferService.create(A, { originStoreId: s1.id, destStoreId: s2.id, items: [{ productId: prod, variantId: variant, quantity: 2 }] }, "u1");
  check("2º despacho baixa origem (2 → 0)", qtyAt(s1.id) === 0, String(qtyAt(s1.id)));
  const canc = RetailTransferService.cancel(A, t2.id, "u1");
  check("cancelar vira 'cancelled'", canc.status === "cancelled", canc.status);
  check("estorno devolve à origem (0 → 2)", qtyAt(s1.id) === 2, String(qtyAt(s1.id)));

  // ===== 6. Recepção PARCIAL (recebe menos do que enviou) =====
  RetailInventoryService.setQuantity(A, s1.id, prod, variant, 10);
  const t3 = RetailTransferService.create(A, { originStoreId: s1.id, destStoreId: s2.id, items: [{ productId: prod, variantId: variant, quantity: 4 }] }, "u1");
  const destBefore = qtyAt(s2.id);
  const itemId = t3.items[0].id;
  const recv3 = RetailTransferService.receive(A, t3.id, { items: [{ itemId, quantityReceived: 3 }] }, "u2");
  check("recepção parcial: entra só o recebido (3)", qtyAt(s2.id) === destBefore + 3, `${destBefore}→${qtyAt(s2.id)}`);
  check("guarda o recebido (3) diferente do enviado (4)", recv3.items[0].quantity_received === 3 && recv3.items[0].quantity_sent === 4, JSON.stringify(recv3.items));

  // ===== 6b. Paginação/contagem/filtro de status (Fase 3 UX) =====
  const allCount = RetailTransferService.count(A);
  check("count reflete o total de transferências (3)", allCount === 3, String(allCount));
  check("count filtra por status (received = 2)", RetailTransferService.count(A, { status: "received" }) === 2, String(RetailTransferService.count(A, { status: "received" })));
  check("list respeita limit", RetailTransferService.list(A, { limit: 1 }).length === 1);
  check("list respeita offset (limit 2 + offset 2 = última)", RetailTransferService.list(A, { limit: 2, offset: 2 }).length === 1);
  check("list filtra por status (cancelled = 1)", RetailTransferService.list(A, { status: "cancelled" }).length === 1);

  // ===== 7. Isolamento por organização =====
  const B = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Outra', 'active')`).run(randomUUID(), B);
  check("org B não enxerga transferências da org A", RetailTransferService.list(B).length === 0);
  let crossBlocked = false;
  try { RetailTransferService.receive(B, t3.id, {}); } catch { crossBlocked = true; }
  check("org B não recebe transferência da org A", crossBlocked === true);
  check("org A lista suas transferências", RetailTransferService.list(A).length === 3, String(RetailTransferService.list(A).length));

  console.log("\n=== Transferência entre lojas (Fase G) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
