/**
 * TESTE — Comissão POR VENDEDOR vira o oficial quando só há regra "por loja".
 * ---------------------------------------------------------------------------
 * Cenário do gestor (homologação Toulon / ADR-105): as vendas por vendedor
 * chegam pelo PDV (VendaMalote → CAI_USUARIO em `retail_pdv_sales`), mas a única
 * regra ativa foi criada com escopo "por loja". Antes, a seção "Por vendedor"
 * saía vazia ("Sem regra por vendedor ativa") e o total mostrava R$ 0,00 por
 * vendedor — mesmo com as vendas do PDV cheias.
 *
 * Decisão do gestor: "por vendedor vira o oficial". Prova que:
 *   - a comissão por vendedor sai por FALLBACK da % da regra da loja, sobre o
 *     que cada vendedor vendeu no PDV (CAI_USUARIO);
 *   - a linha "por loja" vira REFERÊNCIA e NÃO soma no total (não paga em dobro);
 *   - o total do período passa a ser a soma por vendedor;
 *   - com uma regra própria por vendedor, as duas voltam a somar (distintas);
 *   - createRun (apuração persistida) segue a mesma regra (loja = comissão 0).
 *
 * Uso:  npm run test:retail-commission-seller-fallback
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-fallback-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-fallback-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const P0 = "2000-01-01", P1 = "2100-01-01";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const store = RetailStoreService.create(A, { name: "Loja 1", code: "1" });
  // Fechamento da loja = 1000 → base da linha "por loja".
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-15', 'approved', 1000)`).run(randomUUID(), A, store.id);

  // Vendas do PDV por VENDEDOR (CAI_USUARIO): V1 = 600, V2 = 400.
  const sale = (boleta: string, vendedorCodigo: string, valor: number, pecas: number) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, usuario, vendedor_codigo, valor, pecas, status)
      VALUES (?, ?, '1', ?, '2026-07-10', 'OP1', ?, ?, ?, ?, 'N')`).run(randomUUID(), A, boleta, vendedorCodigo, vendedorCodigo, valor, pecas);
  sale("b1", "V1", 400, 4); sale("b2", "V1", 200, 2); sale("b3", "V2", 400, 3);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'V1', 'Ana Vendedora')`).run(randomUUID(), A);

  // Única regra ativa: "por loja" 5%.
  const storeRule = RetailCommissionService.createRule(A, { name: "Comissão de vendedores", scope: "store", calculationType: "percent_sales", config: { percent: 5 } });

  const rep = RetailCommissionService.report(A, P0, P1);
  const v1 = rep.bySeller.find((x: any) => x.sellerName === "Ana Vendedora");
  const v2 = rep.bySeller.find((x: any) => x.sellerName === "Matrícula V2");
  check("Por vendedor preenche do PDV: V1 = 600 (2 vendas, 6 peças)", v1?.sales === 600 && v1?.orders === 2 && v1?.pecas === 6, JSON.stringify(v1));
  check("V1 tem nome do mapeamento (Ana Vendedora)", v1?.sellerName === "Ana Vendedora");
  check("Comissão por vendedor = 5% do que cada um vendeu (V1 = 30, V2 = 20)", v1?.commission === 30 && v2?.commission === 20, JSON.stringify([v1, v2]));
  check("sellerCommissionSource = store_fallback, percent = 5", rep.sellerCommissionSource === "store_fallback" && rep.sellerCommissionPercent === 5, JSON.stringify(rep.sellerCommissionSource));
  check("totais vendedor = 50 (30+20)", rep.totals.sellerCommission === 50, JSON.stringify(rep.totals));
  check("linha por loja EXISTE como referência (comissão 50)", rep.byStore.find((x: any) => x.storeId === store.id)?.commission === 50 && rep.storeIsReference === true, JSON.stringify(rep.totals));
  check("TOTAL = só por vendedor (50), loja NÃO soma (não paga em dobro)", rep.totals.totalCommission === 50, JSON.stringify(rep.totals));

  // Apuração persistida segue a mesma regra: loja vira comissão 0, vendedor paga.
  const run = RetailCommissionService.createRun(A, P0, P1);
  const storeItems = run.items.filter((i: any) => i.store_id);
  const sellerItems = run.items.filter((i: any) => !i.store_id && i.seller_name && i.commission_amount > 0);
  check("createRun: itens por loja viram referência (comissão 0)", storeItems.length > 0 && storeItems.every((i: any) => Number(i.commission_amount) === 0), JSON.stringify(storeItems.map((i: any) => i.commission_amount)));
  check("createRun: itens por vendedor pagam (soma 50)", Math.round(sellerItems.reduce((a: number, i: any) => a + Number(i.commission_amount), 0)) === 50);
  check("createRun: total_commission = 50", Math.round(Number(run.total_commission)) === 50, String(run.total_commission));

  // Com regra PRÓPRIA por vendedor (10%), as duas passam a somar (distintas).
  RetailCommissionService.createRule(A, { name: "V 10%", scope: "seller", calculationType: "percent_sales", config: { percent: 10 } });
  const rep2 = RetailCommissionService.report(A, P0, P1);
  check("Com regra por vendedor: comissão vendedor = 10% (V1 = 60)", rep2.bySeller.find((x: any) => x.sellerName === "Ana Vendedora")?.commission === 60, JSON.stringify(rep2.totals));
  check("Com regra própria por vendedor, loja NÃO é mais referência", rep2.storeIsReference === false && rep2.sellerCommissionSource === "seller_rule");
  check("Total soma vendedor(100) + loja(50) = 150", rep2.totals.totalCommission === 150, JSON.stringify(rep2.totals));

  // Isolamento.
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const repB = RetailCommissionService.report(B, P0, P1);
  check("Isolamento: org B vazio", repB.bySeller.length === 0 && repB.totals.totalCommission === 0);

  console.log("\n=== Comissão por vendedor vira o oficial (fallback da regra da loja) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
