/**
 * TESTE — ADR-085: painel de valor consolidado (factual)
 * ------------------------------------------------------
 * Prova, offline, a composição do painel de valor:
 *   - valor comprovado (R$) vindo das divergências de comissão;
 *   - atividade (fechamentos conferidos) + atendimentos que a IA fez sozinha
 *     (mensagens do bot no mês);
 *   - capital parado + top produtos sem giro; isolamento por organização.
 *
 * Uso:  npm run test:retail-impact-summary
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-summary-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-summary-1234567890";

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
  const MONTH = "2026-07";

  // Comprovado: run + item com divergência 80.
  const runId = randomUUID();
  db.prepare(`INSERT INTO retail_commission_runs (id, organization_id, period_start, period_end, status) VALUES (?, ?, '2026-07-01', '2026-07-31', 'draft')`).run(runId, A);
  db.prepare(`INSERT INTO retail_commission_items (id, organization_id, run_id, store_id, divergence_amount, status) VALUES (?, ?, ?, ?, 80, 'divergent')`).run(randomUUID(), A, runId, s1.id);

  // Atividade: 1 fechamento conferido.
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-10', 'received', 1000)`).run(randomUUID(), A, s1.id);

  // IA: 2 mensagens do bot no mês + 1 do contato (não conta).
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'bot', 'oi', '2026-07-05 10:00:00')`).run(randomUUID(), A, randomUUID());
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'bot', 'oi', '2026-07-06 10:00:00')`).run(randomUUID(), A, randomUUID());
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'contact', 'oi', '2026-07-06 11:00:00')`).run(randomUUID(), A, randomUUID());

  // Capital parado: 1 produto com saldo (sem giro).
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 5, 10)`).run(randomUUID(), A, randomUUID());

  const sum = RetailImpactService.summary(A, MONTH, 60);

  check("Comprovado (R$) = 80", sum.proven.totalProvenBRL === 80);
  check("Atividade: 1 fechamento conferido", sum.activity.closingsChecked === 1);
  check("Atividade: 2 atendimentos da IA (só bot)", sum.activity.aiMessagesHandled === 2);
  check("Capital parado total = 50", sum.stockCapital.total === 50);
  check("Sem giro: 1 produto no top", sum.stockCapital.slowMoverCount === 1 && sum.stockCapital.topSlowMovers.length === 1);

  // Isolamento
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const sb = RetailImpactService.summary(B, MONTH, 60);
  check("Isolamento: org B zerada", sb.proven.totalProvenBRL === 0 && sb.activity.aiMessagesHandled === 0 && sb.stockCapital.total === 0);

  console.log("\n=== ADR-085: painel de valor consolidado (factual) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
