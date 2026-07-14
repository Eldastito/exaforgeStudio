/**
 * TESTE — ADR-083 Fase E: conciliação de vendas (Fechamento de Caixa Alterdata)
 * ----------------------------------------------------------------------------
 * Prova, offline, com o formato REAL do export do PdvUP/Alterdata:
 *   - parse: extrai loja, data (DD/MM/AAAA→AAAA-MM-DD) e venda líquida (R$ pt-BR);
 *   - casa a loja pelo número do nome fantasia / código;
 *   - grava system_total e calcula a divergência (informado − sistema);
 *   - loja não cadastrada entra em 'unmatched'; isolamento por org.
 *
 * Uso:  npm run test:retail-reconciliation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-recon-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-recon-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

// Fixture no formato real do Alterdata (2 lojas): 159 (cadastrada) e 999 (não).
const CSV = [
  `"Fechamento de Caixa - Diário","13/07/2026  20:39:29",1,"Período das Vendas : 13/07/2026 Até 13/07/2026",,"Lojas :"," 159 - FR CARIOCA SHOP","Valor Saída Bruta:","R$ 2.368,60","Desconto (-) :","R$ 125,27","Valor Saída Líquida (=) :","R$ 2.253,33","Valor Total de Peças Vendidas : ","R$ 2.253,33"`,
  `"Fechamento de Caixa - Diário","13/07/2026  20:39:29",1,"Período das Vendas : 13/07/2026 Até 13/07/2026",,"Lojas :"," 159 - FR CARIOCA SHOP","Valor Saída Bruta:","R$ 2.368,60","Desconto (-) :","R$ 125,27","Valor Saída Líquida (=) :","R$ 2.253,33","Valor Total de Peças Vendidas : ","R$ 2.253,33"`,
  `"Fechamento de Caixa - Diário","13/07/2026  20:39:29",1,"Período das Vendas : 13/07/2026 Até 13/07/2026",,"Lojas :"," 999 - LOJA FANTASMA","Valor Saída Bruta:","R$ 500,00","Desconto (-) :","R$ 0,00","Valor Saída Líquida (=) :","R$ 500,00"`,
].join("\n");

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailReconciliationService } = await import("../src/server/RetailReconciliationService.js");

  // ---- Parse ----
  const recs = RetailReconciliationService.parseAlterdataCaixaDiario(CSV);
  check("Dedup por (loja, dia): 2 registros (159 e 999)", recs.length === 2);
  const r159 = recs.find((r: any) => r.lojaCode === "159");
  check("Parse: data 13/07/2026 → 2026-07-13", r159?.date === "2026-07-13");
  check("Parse: venda líquida R$ 2.253,33 → 2253.33", r159?.systemTotal === 2253.33);

  // ---- Import + conciliação ----
  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const s1 = RetailStoreService.create(A, { name: "FR Carioca Shop", code: "159" });
  // A loja informou 2300 (diverge dos 2253,33 do sistema).
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-13', 'received', 2300)`).run(randomUUID(), A, s1.id);

  const rep = RetailReconciliationService.importCaixaDiario(A, CSV, {}, "u1");
  check("Import: 1 loja casada, 1 não casada (999)", rep.matched === 1 && rep.unmatched.includes("999 - LOJA FANTASMA"));
  const row = db.prepare(`SELECT system_total, informed_total, divergence_status FROM retail_daily_closings WHERE organization_id=? AND store_id=? AND closing_date='2026-07-13'`).get(A, s1.id) as any;
  check("Gravou system_total = 2253.33", Number(row.system_total) === 2253.33);
  check("Divergência detectada (informado 2300 × sistema 2253,33)", row.divergence_status === "divergent" && rep.divergences === 1);
  const res159 = rep.results.find((r: any) => r.storeId === s1.id);
  check("Divergência = 2300 − 2253,33 = 46,67", Math.abs(res159.divergence - 46.67) < 0.001);

  // ---- Isolamento ----
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const repB = RetailReconciliationService.importCaixaDiario(B, CSV, {}, "u1");
  check("Isolamento: org B sem lojas → nada casado", repB.matched === 0);

  console.log("\n=== ADR-083 Fase E: conciliação de vendas (Alterdata) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
