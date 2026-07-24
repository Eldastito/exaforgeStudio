/**
 * TESTE — RetailOpsSignalPublisher: conecta as operações ao cérebro (ADR-136).
 *
 * Prova que a operação vira SINAL (que flui p/ Pareto/Diretor):
 *   - reserva online esgotada num produto que vende → retail_online_reserve_out (risco);
 *   - produto reservado sem giro online → retail_product_no_online_sales (atenção);
 *   - quando a condição some (reserva reabastecida), o sinal é AUTO-RESOLVIDO;
 *   - isolado por organização.
 *
 * Uso:  npm run test:retail-ops-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-ops-signals-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-ops-signals-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailOnlineReserveService } = await import("../src/server/RetailOnlineReserveService.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { RetailOpsSignalPublisher } = await import("../src/server/RetailOpsSignalPublisher.js");

  const today = new Date().toISOString().slice(0, 10);
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Loja 1", code: "1" });
  const PA = randomUUID(), PB = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0)`).run(PA, A);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Calça', 100, 1, 0)`).run(PB, A);

  RetailOnlineReserveService.setEnabled(A, true);
  RetailOnlineReserveService.setReserve(A, store.id, PA, null, 3);  // vai esgotar
  RetailOnlineReserveService.setReserve(A, store.id, PB, null, 2);  // reservado, sem giro

  // Vende PA online (esgota a reserva: available 3 → 0) e vira venda faturada.
  OrdersService.createOrder(A, { items: [{ productId: PA, name: "Camisa", unitPrice: 0, quantity: 3 }], storeId: store.id, autoClose: true });
  check("setup: reserva PA esgotada (available 0)", RetailOnlineReserveService.available(A, store.id, PA, null) === 0);

  // ===== 1. Publica os sinais =====
  const r1 = RetailOpsSignalPublisher.run(A, { asOf: today, windowDays: 3650 });
  check("publicou 2 sinais", r1.published === 2, JSON.stringify(r1));
  const outSig = db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND signal_type='retail_online_reserve_out' AND status='open'`).get(A) as any;
  check("reserva esgotada → sinal retail_ops/risco, impacto 300", outSig && outSig.domain === "retail_ops" && outSig.severity === "risk" && Number(outSig.impact_amount) === 300, JSON.stringify(outSig));
  const noGiro = db.prepare(`SELECT * FROM business_signals WHERE organization_id=? AND signal_type='retail_product_no_online_sales' AND status='open'`).get(A) as any;
  check("produto sem giro → sinal sales/atenção", noGiro && noGiro.domain === "sales" && noGiro.severity === "attention", JSON.stringify(noGiro));

  // ===== 2. Idempotência (re-run não duplica) =====
  RetailOpsSignalPublisher.run(A, { asOf: today, windowDays: 3650 });
  const cnt = (db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id=? AND source_service='RetailOpsSignalPublisher'`).get(A) as any).c;
  check("idempotente: 2 sinais (sem duplicar)", cnt === 2, `viu ${cnt}`);

  // ===== 3. Auto-resolve quando a condição some (reserva reabastecida) =====
  RetailOnlineReserveService.setReserve(A, store.id, PA, null, 10); // available = 10 − 3 = 7 > 0
  const r3 = RetailOpsSignalPublisher.run(A, { asOf: today, windowDays: 3650 });
  check("reabastecer resolve o sinal de esgotamento", r3.resolved >= 1, JSON.stringify(r3));
  const outAfter = db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND signal_type='retail_online_reserve_out'`).get(A) as any;
  check("sinal de esgotamento agora 'resolved'", outAfter?.status === "resolved", JSON.stringify(outAfter));
  const noGiroAfter = db.prepare(`SELECT status FROM business_signals WHERE organization_id=? AND signal_type='retail_product_no_online_sales'`).get(A) as any;
  check("sinal sem-giro segue aberto (condição ainda vale)", noGiroAfter?.status === "open");

  // ===== 4. Isolamento =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const rB = RetailOpsSignalPublisher.run(B, { asOf: today });
  check("isolamento: org B sem sinais", rB.published === 0 && rB.reserves === 0);

  console.log("\n=== RetailOpsSignalPublisher (operações → cérebro, ADR-136) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
