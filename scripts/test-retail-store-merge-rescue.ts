/**
 * TESTE — Resgate de órfãos de merge antigo (RetailStoreService.rescueMergeOrphans).
 *
 * Simula o estrago do merge ANTES da correção: loja duplicada já apagada do
 * cadastro, com escala/malote/cotas/vendas ainda apontando pro store_id
 * apagado, e o evento RETAIL_STORE_MERGED_DELETED no audit. O resgate deve
 * re-apontar tudo pra sobrevivente SEM apagar nada (conflito fica no lugar).
 *
 * Uso:  npm run test:retail-store-merge-rescue
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-rescue-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-rescue-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const T = RetailStoreService.create(A, { name: "Toulon Centro", code: "7" }).id;
  const Dold = randomUUID(); // loja duplicada JÁ apagada do cadastro (merge antigo)

  const ins = (sql: string, ...args: any[]) => db.prepare(sql).run(...args);
  // Órfãos apontando pro store_id apagado — o estrago do merge antigo.
  ins(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, '2026-09-16', 'mat:1', 'Ana', 'work')`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_schedule_entries (id, organization_id, store_id, work_date, seller_key, seller_name, status) VALUES (?, ?, ?, '2026-09-16', 'mat:2', 'Bia', 'off')`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_seller_off_pattern (id, organization_id, store_id, seller_key, seller_name, day_of_week) VALUES (?, ?, ?, 'mat:1', 'Ana', 1)`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_seller_store_assignments (id, organization_id, seller_id, store_id, active) VALUES (?, ?, ?, ?, 1)`, randomUUID(), A, randomUUID(), Dold);
  ins(`INSERT INTO retail_cash_deposits (id, organization_id, store_id, deposit_date, amount) VALUES (?, ?, ?, '2026-09-10', 150)`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_cash_day_override (id, organization_id, store_id, cash_date, amount) VALUES (?, ?, ?, '2026-09-11', 80)`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_cash_week_closings (id, organization_id, store_id, week_start, week_end, total_cash, total_deposited) VALUES (?, ?, ?, '2026-09-07', '2026-09-13', 500, 480)`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_boleta_days (id, organization_id, store_id, day, initial_number) VALUES (?, ?, ?, '2026-09-10', '017752')`, randomUUID(), A, Dold);
  // Cota semanal de vendedor: uma que move e uma que CONFLITA com a da sobrevivente.
  ins(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, 'mat:1', 'Ana', '2026-09-14', 2500)`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, 'mat:2', 'Bia', '2026-09-14', 1000)`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_seller_quotas (id, organization_id, store_id, seller_key, seller_name, week_start, quota_amount) VALUES (?, ?, ?, 'mat:2', 'Bia', '2026-09-14', 1800)`, randomUUID(), A, T);
  // Vendas por vendedor: manual (move), 'closing' sem conflito (move) e
  // 'closing' de dia que a sobrevivente também tem (FICA — mover dobraria).
  ins(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, valor, source) VALUES (?, ?, ?, '2026-09-08', 'Dani', 70, 'manual')`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, valor, source) VALUES (?, ?, ?, '2026-09-09', 'Ana', 200, 'closing')`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, valor, source) VALUES (?, ?, ?, '2026-09-10', 'Ana', 300, 'closing')`, randomUUID(), A, Dold);
  ins(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, valor, source) VALUES (?, ?, ?, '2026-09-10', 'Bia', 400, 'closing')`, randomUUID(), A, T);
  // O evento do merge antigo no audit (a chave do resgate).
  ins(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json) VALUES (?, ?, 'user1', ?, 'RETAIL_STORE_MERGED_DELETED', ?)`,
    randomUUID(), A, Dold, JSON.stringify({ name: "Toulon Centro (2)", into: T, intoName: "Toulon Centro" }));

  const count = (t: string, store: string, extra = "", ...args: any[]) =>
    Number((db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE organization_id = ? AND store_id = ? ${extra}`).get(A, store, ...args) as any)?.n || 0);

  // ===== 1. DRY-RUN: relata e NÃO altera nada =====
  const dry = RetailStoreService.rescueMergeOrphans({ organizationId: A });
  const m0 = dry.merges[0];
  check("1.1 dry-run acha o merge e a sobrevivente", dry.apply === false && m0?.status === "ok" && m0?.newId === T, JSON.stringify({ status: m0?.status }));
  check("1.2 dry-run conta os órfãos (>= 12)", Number(m0?.totalOrphans) >= 12, `${m0?.totalOrphans}`);
  check("1.3 dry-run não move nada", count("retail_schedule_entries", Dold) === 2 && count("retail_cash_deposits", Dold) === 1);

  // ===== 2. APPLY: re-aponta tudo que não conflita =====
  const ap = RetailStoreService.rescueMergeOrphans({ organizationId: A, apply: true });
  const m1 = ap.merges[0];
  check("2.1 escala resgatada (2 linhas na sobrevivente)", count("retail_schedule_entries", T) === 2 && count("retail_schedule_entries", Dold) === 0);
  check("2.2 template de folga + lotação resgatados", count("retail_seller_off_pattern", T) === 1 && count("retail_seller_store_assignments", T) === 1);
  check("2.3 malote resgatado (depósito + ajuste + semana fechada)", count("retail_cash_deposits", T) === 1 && count("retail_cash_day_override", T) === 1 && count("retail_cash_week_closings", T) === 1);
  check("2.4 boletas resgatadas", count("retail_boleta_days", T) === 1);
  check("2.5 cota de vendedor sem conflito resgatada (Ana)", count("retail_seller_quotas", T, "AND seller_key = 'mat:1'") === 1);

  // ===== 3. NADA é apagado: conflito fica no lugar =====
  check("3.1 cota conflitante (Bia) fica na órfã — não é apagada", count("retail_seller_quotas", Dold, "AND seller_key = 'mat:2'") === 1);
  check("3.2 cota da sobrevivente (Bia 1800) intacta", Number((db.prepare(`SELECT quota_amount q FROM retail_seller_quotas WHERE organization_id = ? AND store_id = ? AND seller_key = 'mat:2'`).get(A, T) as any)?.q) === 1800);
  check("3.3 venda 'closing' de dia conflitante fica na órfã (não dobra)", count("retail_seller_sales", Dold, "AND sale_date = '2026-09-10'") === 1);
  check("3.4 venda manual + 'closing' sem conflito movidas", count("retail_seller_sales", T, "AND seller_name = 'Dani'") === 1 && count("retail_seller_sales", T, "AND sale_date = '2026-09-09'") === 1);
  check("3.5 relatório: moved > 0 e leftover = conflitos (2)", Number(m1?.moved) >= 11 && Number(m1?.leftover) === 2, JSON.stringify({ moved: m1?.moved, leftover: m1?.leftover }));

  // ===== 4. Idempotência + audit do resgate =====
  const again = RetailStoreService.rescueMergeOrphans({ organizationId: A, apply: true });
  check("4.1 rodar de novo só encontra os conflitos deixados (2)", Number(again.merges[0]?.totalOrphans) === 2, `${again.merges[0]?.totalOrphans}`);
  check("4.2 resgate auditado (RETAIL_STORE_MERGE_RESCUED)", !!db.prepare(`SELECT 1 FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'RETAIL_STORE_MERGE_RESCUED'`).get(A));

  // ===== 5. Evento sem destino / destino inexistente → skip seguro =====
  ins(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json) VALUES (?, ?, 'user1', ?, 'RETAIL_STORE_MERGED_DELETED', '{}')`, randomUUID(), A, randomUUID());
  const withBad = RetailStoreService.rescueMergeOrphans({ organizationId: A });
  check("5.1 evento sem 'into' vira skip (não explode)", withBad.merges.some((m: any) => String(m.status).startsWith("skip")));

  console.log("\n=== TEST: Resgate de órfãos de merge antigo ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
