/**
 * TESTE — ADR-085 (fatia só-leitura): Impact Ledger — valor comprovado
 * --------------------------------------------------------------------
 * Prova, offline, a primeira fatia do Impact Ledger:
 *   - VALOR COMPROVADO (R$): divergências de comissão apuradas; conciliação
 *     informado × sistema fica em zero até a Fase E (system_total nulo);
 *   - ATIVIDADE (contagens, NÃO R$): fechamentos conferidos, cobranças enviadas,
 *     correções de estoque negativo, alertas abertos, lojas monitoradas;
 *   - comprovado e atividade nunca são somados; isolamento por organização.
 *
 * Uso:  npm run test:retail-impact
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-impact-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-impact-1234567890";

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
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });
  const MONTH = "2026-07";

  // Comissão: run no mês + itens com divergência (|50| + |-30| = 80; item 0 ignorado).
  const runId = randomUUID();
  db.prepare(`INSERT INTO retail_commission_runs (id, organization_id, period_start, period_end, status) VALUES (?, ?, '2026-07-01', '2026-07-31', 'draft')`).run(runId, A);
  const item = (div: number | null) =>
    db.prepare(`INSERT INTO retail_commission_items (id, organization_id, run_id, store_id, divergence_amount, status) VALUES (?, ?, ?, ?, ?, 'divergent')`)
      .run(randomUUID(), A, runId, s1.id, div);
  item(50); item(-30); item(0); item(null);

  // Fechamentos: 3 conferidos (received/extracted/approved) + 1 rejeitado (ignorado).
  // UNIQUE por (org, loja, dia) → cada um em uma combinação distinta.
  const closing = (store: string, date: string, status: string) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, ?, 1000)`)
      .run(randomUUID(), A, store, date, status);
  closing(s1.id, "2026-07-10", "received"); closing(s2.id, "2026-07-10", "extracted");
  closing(s1.id, "2026-07-11", "approved"); closing(s2.id, "2026-07-11", "rejected");

  // Tarefas: cobranças enviadas (reminder_count 2 + 1 = 3).
  const task = (store: string, type: string, reminders: number) =>
    db.prepare(`INSERT INTO retail_store_daily_tasks (id, organization_id, store_id, task_date, task_type, status, reminder_count) VALUES (?, ?, ?, '2026-07-10', ?, 'pending', ?)`)
      .run(randomUUID(), A, store, type, reminders);
  task(s1.id, "fechamento", 2); task(s2.id, "malote", 1);

  // Estoque: 1 alerta resolvido no mês + 1 aberto.
  db.prepare(`INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, alert_type, quantity, status, resolved_at) VALUES (?, ?, ?, ?, 'negative_stock', -3, 'resolved', '2026-07-15 10:00:00')`)
    .run(randomUUID(), A, s1.id, randomUUID());
  db.prepare(`INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, alert_type, quantity, status) VALUES (?, ?, ?, ?, 'negative_stock', -1, 'open')`)
    .run(randomUUID(), A, s2.id, randomUUID());

  const m = RetailImpactService.monthly(A, MONTH);

  // ---- Valor comprovado (R$) ----
  check("Comissão: divergências apuradas = |50|+|-30| = 80", m.proven.commissionDivergences.amount === 80 && m.proven.commissionDivergences.count === 2);
  check("Conciliação informado×sistema = 0 até a Fase E", m.proven.systemReconciliation.amount === 0 && m.proven.systemReconciliation.count === 0);
  check("Total comprovado (R$) = 80", m.proven.totalProvenBRL === 80);

  // ---- Atividade (contagens) ----
  check("Fechamentos conferidos = 3 (rejeitado não conta)", m.activity.closingsChecked === 3);
  check("Cobranças enviadas = 3 (soma reminder_count)", m.activity.remindersSent === 3);
  check("Correções de estoque negativo = 1 resolvido", m.activity.stockCorrections === 1);
  check("Alertas de estoque abertos = 1", m.activity.openStockAlerts === 1);
  check("Lojas monitoradas = 2", m.activity.storesMonitored === 2);

  // ---- Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const mb = RetailImpactService.monthly(B, MONTH);
  check("Isolamento: org B vem zerada", mb.proven.totalProvenBRL === 0 && mb.activity.closingsChecked === 0 && mb.activity.storesMonitored === 0);

  console.log("\n=== ADR-085: Impact Ledger — valor comprovado (fatia só-leitura) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
