/**
 * TESTE — ADR-085: snapshot diário + tendência do painel de valor/adoção
 * ---------------------------------------------------------------------
 * Prova, offline, a série histórica factual:
 *   - snapshotDaily grava o retrato do dia (valor comprovado, capital parado,
 *     atendimentos da IA, fechamentos, adoção) e é idempotente por (org, dia);
 *   - getTrend devolve a série ordenada; valores conferem; isolamento por org.
 *
 * Uso:  npm run test:retail-impact-trend
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-trend-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-trend-1234567890";

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

  // Dados do mês 2026-07: divergência de comissão (80), estoque (capital 50),
  // 1 mensagem do bot, 1 fechamento conferido.
  const runId = randomUUID();
  db.prepare(`INSERT INTO retail_commission_runs (id, organization_id, period_start, period_end, status) VALUES (?, ?, '2026-07-01', '2026-07-31', 'draft')`).run(runId, A);
  db.prepare(`INSERT INTO retail_commission_items (id, organization_id, run_id, store_id, divergence_amount, status) VALUES (?, ?, ?, ?, 80, 'divergent')`).run(randomUUID(), A, runId, s1.id);
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 5, 10)`).run(randomUUID(), A, randomUUID());
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'bot', 'oi', '2026-07-05 10:00:00')`).run(randomUUID(), A, randomUUID());
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-10', 'received', 1000)`).run(randomUUID(), A, s1.id);

  // ---- Snapshots ----
  check("snapshotDaily grava (retorna true)", RetailImpactService.snapshotDaily(A, "2026-07-10") === true);
  check("snapshotDaily é idempotente no mesmo dia (false)", RetailImpactService.snapshotDaily(A, "2026-07-10") === false);
  check("snapshotDaily em outro dia grava (true)", RetailImpactService.snapshotDaily(A, "2026-07-11") === true);

  // ---- Tendência (janela grande p/ não depender do relógio) ----
  const trend = RetailImpactService.getTrend(A, 100000);
  check("getTrend traz 2 pontos ordenados", trend.length === 2 && trend[0].snapshot_date === "2026-07-10" && trend[1].snapshot_date === "2026-07-11");
  check("Valores do snapshot conferem (comprovado 80, capital 50, IA 1, fechamento 1)",
    trend[0].proven_brl === 80 && trend[0].stock_capital === 50 && trend[0].ai_messages === 1 && trend[0].closings_checked === 1);
  check("Adoção é um percentual válido (0..100)", typeof trend[0].adoption_percent === "number" && trend[0].adoption_percent >= 0 && trend[0].adoption_percent <= 100);

  // ---- Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: org B sem série", RetailImpactService.getTrend(B, 100000).length === 0);

  console.log("\n=== ADR-085: snapshot diário + tendência do painel de valor ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
