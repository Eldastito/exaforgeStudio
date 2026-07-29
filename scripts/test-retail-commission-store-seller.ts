/**
 * TESTE — Comissão individualizada por LOJA e por VENDEDOR (pedido Toulon).
 * ---------------------------------------------------------------------------
 * O dono das lojas da Toulon precisa: (1) saber quanto cada vendedor vendeu
 * por loja, (2) rodar um "comando" (a tela) e gerar quanto cada vendedor da
 * Loja X vai receber de comissão — o mesmo pra Loja Y, Z, W — com o percentual
 * de CADA loja definido por ele, e (3) o gerente escolher loja + vendedor e ver
 * quanto o vendedor acumulou ATÉ uma data qualquer (ex.: dia 15, antes do
 * fechamento do mês em 30/31).
 *
 * Prova:
 *   - salesBySellerStore separa a MESMA pessoa em uma linha POR loja onde
 *     vendeu (não funde Loja A com Loja B);
 *   - regra de comissão pode mirar UMA loja específica (store_id) com um %
 *     próprio; sem regra específica, cai na regra de rede (store_id NULL);
 *   - storeSellerExtract aplica o % EFETIVO de cada loja a cada vendedor,
 *     filtra por loja/vendedor, e soma totais por loja e geral;
 *   - período parcial (1º ao dia 15) traz só o acumulado até ali — prova o
 *     caso do vendedor Marcos perguntando "quanto já tenho até o dia 15";
 *   - report()/createRun() (rede) também respeitam a precedência por loja:
 *     loja com regra específica usa a SUA %, sem pagar a regra de rede de novo;
 *   - isolamento multi-tenant.
 *
 * Uso:  npm run test:retail-commission-store-seller
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-store-seller-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-store-seller-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const lojaX = RetailStoreService.create(A, { name: "Loja X", code: "1" });
  const lojaY = RetailStoreService.create(A, { name: "Loja Y", code: "2" });

  const sale = (boleta: string, filial: string, vendedorCodigo: string, date: string, valor: number, pecas: number) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, usuario, vendedor_codigo, valor, pecas, status)
      VALUES (?, ?, ?, ?, ?, 'OP1', ?, ?, ?, ?, 'N')`).run(randomUUID(), A, filial, boleta, date, vendedorCodigo, vendedorCodigo, valor, pecas);

  // Marcos (matrícula M1) vende nas DUAS lojas; outro vendedor (M2) só na Loja Y.
  sale("b1", "1", "M1", "2026-07-05", 400, 4);
  sale("b2", "1", "M1", "2026-07-12", 200, 2); // Marcos, Loja X, ainda dentro do 1º-15
  sale("b3", "1", "M1", "2026-07-20", 900, 9); // Marcos, Loja X, DEPOIS do dia 15
  sale("b4", "2", "M1", "2026-07-08", 300, 3); // Marcos, Loja Y
  sale("b5", "2", "M2", "2026-07-10", 500, 5); // outro vendedor, só Loja Y
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M1', 'Marcos')`).run(randomUUID(), A);
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, 'M2', 'Bia')`).run(randomUUID(), A);

  // Fechamentos das lojas (base do report()/createRun() de REDE, que apura por
  // `retail_daily_closings` — diferente do extrato por vendedor, que usa o PDV).
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-15', 'approved', 1000)`).run(randomUUID(), A, lojaX.id);
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-15', 'approved', 2000)`).run(randomUUID(), A, lojaY.id);

  // Regras: Loja X tem % PRÓPRIO (7%); Loja Y usa a regra de REDE (5%).
  const ruleX = RetailCommissionService.createRule(A, { name: "Loja X 7%", scope: "store", calculationType: "percent_sales", config: { percent: 7 }, storeId: lojaX.id });
  const ruleNet = RetailCommissionService.createRule(A, { name: "Rede 5%", scope: "store", calculationType: "percent_sales", config: { percent: 5 } });

  // ── salesBySellerStore: Marcos aparece em DUAS linhas (uma por loja) ──────
  const P0 = "2026-07-01", P1 = "2026-07-31";
  const bySS = RetailCommissionService.salesBySellerStore(A, P0, P1);
  const marcosX = bySS.find((r: any) => r.sellerName === "Marcos" && r.storeId === lojaX.id);
  const marcosY = bySS.find((r: any) => r.sellerName === "Marcos" && r.storeId === lojaY.id);
  check("Marcos na Loja X = 1500 (3 vendas, 15 peças)", marcosX?.sales === 1500 && marcosX?.orders === 3 && marcosX?.pecas === 15, JSON.stringify(marcosX));
  check("Marcos na Loja Y = 300 (1 venda, separado da Loja X)", marcosY?.sales === 300 && marcosY?.orders === 1, JSON.stringify(marcosY));
  check("Bia só aparece na Loja Y (500)", bySS.some((r: any) => r.sellerName === "Bia" && r.storeId === lojaY.id && r.sales === 500));
  check("Bia NÃO aparece na Loja X", !bySS.some((r: any) => r.sellerName === "Bia" && r.storeId === lojaX.id));

  // ── storeSellerExtract: % efetivo por loja (Loja X = 7%, Loja Y = 5%) ─────
  const ex = RetailCommissionService.storeSellerExtract(A, P0, P1);
  const exMarcosX = ex.sellers.find((s: any) => s.sellerName === "Marcos" && s.storeId === lojaX.id);
  const exMarcosY = ex.sellers.find((s: any) => s.sellerName === "Marcos" && s.storeId === lojaY.id);
  check("Extrato: Marcos Loja X = 7% de 1500 = 105", exMarcosX?.commission === 105 && exMarcosX?.commissionPercent === 7, JSON.stringify(exMarcosX));
  check("Extrato: Marcos Loja Y = 5% de 300 = 15 (regra de rede)", exMarcosY?.commission === 15 && exMarcosY?.commissionPercent === 5, JSON.stringify(exMarcosY));
  check("Extrato: fonte da comissão distingue loja específica x rede", exMarcosX?.commissionSource === "store_specific_rule" && exMarcosY?.commissionSource === "store_network_rule");
  const totalGeral = round2(105 + 15 + 500 * 0.05);
  check("Extrato: total geral soma todo mundo", ex.totals.commission === totalGeral, JSON.stringify(ex.totals));

  // Filtro por loja: só Loja X (Marcos, 1 linha).
  const exX = RetailCommissionService.storeSellerExtract(A, P0, P1, { storeId: lojaX.id });
  check("Filtro por loja X: só Marcos aparece, comissão 105", exX.sellers.length === 1 && exX.sellers[0].commission === 105, JSON.stringify(exX.sellers));

  // Filtro por loja + vendedor: "o gerente seleciona a loja e o vendedor e roda".
  const key = exMarcosX!.sellerKey;
  const exOne = RetailCommissionService.storeSellerExtract(A, P0, P1, { storeId: lojaX.id, sellerKey: key });
  check("Filtro loja+vendedor: 1 linha, Marcos/LojaX/105", exOne.sellers.length === 1 && exOne.sellers[0].commission === 105);

  // ── Vendedor pergunta "quanto acumulei até o dia 15?" (mês fecha dia 31) ──
  const ate15 = RetailCommissionService.storeSellerExtract(A, "2026-07-01", "2026-07-15", { storeId: lojaX.id, sellerKey: key });
  check("Até dia 15: só as duas vendas de antes (400+200=600), comissão 42", ate15.sellers[0]?.sales === 600 && ate15.sellers[0]?.commission === 42, JSON.stringify(ate15.sellers));
  const mesTodo = RetailCommissionService.storeSellerExtract(A, "2026-07-01", "2026-07-31", { storeId: lojaX.id, sellerKey: key });
  check("Mês todo (após fechamento): as 3 vendas (1500), comissão 105 — maior que até dia 15", mesTodo.sellers[0]?.commission === 105 && mesTodo.sellers[0]!.commission > ate15.sellers[0]!.commission);

  // ── byStore do extrato bate com os totais por loja ────────────────────────
  const byStoreX = ex.byStore.find((s: any) => s.storeId === lojaX.id);
  const byStoreY = ex.byStore.find((s: any) => s.storeId === lojaY.id);
  check("byStore Loja X: vendas 1500, comissão 105", byStoreX?.sales === 1500 && byStoreX?.commission === 105, JSON.stringify(byStoreX));
  check("byStore Loja Y: vendas 800 (300+500), comissão 40", byStoreY?.sales === 800 && byStoreY?.commission === 40, JSON.stringify(byStoreY));

  // ── report() de rede também respeita a precedência por loja (fechamentos) ─
  const rep = RetailCommissionService.report(A, P0, P1);
  const repX = rep.byStore.find((s: any) => s.storeId === lojaX.id);
  const repY = rep.byStore.find((s: any) => s.storeId === lojaY.id);
  check("report(): Loja X usa a PRÓPRIA regra (7% de 1000 = 70), não soma com a de rede", repX?.commission === 70, JSON.stringify(repX));
  check("report(): Loja Y usa a regra de REDE (5% de 2000 = 100)", repY?.commission === 100, JSON.stringify(repY));
  const repMarcos = rep.bySeller.find((s: any) => s.sellerName === "Marcos");
  const repBia = rep.bySeller.find((s: any) => s.sellerName === "Bia");
  check("report(): bySeller Marcos = 120 (105 na Loja X + 15 na Loja Y, taxa de cada loja)", repMarcos?.commission === 120, JSON.stringify(repMarcos));
  check("report(): bySeller Bia = 25 (5% de 500 na Loja Y)", repBia?.commission === 25, JSON.stringify(repBia));
  check("report(): sellerCommissionSource = store_fallback_mixed (lojas com % diferentes)", rep.sellerCommissionSource === "store_fallback_mixed" && rep.storeIsReference === true, rep.sellerCommissionSource);
  check("report(): total = 145 (por vendedor oficial; loja é referência, não soma)", rep.totals.totalCommission === 145, JSON.stringify(rep.totals));

  // ── createRun(): "por vendedor vira o oficial" (decisão prévia do gestor),
  // agora respeitando o % EFETIVO de cada loja no fallback (não mais uma % plana).
  // Como não há regra de escopo "vendedor", a comissão migra pra cada vendedor
  // (Marcos: 105 na Loja X + 15 na Loja Y = 120; Bia: 25 na Loja Y) e as linhas
  // por loja (fechamentos) viram REFERÊNCIA — comissão 0 — pra não pagar 2x.
  const run = RetailCommissionService.createRun(A, P0, P1);
  const itemsLojaX = run.items.filter((i: any) => i.store_id === lojaX.id);
  const itemsLojaY = run.items.filter((i: any) => i.store_id === lojaY.id);
  check("createRun: Loja X vira referência (comissão 0)", itemsLojaX.length === 1 && Number(itemsLojaX[0].commission_amount) === 0, JSON.stringify(itemsLojaX));
  check("createRun: Loja Y vira referência (comissão 0)", itemsLojaY.length === 1 && Number(itemsLojaY[0].commission_amount) === 0, JSON.stringify(itemsLojaY));
  const itemMarcos = run.items.find((i: any) => i.seller_name === "Marcos");
  const itemBia = run.items.find((i: any) => i.seller_name === "Bia");
  check("createRun: Marcos paga 120 (105 na Loja X + 15 na Loja Y, taxas corretas por loja)", Math.round(Number(itemMarcos?.commission_amount)) === 120, JSON.stringify(itemMarcos));
  check("createRun: Bia paga 25 (5% de 500 na Loja Y)", Math.round(Number(itemBia?.commission_amount)) === 25, JSON.stringify(itemBia));
  check("createRun: total_commission = 145 (120+25)", Math.round(Number(run.total_commission)) === 145, String(run.total_commission));

  // ── Isolamento ─────────────────────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const exB = RetailCommissionService.storeSellerExtract(B, P0, P1);
  check("Isolamento: org B extrato vazio", exB.sellers.length === 0 && exB.totals.commission === 0);

  function round2(n: number) { return Math.round(n * 100) / 100; }

  console.log("\n=== Comissão individualizada por loja e vendedor (pedido Toulon) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
