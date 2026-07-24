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

  // ===== 3a2. Reserva baixa (alerta antecipado) + ruptura ativa por loja =====
  const PL = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'PL', 100, 1, 0)`).run(PL, A);
  RetailOnlineReserveService.setReserve(A, store.id, PL, null, 10);
  OrdersService.createOrder(A, { items: [{ productId: PL, name: "PL", unitPrice: 0, quantity: 9 }], storeId: store.id, autoClose: true }); // available 1 (≤20%)
  for (const pid of [randomUUID(), randomUUID(), randomUUID()]) db.prepare(`INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, alert_type, quantity, status) VALUES (?, ?, ?, ?, 'negative_stock', -2, 'open')`).run(randomUUID(), A, store.id, pid);
  RetailOpsSignalPublisher.run(A, { asOf: today, windowDays: 3650 });
  check("reserva baixa (1 de 10) → retail_reserve_low", !!db.prepare(`SELECT id FROM business_signals WHERE organization_id=? AND signal_type='retail_reserve_low' AND status='open'`).get(A));
  const stockout = db.prepare(`SELECT domain, severity, impact_amount FROM business_signals WHERE organization_id=? AND signal_type='retail_store_stockout' AND status='open'`).get(A) as any;
  check("3 rupturas na loja → retail_store_stockout (inventory/risco, impacto 3)", stockout && stockout.domain === "inventory" && stockout.severity === "risk" && Number(stockout.impact_amount) === 3, JSON.stringify(stockout));

  // ===== 3b. Novos sinais: concentração, backlog, vendedor abaixo da meta =====
  const C = `org_C_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'C', 'active')`).run(randomUUID(), C);
  const storeC = (await import("../src/server/RetailStoreService.js")).RetailStoreService.create(C, { name: "Loja C", code: "9" });
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const U1 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, C, `ana_${U1.slice(0, 6)}@x.com`);
  const PX = randomUUID(), PY = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'PX', 100, 1, 0)`).run(PX, C);
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'PY', 100, 1, 0)`).run(PY, C);
  RetailOnlineReserveService.setEnabled(C, true);
  RetailOnlineReserveService.setReserve(C, storeC.id, PX, null, 100); // alta: não esgota
  // 5 vendas online de PX pela Ana → 5 baixas pendentes + vendas do vendedor.
  for (let i = 0; i < 5; i++) OrdersService.createOrder(C, { items: [{ productId: PX, name: "PX", unitPrice: 0, quantity: 1 }], storeId: storeC.id, sellerUserId: U1, autoClose: true });
  OrdersService.createOrder(C, { items: [{ productId: PY, name: "PY", unitPrice: 0, quantity: 1 }], autoClose: true }); // PY: só p/ haver 2 produtos
  // Regra de meta por vendedor (Ana vendeu 500 < meta 1000).
  RetailCommissionService.createRule(C, { name: "Meta", scope: "seller", calculationType: "quota_bonus", config: { bonus: 100, quota: 1000 } });

  const rc = RetailOpsSignalPublisher.run(C, { asOf: today, windowDays: 3650 });
  check("concentração: PX ~83% das vendas → sinal", !!db.prepare(`SELECT id FROM business_signals WHERE organization_id=? AND signal_type='retail_sales_concentration' AND status='open'`).get(C), JSON.stringify(rc));
  const backlog = db.prepare(`SELECT impact_amount FROM business_signals WHERE organization_id=? AND signal_type='retail_writeback_backlog' AND status='open'`).get(C) as any;
  check("backlog: 5 baixas pendentes → sinal (impacto 5)", backlog && Number(backlog.impact_amount) === 5, JSON.stringify(backlog));
  const below = db.prepare(`SELECT evidence_json FROM business_signals WHERE organization_id=? AND signal_type='retail_seller_below_quota' AND status='open'`).get(C) as any;
  check("vendedor abaixo da meta: Ana 500 < 1000 → sinal", below && JSON.parse(below.evidence_json).gap === 500, JSON.stringify(below));

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
