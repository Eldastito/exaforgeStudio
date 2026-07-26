/**
 * TESTE — Vendas por VENDEDOR vindas do ERP (Cenário A — FUNDAÇÃO, sync OFF).
 *
 * A fatia entrega a base: tabela, mapper defensivo, ingest idempotente e a
 * agregação — a fonte já entra no merge de comissão, mas o SYNC real do endpoint
 * do ERP só é ligado quando o payload estiver confirmado. Prova:
 *   - mapErpRow lê nomes de campo variados (matricula/valor/comissao/pecas) e
 *     descarta linha sem identidade ou sem números;
 *   - ingest é idempotente (mesma chave → upsert, não duplica);
 *   - bySeller agrega valor + comissão do ERP; resolve nome pela matrícula;
 *   - combinedSalesBySeller SOMA ERP + manual + ZappFlow na base e carrega a
 *     erpCommission (comissão já calculada pelo ERP);
 *   - report: nossas regras apuram sobre a base combinada; erpCommission e
 *     hasErpSellerSales aparecem para conferência;
 *   - isolado por org.
 *
 * Uso:  npm run test:retail-erp-seller-sales
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-erp-seller-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-erp-seller-sales-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const P0 = "2000-01-01", P1 = "2100-01-01";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const { RetailSellerSalesService } = await import("../src/server/RetailSellerSalesService.js");
  const { RetailErpSellerSalesService } = await import("../src/server/RetailErpSellerSalesService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const U1 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, A, `ana_${U1.slice(0, 6)}@x.com`);
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja Centro', '01', 1)`).run(store, A);
  // Mapeia a matrícula 100 → usuária Ana (para reconciliar ERP com ZappFlow).
  db.prepare(`INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id, active) VALUES (?, ?, '100', 'Ana', ?, 1)`).run(randomUUID(), A, U1);

  // ===== mapErpRow: nomes de campo variados =====
  const m1 = RetailErpSellerSalesService.mapErpRow({ matricula: "100", nome: "Ana", filial: "01", data: "2025-06-01", valorVendido: 1000, pecas: 20, comissao: 55.5 }, "2025-06-30");
  check("mapErpRow: mapeia matrícula/valor/comissão/peças", !!m1 && m1!.matricula === "100" && m1!.valor === 1000 && m1!.comissaoErp === 55.5 && m1!.pecas === 20, JSON.stringify(m1));
  const m2 = RetailErpSellerSalesService.mapErpRow({ codVendedor: "200", nomeVendedor: "Bruno", totalVendido: 500, valorComissao: 25 }, "2025-06-30");
  check("mapErpRow: aceita codVendedor/nomeVendedor/totalVendido/valorComissao + data default", !!m2 && m2!.matricula === "200" && m2!.valor === 500 && m2!.comissaoErp === 25 && m2!.saleDate === "2025-06-30", JSON.stringify(m2));
  check("mapErpRow: descarta linha sem identidade", RetailErpSellerSalesService.mapErpRow({ valor: 100 }, "2025-06-30") === null);
  check("mapErpRow: descarta linha sem nenhum número", RetailErpSellerSalesService.mapErpRow({ matricula: "300", nome: "Zé" }, "2025-06-30") === null);

  // ===== ingest idempotente =====
  const rows = [m1!, m2!];
  check("ingest grava 2 linhas", RetailErpSellerSalesService.ingest(A, rows, U1) === 2);
  RetailErpSellerSalesService.ingest(A, rows, U1); // repete a mesma carga
  const totalRows = (db.prepare(`SELECT COUNT(*) AS n FROM retail_erp_seller_sales WHERE organization_id = ?`).get(A) as any).n;
  check("ingest idempotente: reingestão não duplica (2 linhas)", totalRows === 2, `linhas=${totalRows}`);
  const anaRow = db.prepare(`SELECT store_id FROM retail_erp_seller_sales WHERE organization_id = ? AND matricula = '100'`).get(A) as any;
  check("ingest resolve store_id pela filial 01", anaRow?.store_id === store, JSON.stringify(anaRow));

  // ===== bySeller agrega valor + comissão do ERP =====
  const erpBy = RetailErpSellerSalesService.bySeller(A, P0, P1);
  const erpAna = erpBy.find(s => s.matricula === "100");
  check("bySeller ERP: Ana valor 1000 / comissão 55.5 / user resolvido", erpAna?.sales === 1000 && erpAna?.erpCommission === 55.5 && erpAna?.sellerUserId === U1, JSON.stringify(erpBy));
  check("bySeller ERP: Bruno (matrícula 200, sem mapeamento) nome do payload", erpBy.find(s => s.matricula === "200")?.sellerName === "Bruno");

  // ===== combinedSalesBySeller SOMA as três fontes =====
  // Ana também vende 500 no ZappFlow (mesmo userId) e 200 no manual (mesmo nome).
  OrdersService.createOrder(A, { items: [{ productId: (() => { const p = randomUUID(); db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0)`).run(p, A); return p; })(), name: "x", unitPrice: 0, quantity: 5 }], sellerUserId: U1, autoClose: true });
  RetailSellerSalesService.bulkCreate(A, { saleDate: "2025-06-15", entries: [{ sellerName: "Ana", valor: 200, pecas: 4 }] }, U1);
  const combined = RetailCommissionService.combinedSalesBySeller(A, P0, P1);
  const cAna = combined.find(s => s.sellerName === "Ana");
  check("combined: Ana base = 1000 (ERP) + 500 (ZappFlow) + 200 (manual) = 1700", cAna?.sales === 1700, JSON.stringify(combined));
  check("combined: Ana erpCommission = 55.5 (só o ERP traz)", cAna?.erpCommission === 55.5);
  check("combined: Ana source tem as 3 fontes", cAna?.source === "erp+manual+zappflow", cAna?.source);

  // ===== report: nossas regras sobre a base combinada + conferência ERP =====
  RetailCommissionService.createRule(A, { name: "Vendedor 10%", scope: "seller", calculationType: "percent_sales", config: { percent: 10 } });
  const report = RetailCommissionService.report(A, P0, P1);
  const rAna = (report.bySeller || []).find((s: any) => s.sellerName === "Ana");
  check("report: Ana comissão nossa 10% de 1700 = 170", Number(rAna?.commission) === 170, JSON.stringify(report.bySeller));
  check("report: Ana erpCommission 55.5 (divergência visível)", Number(rAna?.erpCommission) === 55.5);
  check("report: hasErpSellerSales = true", report.hasErpSellerSales === true);
  check("report: totals.sellerErpCommission soma 55.5 + 25 = 80.5", Number(report.totals?.sellerErpCommission) === 80.5, JSON.stringify(report.totals));

  // ===== isolamento =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("isolamento: org B sem linhas do ERP", RetailErpSellerSalesService.bySeller(B, P0, P1).length === 0);
  check("isolamento: report B não marca ERP", RetailCommissionService.report(B, P0, P1).hasErpSellerSales === false);

  console.log("\n=== Vendas por vendedor do ERP (Cenário A — fundação) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
