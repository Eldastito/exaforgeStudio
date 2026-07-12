/**
 * TESTE — Retail Ops Fase B: cotas + fechamento + checklist diário (ADR-083)
 * -------------------------------------------------------------------------
 * Prova, offline, a espinha operacional:
 *   - cotas por loja/dia (upsert, import em lote, isolamento);
 *   - fechamento: getOrCreate idempotente c/ snapshot da cota; setInformed
 *     calcula o desvio (realizado - cota) e grava itens; aprovação;
 *   - checklist: generateDay cria fechamento/malote/escala por loja ativa
 *     respeitando as flags, idempotente; markSubmitted;
 *   - o pass do Scheduler gera as pendências das orgs opt-in.
 *
 * Uso:  npm run test:retail-closing
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-b-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-b-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailQuotaService, RetailClosingService, RetailTaskService } = await import("../src/server/RetailOpsService.js");
  const { Scheduler } = await import("../src/server/Scheduler.js");

  const DATE = "2026-07-10";
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  db.prepare(`UPDATE organization_settings SET retail_daily_closing_enabled=1, retail_malote_enabled=1, retail_scale_reminder_enabled=1, retail_daily_closing_due_hour=21 WHERE organization_id=?`).run(A);
  const s1 = RetailStoreService.create(A, { name: "Loja 1", whatsappIdentifier: "5511900000001" });
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });
  const s3 = RetailStoreService.create(A, { name: "Loja 3 (inativa)", active: false });

  // ---- 1. Cotas ----
  RetailQuotaService.set(A, { storeId: s1.id, quotaDate: DATE, quotaAmount: 1000 });
  check("Cota gravada", RetailQuotaService.get(A, s1.id, DATE)?.quota_amount === 1000);
  RetailQuotaService.set(A, { storeId: s1.id, quotaDate: DATE, quotaAmount: 1500 }); // upsert
  check("Upsert de cota atualiza o valor", RetailQuotaService.get(A, s1.id, DATE)?.quota_amount === 1500);
  const imp = RetailQuotaService.import(A, [{ storeId: s2.id, quotaDate: DATE, quotaAmount: 800 }, { storeId: s1.id, quotaDate: DATE, quotaAmount: 1500 }]);
  check("Import em lote grava as cotas", imp === 2 && RetailQuotaService.listByDate(A, DATE).length === 2);

  // ---- 2. Fechamento ----
  const c1 = RetailClosingService.getOrCreate(A, s1.id, DATE);
  check("Fechamento nasce 'pending' com a cota snapshot", c1.status === "pending" && c1.quota_amount === 1500);
  check("getOrCreate é idempotente", RetailClosingService.getOrCreate(A, s1.id, DATE).id === c1.id);
  const inf = RetailClosingService.setInformed(A, c1.id, { informedTotal: 1800, items: [{ paymentMethod: "pix", informedAmount: 1800 }], source: "manual" });
  check("setInformed calcula o desvio (realizado - cota)", inf.informed_total === 1800 && inf.variance_amount === 300 && Math.round(inf.variance_percent) === 20);
  check("Itens do fechamento gravados", inf.items.length === 1 && inf.items[0].payment_method === "pix");
  check("Status vira 'received' ao informar", inf.status === "received");
  const appr = RetailClosingService.setStatus(A, c1.id, "approved", "u1");
  check("Aprovação muda o status", appr.status === "approved");

  // ---- 3. Checklist diário ----
  const created = RetailTaskService.generateDay(A, DATE);
  check("generateDay cria 3 tipos × 2 lojas ativas = 6 tarefas", created === 6, String(created));
  check("Loja inativa não gera tarefa", RetailTaskService.listByDate(A, DATE).every((t: any) => t.store_id !== s3.id));
  check("generateDay é idempotente (2ª vez cria 0)", RetailTaskService.generateDay(A, DATE) === 0);
  const tasks = RetailTaskService.listByDate(A, DATE);
  check("Tipos gerados: fechamento/malote/escala", new Set(tasks.map((t: any) => t.task_type)).size === 3);
  const sub = RetailTaskService.markSubmitted(A, tasks[0].id, { contactId: "c1" });
  check("markSubmitted marca 'submitted'", sub.status === "submitted" && !!sub.submitted_at);

  // ---- 4. Pass do Scheduler ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  db.prepare(`UPDATE organization_settings SET retail_daily_closing_enabled=1 WHERE organization_id=?`).run(B);
  RetailStoreService.create(B, { name: "Loja B1" });
  Scheduler.retailDailyTasksPass();
  const todayStr = new Date().toISOString().slice(0, 10);
  check("Scheduler gera pendências da org opt-in", RetailTaskService.listByDate(B, todayStr).length === 1); // só fechamento ligado

  // ---- 5. Isolamento ----
  check("Isolamento: B não vê cotas/fechamentos de A", RetailQuotaService.listByDate(B, DATE).length === 0 && RetailClosingService.listByDate(B, DATE).length === 0);

  console.log("\n=== Retail Ops — Fase B: cotas + fechamento + checklist (ADR-083) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
