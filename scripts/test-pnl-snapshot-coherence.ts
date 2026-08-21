/**
 * TEST — Coerência de escopo no snapshot executivo (ADR-182 F3). DB-backed, determinístico.
 * Prova: finance.dre.receitaLiquida carrega scope='core' + aviso de não-somar; sales.receitaMes
 * carrega scope='all_channels' + segments/overlapRisk/bridgeEnabled; com a ponte ligada os dois
 * DIVERGEM pela receita de loja (explicado, não misterioso); valores 0-regressão.
 *
 * Uso: npm run test:pnl-snapshot-coherence
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-pnlsnap-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-pnlsnap-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { FinanceSnapshotAdapter } = await import("../src/server/FinanceSnapshotAdapter.js");
  const { SalesSnapshotAdapter } = await import("../src/server/BusinessSnapshotAdapters.js");

  const PERIOD = "2026-06";
  const A = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, vertical) VALUES (?, ?, 'A', 'active', 'moda')`).run(randomUUID(), A);
  // Receita core via order_items (o DRE usa line_total): pedido de 1000.
  const oid = randomUUID();
  db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', 1000, '2026-06-10 10:00:00')`).run(oid, A);
  db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total) VALUES (?, ?, ?, 'P', 1000, 1, 1000)`).run(randomUUID(), oid, A);
  // Fechamento de loja 500 + ponte ligada.
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total) VALUES (?, ?, 'loja1', '2026-06-12', 'approved', 500)`).run(randomUUID(), A);
  db.prepare(`UPDATE organization_settings SET retail_revenue_bridge = 1 WHERE organization_id = ?`).run(A);

  const fin = FinanceSnapshotAdapter.build(A, PERIOD);
  const sales = SalesSnapshotAdapter.build(A, PERIOD);

  // 1. DRE carrega escopo core + aviso de não-somar.
  check("1.1 dre.scope = core", fin.dre?.scope === "core");
  check("1.2 dre tem aviso de não somar", /Não somar|all_channels/i.test(fin.dre?.scopeNote || ""));

  // 2. sales carrega escopo all_channels + reconciliação.
  check("2.1 sales.receitaMes.scope = all_channels", sales.receitaMes?.scope === "all_channels");
  check("2.2 sales carrega segments", sales.receitaMes?.segments && sales.receitaMes.segments.storeClosings === 500);
  check("2.3 sales carrega bridgeEnabled true", sales.receitaMes?.bridgeEnabled === true);
  check("2.4 sales carrega overlapRisk true (core + loja)", sales.receitaMes?.overlapRisk === true);

  // 3. Os dois DIVERGEM pela receita de loja — explicado, não misterioso.
  //    DRE core = 1000 (só order_items); sales all_channels = 1000(order total_amount) + 500 = 1500.
  check("3.1 dre.receitaLiquida = 1000 (core)", fin.dre?.receitaLiquida === 1000);
  check("3.2 sales.receitaMes.value = 1500 (all_channels)", sales.receitaMes?.value === 1500);
  check("3.3 a diferença é exatamente a receita de loja (500)", (sales.receitaMes.value - fin.dre.receitaLiquida) === sales.receitaMes.segments.storeClosings);

  // 4. Ponte off → sales volta a bater com o core (sem fechamentos) e overlapRisk some.
  db.prepare(`UPDATE organization_settings SET retail_revenue_bridge = 0 WHERE organization_id = ?`).run(A);
  const salesOff = SalesSnapshotAdapter.build(A, PERIOD);
  check("4.1 ponte off → storeClosings 0", salesOff.receitaMes.segments.storeClosings === 0);
  check("4.2 ponte off → overlapRisk false", salesOff.receitaMes.overlapRisk === false);
  check("4.3 ponte off → sales = 1000 (só core)", salesOff.receitaMes.value === 1000);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} pnl-snapshot-coherence: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
