/**
 * TESTE — Loja com `seller_source='manual'`: PDV genérico FICA DE FORA da
 * comissão por vendedor, lançamento manual vira a fonte de verdade.
 * ---------------------------------------------------------------------------
 * Contexto: o dono da Toulon percebeu (com razão) que o mesmo "vendedor"
 * (CAI_USUARIO) aparecendo em várias lojas com valores altos em cada uma é
 * suspeito — não uma prova de que o dado está certo. Investigação confirmou:
 * o agrupamento por loja/vendedor está correto, mas o campo que a Alterdata
 * manda como CAI_USUARIO pode ser um código ÚNICO/compartilhado pra loja
 * inteira (login/terminal), não o vendedor real — a mesma "anomalia do
 * vendedor" já vista antes com a matrícula do operador.
 *
 * Solução SEM depender da Alterdata: o gestor cadastra os vendedores no
 * ZappFlow e lança as vendas de cada um no fechamento diário de caixa
 * (retail_seller_sales, manual ou foto+IA — fluxo que já existe). Pra essa
 * loja fazer sentido, o PDV (com o código genérico que enxergaria TUDO como
 * "1 vendedor só") precisa ficar de fora da atribuição por vendedor — senão a
 * mesma venda contaria duas vezes (uma pelo PDV genérico, outra pelo
 * lançamento manual real). Por isso a loja tem uma flag EXPLÍCITA
 * (`retail_stores.seller_source = 'manual'`), decidida pelo gestor — não uma
 * inferência automática por coincidência de data (evita apagar PDV bom de
 * lojas onde CAI_USUARIO individualiza certo).
 *
 * Este teste prova, numa loja "Nova Iguaçu" marcada `seller_source: 'manual'`:
 *   - o PDV genérico dela (1 código, toda a venda do dia) NÃO aparece em
 *     `pdvSalesBySeller`/`salesBySellerStore`/`storeSellerExtract` — nem
 *     conta na comissão por vendedor (createRun/report);
 *   - o lançamento manual da mesma loja/dia aparece normalmente e vira a
 *     comissão oficial daquele vendedor;
 *   - uma loja SEM a flag (Av. Brasil) continua usando o PDV normalmente —
 *     a mudança não afeta lojas onde o CAI_USUARIO individualiza de verdade;
 *   - o total da LOJA (via fechamento, `report().byStore`) não muda com a
 *     flag — ela só afeta a atribuição por VENDEDOR, não o total da loja.
 *
 * Uso:  npm run test:retail-commission-store-seller-manual-override
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comm-manual-override-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comm-manual-override-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailSellerSalesService } = await import("../src/server/RetailSellerSalesService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  // Nova Iguaçu: marcada como "usa lançamento manual" — o gestor já decidiu
  // que o PDV dela não individualiza vendedor de verdade.
  const nova = RetailStoreService.create(A, { name: "Nova Iguaçu", code: "9", sellerSource: "manual" });
  // Av. Brasil: sem a flag — continua confiando no PDV normalmente.
  const avBrasil = RetailStoreService.create(A, { name: "Av. Brasil", code: "1" });

  const sale = (filial: string, boleta: string, vendCod: string, date: string, valor: number, pecas: number) =>
    db.prepare(`INSERT INTO retail_pdv_sales (id, organization_id, filial, boleta, sale_date, vendedor, usuario, vendedor_codigo, valor, pecas, status)
      VALUES (?, ?, ?, ?, ?, 'OP1', ?, ?, ?, ?, 'N')`).run(randomUUID(), A, filial, boleta, date, vendCod, vendCod, valor, pecas);

  // Nova Iguaçu: PDV com 1 código genérico ("V-UNICO") pra TODAS as vendas —
  // a anomalia. R$1000 no total, se contasse, contaminaria a comissão.
  sale("9", "n1", "V-UNICO", "2026-07-05", 600, 6);
  sale("9", "n2", "V-UNICO", "2026-07-06", 400, 4);
  // Nova Iguaçu: lançamento MANUAL real, feito no fechamento de caixa — 2
  // vendedores de verdade, valores que somam o que a loja realmente vendeu.
  RetailSellerSalesService.bulkCreate(A, {
    storeId: nova.id, saleDate: "2026-07-05",
    entries: [{ sellerName: "Marcos", matricula: "M1", valor: 350, pecas: 4 }, { sellerName: "Bia", matricula: "M2", valor: 250, pecas: 2 }],
  });
  RetailSellerSalesService.bulkCreate(A, {
    storeId: nova.id, saleDate: "2026-07-06",
    entries: [{ sellerName: "Marcos", matricula: "M1", valor: 400, pecas: 4 }],
  });

  // Av. Brasil: PDV com 2 códigos reais (sem flag manual) — comportamento normal.
  sale("1", "a1", "V1", "2026-07-05", 300, 3);
  sale("1", "a2", "V2", "2026-07-05", 200, 2);

  // Fechamento de loja (base do report()/createRun() por LOJA) — Nova Iguaçu
  // vendeu R$1000 no total (bate com PDV+manual reconciliados, não importa).
  db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total) VALUES (?, ?, ?, '2026-07-05', 'approved', 1000)`).run(randomUUID(), A, nova.id);

  const P0 = "2026-07-01", P1 = "2026-07-31";

  // ── pdvSalesBySeller: Nova Iguaçu (manual) some, Av. Brasil continua ──────
  const pdvBySeller = RetailCommissionService.pdvSalesBySeller(A, P0, P1);
  check("pdvSalesBySeller: código genérico 'V-UNICO' da loja manual NÃO aparece", !pdvBySeller.some((r: any) => r.matricula === "V-UNICO"), JSON.stringify(pdvBySeller));
  check("pdvSalesBySeller: Av. Brasil (V1/V2) continua aparecendo normalmente", pdvBySeller.some((r: any) => r.matricula === "V1") && pdvBySeller.some((r: any) => r.matricula === "V2"), JSON.stringify(pdvBySeller));

  // ── salesBySellerStore: mesma coisa, com a dimensão de loja ───────────────
  const bySS = RetailCommissionService.salesBySellerStore(A, P0, P1);
  check("salesBySellerStore: PDV genérico de Nova Iguaçu NÃO aparece", !bySS.some((r: any) => r.storeId === nova.id && r.source.includes("pdv") && r.matricula === "V-UNICO"), JSON.stringify(bySS.filter((r: any) => r.storeId === nova.id)));
  const marcosNova = bySS.find((r: any) => r.storeId === nova.id && r.sellerName === "Marcos");
  check("salesBySellerStore: Marcos (manual) aparece em Nova Iguaçu com 750 (350+400)", marcosNova?.sales === 750 && marcosNova?.source === "manual", JSON.stringify(marcosNova));
  const biaNova = bySS.find((r: any) => r.storeId === nova.id && r.sellerName === "Bia");
  check("salesBySellerStore: Bia (manual) aparece em Nova Iguaçu com 250", biaNova?.sales === 250, JSON.stringify(biaNova));
  check("salesBySellerStore: Av. Brasil continua com PDV normal (V1=300, V2=200)", bySS.some((r: any) => r.storeId === avBrasil.id && r.matricula === "V1" && r.sales === 300) && bySS.some((r: any) => r.storeId === avBrasil.id && r.matricula === "V2" && r.sales === 200), JSON.stringify(bySS.filter((r: any) => r.storeId === avBrasil.id)));

  // ── storeSellerExtract: totais da loja batem com o manual, não com PDV+manual somados ──
  const exNova = RetailCommissionService.storeSellerExtract(A, P0, P1, { storeId: nova.id });
  check("storeSellerExtract: Nova Iguaçu total = 1000 (só o manual, PDV genérico excluído)", exNova.totals.sales === 1000, JSON.stringify(exNova.totals));
  check("storeSellerExtract: Nova Iguaçu tem 2 vendedores (Marcos+Bia), não 3", exNova.sellers.length === 2, JSON.stringify(exNova.sellers.map((s: any) => s.sellerName)));

  // ── report()/createRun(): total da LOJA (fechamento) não muda com a flag ──
  const rep = RetailCommissionService.report(A, P0, P1);
  const repNova = rep.byStore.find((s: any) => s.storeId === nova.id);
  check("report(): total da loja (fechamento) = 1000, a flag não mexe nisso", repNova?.sales === 1000, JSON.stringify(repNova));
  const repMarcos = rep.bySeller.find((s: any) => s.sellerName === "Marcos");
  check("report(): bySeller Marcos = 750 (só o manual, sem duplicar com o PDV genérico)", repMarcos?.sales === 750, JSON.stringify(repMarcos));

  // ── Isolamento ─────────────────────────────────────────────────────────────
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const exB = RetailCommissionService.storeSellerExtract(B, P0, P1);
  check("Isolamento: org B extrato vazio", exB.sellers.length === 0);

  console.log("\n=== Loja seller_source='manual' — PDV genérico fica de fora da comissão ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
