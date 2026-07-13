/**
 * TESTE — ADR-085: baseline dia-0 (antes → depois)
 * ------------------------------------------------
 * Prova, offline, o retrato do dia 0 e a comparação com o agora:
 *   - captura é idempotente (uma vez por org, não sobrescreve);
 *   - sem baseline, baseline() reporta captured=false + estado atual;
 *   - depois de melhorar (capital cai, alerta resolvido), o delta reflete;
 *   - isolamento por organização.
 *
 * Uso:  npm run test:retail-baseline
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-baseline-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-baseline-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailImpactService } = await import("../src/server/RetailImpactService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });

  // Sem baseline ainda.
  check("Sem baseline: captured=false + estado atual presente", RetailImpactService.baseline(A).captured === false);

  // Estado do "dia 0": capital 100 (10×10) + 1 alerta aberto.
  const prod = randomUUID();
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 10, 10)`).run(randomUUID(), A, prod);
  const alertId = randomUUID();
  db.prepare(`INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, alert_type, quantity, status) VALUES (?, ?, ?, ?, 'negative_stock', -2, 'open')`).run(alertId, A, s1.id, randomUUID());

  check("Captura o baseline (true)", RetailImpactService.captureBaseline(A) === true);
  check("Capturar de novo é idempotente (false)", RetailImpactService.captureBaseline(A) === false);

  let b = RetailImpactService.baseline(A);
  check("Baseline gravou capital 100 e 1 alerta", b.captured === true && b.baseline.stockCapital === 100 && b.baseline.openStockAlerts === 1);
  check("Delta inicial zerado (agora == dia 0)", b.delta.stockCapital === 0 && b.delta.openStockAlerts === 0);

  // O ZappFlow ajuda a melhorar: escoa metade do estoque e resolve o alerta.
  db.prepare(`UPDATE inventory_items SET quantity_available = 5 WHERE organization_id = ? AND product_service_id = ?`).run(A, prod); // capital 50
  db.prepare(`UPDATE retail_stock_alerts SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP WHERE id = ?`).run(alertId);

  b = RetailImpactService.baseline(A);
  check("Depois: capital atual 50 (baseline segue 100)", b.current.stockCapital === 50 && b.baseline.stockCapital === 100);
  check("Delta: capital -50, alertas -1", b.delta.stockCapital === -50 && b.delta.openStockAlerts === -1);

  // Isolamento
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: org B sem baseline", RetailImpactService.baseline(B).captured === false);

  console.log("\n=== ADR-085: baseline dia-0 (antes → depois) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
