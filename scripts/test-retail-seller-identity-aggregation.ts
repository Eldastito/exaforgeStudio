/**
 * TESTE — PRD Fase 1, F1.1b: agregações de venda/comissão/corrida/ranking pela identidade canônica
 * Prova: fundir "LOHAN" em "Lohan Grande Rio" UNIFICA a pessoa em salesBySellerStore, combinedSalesBySeller,
 * networkTopSellers e na corrida (cota cadastrada na matrícula antiga continua valendo); o TOTAL
 * de comissão NÃO muda (só o agrupamento); o fallback de comissão por loja continua casando com a linha
 * canônica (chaves dos 2 caminhos alinhadas); desfazer a fusão separa de novo; org sem alias/fusão recebe
 * exatamente o de antes; Vinícius Romão ≠ Nascimento nunca se somam; isolamento multi-tenant.
 * Uso:  npm run test:retail-seller-identity-aggregation
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-agg-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-seller-agg-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number) => Math.abs(a - b) < 0.005;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailSellerIdentityService: S } = await import("../src/server/RetailSellerIdentityService.js");
  const { RetailCommissionService: C } = await import("../src/server/RetailCommissionService.js");
  const { RetailCommissionRaceService: R } = await import("../src/server/RetailCommissionRaceService.js");
  const { RetailSellerSalesService: SS } = await import("../src/server/RetailSellerSalesService.js");

  const P0 = "2026-09-01", P1 = "2026-09-30";
  const A = `org_A_${randomUUID().slice(0, 6)}`, B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const o of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), o);
  const store = (org: string, name: string, code: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code) VALUES (?, ?, ?, ?)`).run(id, org, name, code); return id; };
  const seller = (org: string, mat: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name) VALUES (?, ?, ?, ?)`).run(id, org, mat, name); return id; };
  const pdv = (org: string, filial: string, cod: string, valor: number, pecas: number, date = "2026-09-10") =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, valor, pecas, status, vendedor_codigo) VALUES (?, ?, ?, ?, ?, ?, ?, 'N', ?)`).run(randomUUID(), org, filial, randomUUID().slice(0, 8), date, valor, pecas, cod);
  const manual = (org: string, storeId: string, name: string, mat: string | null, valor: number, pecas: number) =>
    db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas) VALUES (?, ?, ?, '2026-09-10', ?, ?, ?, ?)`).run(randomUUID(), org, storeId, name, mat, valor, pecas);

  const carioca = store(A, "Carioca", "1002");
  const lohanA = seller(A, "1002-LG", "Lohan Grande Rio");
  const lohanB = seller(A, "1002-LX", "LOHAN");
  const ana = seller(A, "A1", "Ana");
  const vRomao = seller(A, "1002-VR", "Vinícius Romão"), vNasc = seller(A, "1002-VN", "Vinícius Nascimento");
  pdv(A, "1002", "1002-LG", 300, 2); pdv(A, "1002", "1002-LX", 200, 1); pdv(A, "1002", "A1", 400, 3);
  pdv(A, "1002", "1002-VR", 90, 1); pdv(A, "1002", "1002-VN", 60, 1);
  // regra de comissão da LOJA: 10% (o fallback por loja é o caminho que precisa alinhar as chaves dos 2 fluxos)
  C.createRule(A, { name: "10% loja", scope: "store", calculationType: "percent_sales", config: { percent: 10 }, storeId: carioca } as any);

  const rowsOf = (org: string, name: RegExp) => C.salesBySellerStore(org, P0, P1).filter((r: any) => name.test(r.sellerName));
  const combinedOf = (org: string, name: RegExp) => C.combinedSalesBySeller(org, P0, P1).filter((r: any) => name.test(r.sellerName));

  // ── ANTES da fusão: 2 pessoas distintas (baseline = comportamento de sempre) ──
  const before = C.salesBySellerStore(A, P0, P1).filter((r: any) => /lohan/i.test(r.sellerName));
  check("antes: Lohan Grande Rio (300) e LOHAN (200) são linhas separadas", before.length === 2 && before.some((r: any) => r.sales === 300) && before.some((r: any) => r.sales === 200));
  check("antes: nenhuma linha carrega aliasKeys (org sem aliases/fusões → 0-regressão por construção)", C.salesBySellerStore(A, P0, P1).every((r: any) => r.aliasKeys === undefined));
  const totalBefore = C.createRun(A, P0, P1, "u-owner");
  const sumBefore = Number(totalBefore.total_commission);
  const reportBefore: any = C.report(A, P0, P1);
  const combBefore = combinedOf(A, /lohan/i);
  check("antes: combinedSalesBySeller também separa as duas", combBefore.length === 2);
  const commLohanBefore = reportBefore.bySeller.filter((s: any) => /lohan/i.test(s.sellerName)).reduce((a: number, s: any) => a + s.commission, 0);
  check("antes: comissão por vendedor sai do 10% da loja (30 + 20 = 50)", near(commLohanBefore, 50), `got ${commLohanBefore}`);

  // ── corrida ANTES: cota cadastrada na matrícula ANTIGA (LOHAN 1002-LX) ──
  R.setSellerQuotas(A, carioca, "2026-09-06", [{ sellerKey: "mat:1002-LX", sellerName: "LOHAN", amount: 1000 }], "u-owner");

  // ── FUSÃO ──
  S.mergeSellers(A, lohanB, lohanA, "u-owner");
  const after = C.salesBySellerStore(A, P0, P1).filter((r: any) => /lohan/i.test(r.sellerName));
  check("depois: UMA linha da pessoa (Lohan Grande Rio) com 300 + 200 = 500", after.length === 1 && near(after[0].sales, 500) && after[0].sellerName === "Lohan Grande Rio" && after[0].matricula === "1002-LG", JSON.stringify(after.map((r: any) => [r.sellerName, r.sales])));
  check("depois: peças somadas (2 + 1 = 3) e aliasKeys guardam as chaves antigas", after[0].pecas === 3 && after[0].aliasKeys.includes("mat:1002-LX") && after[0].aliasKeys.includes("nom:lohan"));
  const combAfter = combinedOf(A, /lohan/i);
  check("depois: combinedSalesBySeller também unifica (500, 1 linha)", combAfter.length === 1 && near(combAfter[0].sales, 500));
  const reportAfter: any = C.report(A, P0, P1);
  const lohanRep = reportAfter.bySeller.filter((s: any) => /lohan/i.test(s.sellerName));
  check("depois: comissão do fallback por loja casa com a linha CANÔNICA (10% de 500 = 50) — chaves dos 2 caminhos alinhadas", lohanRep.length === 1 && near(lohanRep[0].commission, 50), JSON.stringify(lohanRep.map((s: any) => [s.sellerName, s.commission])));
  const runAfter = C.createRun(A, P0, P1, "u-owner");
  check("INVARIANTE DE DINHEIRO: total de comissão do período NÃO muda com a fusão (só o agrupamento)", near(Number(runAfter.total_commission), sumBefore), `${runAfter.total_commission} vs ${sumBefore}`);
  const itemsLohan = (runAfter.items || []).filter((i: any) => /lohan/i.test(i.seller_name || i.sellerName || ""));
  check("depois: itens do run têm UM item do Lohan (não dois)", itemsLohan.length === 1, `n=${itemsLohan.length}`);

  // ── outras pessoas não são tocadas ──
  const anaAfter = rowsOf(A, /^Ana$/);
  check("Ana (sem fusão) segue igual e sem aliasKeys", anaAfter.length === 1 && anaAfter[0].sales === 400 && anaAfter[0].aliasKeys === undefined);
  const vin = C.salesBySellerStore(A, P0, P1).filter((r: any) => /Vin/i.test(r.sellerName));
  check("Vinícius Romão (90) e Vinícius Nascimento (60) NUNCA se somam", vin.length === 2 && vin.some((r: any) => r.sales === 90) && vin.some((r: any) => r.sales === 60));

  // ── corrida: cota cadastrada na matrícula ANTIGA continua valendo ──
  const race: any = R.raceMonth(A, "2026-09");
  const wk = race.stores.find((s: any) => s.storeName === "Carioca").weeks.find((w: any) => w.start === "2026-09-06");
  const lohanRace = wk.sellers.filter((s: any) => /lohan/i.test(s.sellerName));
  check("corrida: UMA linha do Lohan na semana, com as vendas unificadas", lohanRace.length === 1 && near(lohanRace[0].sales, 500), JSON.stringify(lohanRace.map((s: any) => [s.sellerName, s.sales, s.quota])));
  check("corrida: cota cadastrada na matrícula ANTIGA (1002-LX) continua casando com a pessoa (explicit 1000)", lohanRace[0].quota === 1000 && lohanRace[0].quotaSource === "explicit");
  const sb: any = R.sellerPeriodScoreboard(A, carioca, "2026-09-10");
  check("placar do período: 1 linha do Lohan", sb.sellers.filter((s: any) => /lohan/i.test(s.sellerName)).length === 1);

  // ── ranking da rede (lançamento manual) ──
  manual(A, carioca, "Lohan Grande Rio", "1002-LG", 50, 1); manual(A, carioca, "LOHAN", "1002-LX", 70, 2);
  const top = SS.networkTopSellers(A, P0, P1, 10);
  check("ranking da rede: uma linha Lohan com 50 + 70 = 120", top.filter((t: any) => /lohan/i.test(t.sellerName)).length === 1 && near(top.find((t: any) => /lohan/i.test(t.sellerName))!.sales, 120), JSON.stringify(top));

  // ── desfazer a fusão separa de novo (reversível) ──
  S.unmerge(A, lohanB, "u-owner");
  const undone = C.salesBySellerStore(A, P0, P1).filter((r: any) => /lohan/i.test(r.sellerName));
  check("desfazer fusão: voltam 2 linhas (300+50 e 200+70, com o manual) e sem aliasKeys", undone.length === 2 && undone.some((r: any) => r.sales === 350) && undone.some((r: any) => r.sales === 270) && undone.every((r: any) => r.aliasKeys === undefined), JSON.stringify(undone.map((r: any) => [r.sellerName, r.sales, r.aliasKeys])));
  check("desfazer fusão: ranking volta a separar", SS.networkTopSellers(A, P0, P1, 10).filter((t: any) => /lohan/i.test(t.sellerName)).length === 2);

  // ── alias confirmado (sem fusão): CAI_USUARIO extra aponta pra mesma pessoa ──
  pdv(A, "1002", "CAI-EDU-7", 80, 1);
  S.addAlias(A, ana, { alias: "CAI-EDU-7", kind: "cai_usuario" }, "u-owner");
  const anaAlias = rowsOf(A, /^Ana$/);
  check("alias de CAI_USUARIO confirmado: as vendas do código entram na Ana (400 + 80)", anaAlias.length === 1 && near(anaAlias[0].sales, 480), JSON.stringify(anaAlias.map((r: any) => r.sales)));

  // ── isolamento e 0-regressão em outra org ──
  const carB = store(B, "Carioca B", "1002");
  seller(B, "1002-LG", "Lohan Grande Rio"); seller(B, "1002-LX", "LOHAN");
  pdv(B, "1002", "1002-LG", 300, 2); pdv(B, "1002", "1002-LX", 200, 1);
  const rowsB = C.salesBySellerStore(B, P0, P1).filter((r: any) => /lohan/i.test(r.sellerName));
  check("isolamento: org B (sem fusão) segue com 2 linhas, sem aliasKeys, mesmo com a org A configurada", rowsB.length === 2 && rowsB.every((r: any) => r.aliasKeys === undefined) && carB.length > 0);
  check("isolamento: cota da org A não aparece na B", R.listSellerQuotas(B, carB, ["2026-09-06"]).length === 0);

  console.log("\n=== PRD Fase 1 · F1.1b: agregações pela identidade canônica ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
