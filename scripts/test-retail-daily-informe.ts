/**
 * TESTE — Informe Diário da rede (INFORME-001).
 *
 * Pedido do lojista (padrão do "Informe Diário" do Brunno): por loja
 * (dinheiro, venda, cota, bateu/faltou, cota do dia seguinte) MAIS o TOTAL da
 * empresa, com o total ABERTO por forma de pagamento (dinheiro, PIX e cartão
 * por bandeira) pra facilitar a conferência. Loja sem fechamento aparece com
 * venda 0.
 *
 * Uso:  npm run test:retail-daily-informe
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-informe-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-informe-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number, b: number) => Math.abs(Number(a) - b) < 0.02;

const DATE = "2026-08-29", NEXT = "2026-08-30";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailClosingService, RetailQuotaService } = await import("../src/server/RetailOpsService.js");
  const { RetailDashboardService } = await import("../src/server/RetailDashboardService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const avBrasil = RetailStoreService.create(A, { name: "Av Brasil", code: "1" }).id;
  const carioca = RetailStoreService.create(A, { name: "Carioca", code: "2" }).id;
  const grandeRio = RetailStoreService.create(A, { name: "Grande Rio", code: "3" }).id;

  // Cotas do dia (snapshot vem daqui no getOrCreate) e do dia seguinte.
  RetailQuotaService.set(A, { storeId: avBrasil, quotaDate: DATE, quotaAmount: 5500 });
  RetailQuotaService.set(A, { storeId: carioca, quotaDate: DATE, quotaAmount: 3800 });
  RetailQuotaService.set(A, { storeId: grandeRio, quotaDate: DATE, quotaAmount: 5500 });
  RetailQuotaService.set(A, { storeId: carioca, quotaDate: NEXT, quotaAmount: 1200 });
  RetailQuotaService.set(A, { storeId: grandeRio, quotaDate: NEXT, quotaAmount: 2500 });
  // avBrasil sem cota amanhã → 0.

  // Fechamentos detalhados (dinheiro + cartão por bandeira).
  RetailClosingService.submitDetailed(A, avBrasil, DATE, { dinheiro: 410.10, credito: { Master: 2000, Visa: 3000 }, debito: { Eletron: 646 } });
  RetailClosingService.submitDetailed(A, grandeRio, DATE, { dinheiro: 33.90, credito: { Master: 1000 }, debito: { Redshop: 500 } });
  // Carioca: NÃO fecha → venda 0.

  const inf = RetailDashboardService.dailyInforme(A, DATE);
  const byId = new Map<string, any>(inf.stores.map((s: any) => [s.storeId, s]));
  const av: any = byId.get(avBrasil), ca: any = byId.get(carioca), gr: any = byId.get(grandeRio);

  // ===== 1. por loja =====
  check("1.1 todas as 3 lojas ativas aparecem", inf.stores.length === 3, `${inf.stores.length}`);
  check("1.2 Av Brasil venda = 6056,10 (410,10+5000+646)", !!av && near(av.venda, 6056.10), `${av?.venda}`);
  check("1.3 Av Brasil dinheiro = 410,10", !!av && near(av.dinheiro, 410.10), `${av?.dinheiro}`);
  check("1.4 Av Brasil cota = 5500", !!av && near(av.cota, 5500), `${av?.cota}`);
  check("1.5 Av Brasil BATEU (desvio +556,10)", !!av && near(av.desvio, 556.10), `${av?.desvio}`);
  check("1.6 Av Brasil cota de amanhã = 0", !!av && near(av.cotaNext, 0), `${av?.cotaNext}`);
  check("1.7 Carioca SEM fechamento → venda 0", !!ca && near(ca.venda, 0) && ca.hasClosing === false, `${ca?.venda}`);
  check("1.8 Carioca FALTOU (desvio -3800)", !!ca && near(ca.desvio, -3800), `${ca?.desvio}`);
  check("1.9 Carioca cota de amanhã = 1200", !!ca && near(ca.cotaNext, 1200), `${ca?.cotaNext}`);
  check("1.10 Grande Rio venda = 1533,90", !!gr && near(gr.venda, 1533.90), `${gr?.venda}`);

  // ===== 2. total da empresa =====
  check("2.1 total venda = 7590 (6056,10+1533,90)", near(inf.total.venda, 7590), `${inf.total.venda}`);
  check("2.2 total cota = 14800 (5500+3800+5500)", near(inf.total.cota, 14800), `${inf.total.cota}`);
  check("2.3 total desvio = -7210", near(inf.total.desvio, -7210), `${inf.total.desvio}`);
  check("2.4 total dinheiro = 444 (410,10+33,90)", near(inf.total.dinheiro, 444), `${inf.total.dinheiro}`);
  check("2.5 total cota de amanhã = 3700 (1200+2500)", near(inf.total.cotaNext, 3700), `${inf.total.cotaNext}`);

  // ===== 3. total ABERTO por forma de pagamento (a conferência) =====
  const bm = inf.total.byMethod;
  check("3.1 crédito Master somado = 3000 (2000+1000)", near(bm.credito.Master, 3000), `${bm.credito.Master}`);
  check("3.2 crédito Visa = 3000", near(bm.credito.Visa, 3000), `${bm.credito.Visa}`);
  check("3.3 débito Eletron = 646", near(bm.debito.Eletron, 646), `${bm.debito.Eletron}`);
  check("3.4 débito Redshop = 500", near(bm.debito.Redshop, 500), `${bm.debito.Redshop}`);
  check("3.5 total crédito = 6000", near(bm.totalCredito, 6000), `${bm.totalCredito}`);
  check("3.6 total débito = 1146", near(bm.totalDebito, 1146), `${bm.totalDebito}`);
  // Bate a identidade: dinheiro + crédito + débito = venda total (sem PIX aqui).
  check("3.7 dinheiro+crédito+débito = venda total", near(bm.dinheiro + bm.totalCredito + bm.totalDebito, 7590), `${bm.dinheiro + bm.totalCredito + bm.totalDebito}`);

  // ===== 4. dia seguinte calculado certo =====
  check("4.1 nextDate = 30/08", inf.nextDate === NEXT, inf.nextDate);

  console.log("\n=== TEST: Informe Diário da rede ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
