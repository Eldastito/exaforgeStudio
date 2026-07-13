/**
 * TESTE — ADR-085 D4: valor ESTIMADO (premissa à vista, nunca somado ao comprovado)
 * ---------------------------------------------------------------------------------
 * Prova, offline, a fatia de estimativa:
 *   - tempo devolvido = ações automatizadas × minutos/ação (premissa default);
 *   - ruptura evitada = |qtd| × custo médio × margem (premissa default 30%);
 *   - premissas sobrescrevíveis mudam o resultado;
 *   - o total estimado é só o R$ (tempo não entra); isolamento por org.
 *
 * Uso:  npm run test:retail-estimated
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-estimated-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-estimated-1234567890";

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

  // Atividade: reminders (soma reminder_count = 4), 2 mensagens do bot, 3 fechamentos conferidos.
  db.prepare(`INSERT INTO retail_store_daily_tasks (id, organization_id, store_id, task_date, task_type, status, reminder_count) VALUES (?, ?, ?, '2026-07-10', 'fechamento', 'pending', 4)`).run(randomUUID(), A, s1.id);
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'bot', 'oi', '2026-07-05 10:00:00')`).run(randomUUID(), A, randomUUID());
  db.prepare(`INSERT INTO messages (id, organization_id, ticket_id, sender_type, content, created_at) VALUES (?, ?, ?, 'bot', 'oi', '2026-07-06 10:00:00')`).run(randomUUID(), A, randomUUID());
  const closing = (date: string) => db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, ?, 'received', 1000)`).run(randomUUID(), A, s1.id, date);
  closing("2026-07-10"); closing("2026-07-11"); closing("2026-07-12");

  // Ruptura: produto com custo 10; alerta de estoque negativo resolvido no mês (qtd -5).
  const prod = randomUUID();
  db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 0, 10)`).run(randomUUID(), A, prod);
  db.prepare(`INSERT INTO retail_stock_alerts (id, organization_id, store_id, product_service_id, alert_type, quantity, status, resolved_at) VALUES (?, ?, ?, ?, 'negative_stock', -5, 'resolved', '2026-07-15 10:00:00')`).run(randomUUID(), A, s1.id, prod);

  // ---- Defaults ----
  const e = RetailImpactService.estimated(A, MONTH);
  check("Tempo devolvido = 4×3 + 2×2 + 3×10 = 46 min", e.estimated.tempoDevolvido.minutes === 46);
  check("Breakdown do tempo (4 cobranças, 2 IA, 3 fechamentos)", e.estimated.tempoDevolvido.breakdown.reminders === 4 && e.estimated.tempoDevolvido.breakdown.aiMessages === 2 && e.estimated.tempoDevolvido.breakdown.closings === 3);
  check("Ruptura evitada = 5 × 10 × 30% = 15", e.estimated.rupturaEvitada.amount === 15 && e.estimated.rupturaEvitada.alerts === 1);
  check("Total estimado (R$) = 15 (tempo não entra)", e.estimated.totalEstimatedBRL === 15);
  check("Premissa exposta no retorno", e.premissas.stockMarginPercent === 30 && e.premissas.minutesPerClosing === 10);
  check("Disclaimer de não somar ao comprovado", typeof e.disclaimer === "string" && e.disclaimer.includes("NÃO somar"));

  // ---- Premissa customizada ----
  const e2 = RetailImpactService.estimated(A, MONTH, { stockMarginPercent: 50, minutesPerClosing: 20 });
  check("Margem 50% → ruptura = 25", e2.estimated.rupturaEvitada.amount === 25);
  check("20 min/fechamento → tempo = 12+4+60 = 76", e2.estimated.tempoDevolvido.minutes === 76);

  // ---- Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const eb = RetailImpactService.estimated(B, MONTH);
  check("Isolamento: org B zerada", eb.estimated.totalEstimatedBRL === 0 && eb.estimated.tempoDevolvido.minutes === 0);

  console.log("\n=== ADR-085 D4: valor estimado (premissa à vista) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
