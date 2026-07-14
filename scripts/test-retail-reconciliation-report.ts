/**
 * TESTE — ADR-083 Fase E: painel de conciliação (divergências do mês)
 * ------------------------------------------------------------------
 * Prova, offline, a visão das divergências:
 *   - só entram fechamentos JÁ conciliados (system_total > 0);
 *   - informado × sistema × divergência por loja/dia;
 *   - resumo (conciliados, divergentes, R$ de divergência, total do sistema);
 *   - filtro onlyDivergent; isolamento por org.
 *
 * Uso:  npm run test:retail-reconciliation-report
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-recon-rep-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-recon-rep-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailReconciliationService } = await import("../src/server/RetailReconciliationService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const s1 = RetailStoreService.create(A, { name: "Loja 1" });
  const s2 = RetailStoreService.create(A, { name: "Loja 2" });

  const closing = (store: string, date: string, informed: number, system: number, status: string | null) =>
    db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total, divergence_status) VALUES (?, ?, ?, ?, 'received', ?, ?, ?)`)
      .run(randomUUID(), A, store, date, informed, system, status);
  closing(s1.id, "2026-07-13", 2300, 2253.33, "divergent"); // divergência 46,67
  closing(s2.id, "2026-07-13", 1000, 1000, "ok");           // bateu
  closing(s1.id, "2026-07-14", 500, 0, null);               // NÃO conciliado (system 0) → fora

  const rep = RetailReconciliationService.report(A, "2026-07");
  check("Só conciliados entram (2 de 3; o sem system_total fica fora)", rep.summary.reconciledCount === 2);
  check("Conta 1 divergência", rep.summary.divergentCount === 1);
  check("R$ de divergência = 46,67", rep.summary.totalDivergenceBRL === 46.67);
  check("Total do sistema = 2253,33 + 1000 = 3253,33", rep.summary.systemTotalBRL === 3253.33);
  const d = rep.rows.find((r: any) => r.storeId === s1.id && r.date === "2026-07-13");
  check("Linha da divergência traz informado/sistema/divergência", d.informed === 2300 && d.system === 2253.33 && Math.abs(d.divergence - 46.67) < 0.001 && d.status === "divergent");

  const onlyDiv = RetailReconciliationService.report(A, "2026-07", true);
  check("onlyDivergent traz só a divergência", onlyDiv.rows.length === 1 && onlyDiv.rows[0].status === "divergent");

  // Isolamento
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("Isolamento: org B vem vazia", RetailReconciliationService.report(B, "2026-07").summary.reconciledCount === 0);

  console.log("\n=== ADR-083 Fase E: painel de conciliação (divergências) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
