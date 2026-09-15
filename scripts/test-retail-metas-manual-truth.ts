/**
 * TESTE — Metas do vendedor: lançamento do gerente como VERDADE ÚNICA.
 * ------------------------------------------------------------------------------
 * Decisão do dono: o ranking que o GERENTE lança no fechamento é a verdade.
 * Dois comportamentos provados aqui:
 *   1) O ranking conta SEM depender de aprovar (submitDetailed já sincroniza) —
 *      mata o "modo manual zera até aprovar".
 *   2) Loja em modo `manual` conta SÓ o lançamento do gerente — PDV e ERP (re-
 *      contagens da mesma venda física) ficam de fora. Sem dobra.
 *
 * Uso:  npm run test:retail-metas-manual-truth
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-manual-truth-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-manual-truth-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number | null | undefined, b: number) => a != null && Math.abs(Number(a) - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService } = await import("../src/server/RetailOpsService.js");
  const { RetailCommissionRaceService: Race } = await import("../src/server/RetailCommissionRaceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const store = RetailStoreService.create(A, { name: "Loja Manual", code: "500" });
  // Modo MANUAL: a verdade é o lançamento do gerente.
  db.prepare(`UPDATE retail_stores SET seller_source = 'manual' WHERE id = ?`).run(store.id);
  // Vendedor cadastrado (o nome do ranking resolve pra matrícula 700).
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, '700', 'Marcos', 1)`).run(randomUUID(), A);

  const DATE = "2026-09-10";
  // MESMA venda física por 2 fontes automáticas do ERP (dobrariam no modo PDV):
  db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor_codigo, valor, pecas, status) VALUES (?, ?, '500', '0001', ?, '700', 5000, 5, 'N')`).run(randomUUID(), A, DATE);
  db.prepare(`INSERT INTO retail_erp_seller_sales (id, organization_id, store_id, filial, sale_date, matricula, seller_name, valor, pecas) VALUES (?, ?, ?, '500', ?, '700', 'Marcos', 5000, 5)`).run(randomUUID(), A, store.id, DATE);

  // Ranking do GERENTE (a verdade): Marcos = 3000. SEM aprovar o fechamento.
  RetailClosingService.submitDetailed(A, store.id, DATE, { dinheiro: 3000, ranking: [{ sellerName: "Marcos", valor: 3000, pecas: 3 }] });

  const sb = () => Race.sellerPeriodScoreboard(A, store.id, DATE).sellers.find((s: any) => s.matricula === "700" || s.sellerName === "Marcos");

  // 1) Modo MANUAL, SEM aprovar: conta só o ranking do gerente (3000).
  const m1 = sb();
  check("1.1 ranking conta SEM aprovar (mês = 3000)", near(m1?.month?.sales, 3000), JSON.stringify(m1?.month));
  check("1.2 fonte = só manual (3000), sem PDV nem ERP", near(m1?.month?.sources?.manual, 3000) && !m1?.month?.sources?.pdv && !m1?.month?.sources?.erp, JSON.stringify(m1?.month?.sources));
  check("1.3 sem dobra (doubled=false)", m1?.month?.doubled === false, `${m1?.month?.doubled}`);

  // 2) Modo PDV: a MESMA venda volta a dobrar (prova que o manual excluía PDV+ERP).
  db.prepare(`UPDATE retail_stores SET seller_source = 'pdv' WHERE id = ?`).run(store.id);
  const m2 = sb();
  check("2.1 modo PDV soma as 3 fontes (5000+5000+3000=13000)", near(m2?.month?.sales, 13000), JSON.stringify(m2?.month?.sources));
  check("2.2 modo PDV marca dobra (doubled=true)", m2?.month?.doubled === true, `${m2?.month?.doubled}`);

  // 3) Volta pra manual e EDITA o ranking (4000): reflete na hora (delete-then-insert).
  db.prepare(`UPDATE retail_stores SET seller_source = 'manual' WHERE id = ?`).run(store.id);
  RetailClosingService.submitDetailed(A, store.id, DATE, { dinheiro: 4000, ranking: [{ sellerName: "Marcos", valor: 4000, pecas: 4 }] });
  const m3 = sb();
  check("3.1 editar o ranking reflete na hora (mês = 4000)", near(m3?.month?.sales, 4000), JSON.stringify(m3?.month));

  // 4) Isolamento.
  let iso = false;
  try { iso = Race.sellerPeriodScoreboard(B, store.id, DATE).sellers.length === 0; } catch { iso = true; }
  check("4.1 isolamento: org B não vê a loja de A", iso);

  console.log("\n=== TEST: Metas — lançamento do gerente como verdade única ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
