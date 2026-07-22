/**
 * TEST — Ganchos automáticos de perda (ADR-114 Fatia 2): a merma do Comigo, o
 * calote do fiado e a divergência do RetailOps alimentam loss_events sem
 * digitação dupla.
 *
 * Uso: npm run test:loss-hooks
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-loss-hooks-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-loss-hooks-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.05) => Math.abs(a - b) <= eps;
const period = new Date().toISOString().slice(0, 7);

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoPricingService: P } = await import("../src/server/ComigoPricingService.js");
  const { BalcaoService: B } = await import("../src/server/BalcaoService.js");
  const { LossMarginService: L } = await import("../src/server/LossMarginService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), orgId);
  const driverSum = (drv: string) => (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM loss_events WHERE organization_id=? AND driver=?").get(orgId, drv) as any).s;

  // ===== 1. MERMA: calibração com perda vira loss_event (valorada pelo custo) =====
  const rid = randomUUID();
  db.prepare(`INSERT INTO comigo_recipes (id, organization_id, name, kind, yield_qty) VALUES (?, ?, 'Pipoca', 'fabricacao', 40)`).run(rid, orgId);
  db.prepare(`INSERT INTO comigo_recipe_costs (id, recipe_id, label, kind, amount, is_estimate) VALUES (?, ?, 'milho', 'insumo', 12, 0)`).run(randomUUID(), rid);
  // Fechou: rendeu 30 (custo unit 12/30 = 0,40) e 3 queimaram → merma = 3 × 0,40 = 1,20.
  P.applyCalibration(orgId, rid, 30, 3, "3 queimaram");
  check("merma lançada automaticamente (3 × 0,40 = 1,20)", near(driverSum("merma"), 1.2));
  // Calibração sem perda não lança.
  P.applyCalibration(orgId, rid, 30, 0);
  check("calibração sem merma não lança nada a mais", near(driverSum("merma"), 1.2));

  // ===== 2. CALOTE: baixa do fiado vira loss_event =====
  const cid = B.ensureFiadoContact(orgId, "Caloteiro", "5511900000000");
  const o = B.openOrder(orgId, { contactId: cid });
  B.addItem(orgId, o, { name: "Marmita", qty: 2, unitPrice: 15 });
  B.setCreditLimit(orgId, cid, 100);
  B.pay(orgId, o, { paidVia: "fiado" });
  check("saldo do fiado = 30", near(B.balanceOf(orgId, cid), 30));
  const wo = B.writeOffFiado(orgId, cid, "sumiu") as any;
  check("baixa por calote retorna o valor (30)", wo.ok === true && near(wo.amount, 30));
  check("saldo zerado após a baixa", near(B.balanceOf(orgId, cid), 0));
  check("calote lançado nas perdas (30)", near(driverSum("calote"), 30));
  check("baixar de novo (sem saldo) é recusado", B.writeOffFiado(orgId, cid).ok === false);

  // ===== 3. Idempotência do gancho por source (RetailOps) =====
  L.recordLossUnique(orgId, "retail_closing:abc", { driver: "divergencia", amount: 50, period });
  L.recordLossUnique(orgId, "retail_closing:abc", { driver: "divergencia", amount: 50, period }); // reimport
  check("divergência idempotente por source (não duplica)", near(driverSum("divergencia"), 50));

  // ===== 4. Tudo aparece no resumo do mês por driver =====
  const s = L.monthlySummary(orgId, period);
  check("resumo agrega os 3 drivers automáticos", s.byDriver.some((d) => d.driver === "merma") && s.byDriver.some((d) => d.driver === "calote") && s.byDriver.some((d) => d.driver === "divergencia"));

  // ===== 5. Isolamento =====
  const other = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), other);
  check("isolamento: outra org sem perdas", (db.prepare("SELECT COUNT(*) c FROM loss_events WHERE organization_id=?").get(other) as any).c === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Ganchos automáticos de perda (ADR-114 Fatia 2) ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Ganchos de perda OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
