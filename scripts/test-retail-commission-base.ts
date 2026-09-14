/**
 * TESTE — Base de meta/comissão = venda REAL do PDV (system_total) c/ fallback
 * ----------------------------------------------------------------------------
 * O fechamento tem `informed_total` (o que a loja lançou) e `system_total` (a
 * venda real do PDV/Alterdata). Meta e comissão passam a usar
 * COALESCE(NULLIF(system_total,0), informed_total) — a venda real quando existe,
 * o informado quando não há PDV. Antes usavam só o informado → não batia quando
 * a loja lançava valor diferente do PDV. Prova a expressão e a diferença.
 *
 * Uso:  npm run test:retail-commission-base
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-base-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-base-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  // Fiação: os serviços de comissão/meta importam.
  await import("../src/server/RetailCommissionService.js");
  await import("../src/server/RetailCommissionRaceService.js");

  const org = `org_${randomUUID().slice(0, 8)}`;
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, active) VALUES (?, ?, 'Carioca', 1)`).run(store, org);
  const mk = (date: string, informed: number, system: number, status = "received") =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), org, store, date, status, informed, system);

  mk("2026-09-15", 100, 150);              // loja informou MENOS que o PDV → usa 150
  mk("2026-09-16", 200, 0);                // só informado (sem PDV) → usa 200
  mk("2026-09-17", 0, 300);               // só PDV → usa 300
  mk("2026-09-18", 999, 999, "rejected"); // rejeitado não conta

  const VAL = "COALESCE(NULLIF(system_total,0), informed_total)";
  const real = Number((db.prepare(`SELECT COALESCE(SUM(${VAL}),0) AS s FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND status != 'rejected'`).get(org, store) as any).s);
  const oldInformed = Number((db.prepare(`SELECT COALESCE(SUM(informed_total),0) AS s FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND status != 'rejected'`).get(org, store) as any).s);

  check("1 base real = 150 + 200 + 300", real === 650, String(real));
  check("2 base antiga (só informado) = 300 → é onde não batia", oldInformed === 300, String(oldInformed));
  check("3 base real ignora rejeitado", real === 650);
  check("4 dia divergente usa o PDV (150, não 100)", Number((db.prepare(`SELECT ${VAL} AS v FROM retail_daily_closings WHERE organization_id=? AND closing_date='2026-09-15'`).get(org) as any).v) === 150);
  check("5 dia sem PDV usa o informado (200)", Number((db.prepare(`SELECT ${VAL} AS v FROM retail_daily_closings WHERE organization_id=? AND closing_date='2026-09-16'`).get(org) as any).v) === 200);

  console.log("\n=== TEST: Base de meta/comissão = venda real do PDV ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
