/**
 * TESTE — Vendas por VENDEDOR lançadas à mão / por foto (Cenário B).
 *
 * Quando o ERP não traz o vendedor por venda, a loja anota no papel e o gestor
 * lança (digitando ou enviando a foto p/ a IA ler). Prova:
 *   - bulkCreate grava as linhas válidas (nome + valor/peças) e ignora as vazias;
 *   - bySeller consolida por vendedor (nome) somando valor e peças;
 *   - combinedSalesBySeller SOMA ZappFlow + manual no mesmo vendedor;
 *   - a comissão por vendedor (report + run) apura sobre o total combinado;
 *   - extractFromImage (extrator injetado) devolve linhas p/ conferência, sem salvar;
 *   - isolado por org.
 *
 * Uso:  npm run test:retail-seller-sales-manual
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-seller-sales-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-seller-sales-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

const P0 = "2000-01-01", P1 = "2100-01-01";

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { OrdersService } = await import("../src/server/OrdersService.js");
  const { RetailCommissionService } = await import("../src/server/RetailCommissionService.js");
  const { RetailSellerSalesService, __setSellerSalesExtractorForTests } = await import("../src/server/RetailSellerSalesService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);
  const U1 = randomUUID();
  db.prepare(`INSERT INTO users (id, organization_id, name, email) VALUES (?, ?, 'Ana', ?)`).run(U1, A, `ana_${U1.slice(0, 6)}@x.com`);
  const PA = randomUUID();
  db.prepare(`INSERT INTO products_services (id, organization_id, type, name, price, active, stock_control_enabled) VALUES (?, ?, 'product', 'Camisa', 100, 1, 0)`).run(PA, A);
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja Centro', '01', 1)`).run(store, A);

  // ===== bulkCreate: 2 válidas + 1 vazia (ignorada) =====
  const created = RetailSellerSalesService.bulkCreate(A, {
    storeId: store, saleDate: "2025-05-10", source: "manual",
    entries: [
      { sellerName: "Ana", valor: 200, pecas: 4 },
      { sellerName: "Bruno", valor: 300, pecas: 6 },
      { sellerName: "", valor: 0, pecas: 0 },        // ignorada (sem nome/valor)
    ],
  }, U1);
  check("bulkCreate grava 2 linhas válidas e ignora a vazia", created.length === 2, JSON.stringify(created.map(c => c.seller_name)));

  // ===== bySeller consolida por vendedor (soma) =====
  RetailSellerSalesService.bulkCreate(A, { saleDate: "2025-05-11", entries: [{ sellerName: "Ana", valor: 100, pecas: 2 }] }, U1);
  const bySeller = RetailSellerSalesService.bySeller(A, P0, P1);
  const ana = bySeller.find(s => s.sellerName === "Ana");
  check("bySeller: Ana soma 200+100 = 300", ana?.sales === 300, JSON.stringify(bySeller));
  check("bySeller: Ana soma peças 4+2 = 6", ana?.pecas === 6, JSON.stringify(ana));
  check("bySeller: Bruno 300", bySeller.find(s => s.sellerName === "Bruno")?.sales === 300);

  // ===== combinedSalesBySeller SOMA ZappFlow + manual (mesmo nome, "Ana") =====
  // Ana também é usuária do ZappFlow (U1, nome "Ana") — venda de 500 lá.
  OrdersService.createOrder(A, { items: [{ productId: PA, name: "x", unitPrice: 0, quantity: 5 }], sellerUserId: U1, autoClose: true });
  const combined = RetailCommissionService.combinedSalesBySeller(A, P0, P1);
  const anaC = combined.find(s => s.sellerName === "Ana");
  check("combined: Ana = 300 (manual) + 500 (ZappFlow) = 800", anaC?.sales === 800, JSON.stringify(combined));
  check("combined: Ana source = manual+zappflow", anaC?.source === "manual+zappflow", anaC?.source);
  check("combined: Ana peças = 6 (só manual traz peças)", anaC?.pecas === 6);

  // ===== comissão por vendedor apura sobre o combinado =====
  RetailCommissionService.createRule(A, { name: "Vendedor 10%", scope: "seller", calculationType: "percent_sales", config: { percent: 10 } });
  const report = RetailCommissionService.report(A, P0, P1);
  const anaR = (report.bySeller || []).find((s: any) => s.sellerName === "Ana");
  check("report: Ana comissão 10% de 800 = 80", Number(anaR?.commission) === 80, JSON.stringify(report.bySeller));
  const brunoR = (report.bySeller || []).find((s: any) => s.sellerName === "Bruno");
  check("report: Bruno comissão 10% de 300 = 30", Number(brunoR?.commission) === 30);

  const run = RetailCommissionService.createRun(A, P0, P1);
  const runAna = run.items.find((i: any) => i.seller_name === "Ana");
  check("run: item de Ana base 800 / comissão 80", Number(runAna?.base_amount) === 800 && Number(runAna?.commission_amount) === 80, JSON.stringify(run.items.map((i: any) => ({ n: i.seller_name, b: i.base_amount, c: i.commission_amount }))));

  // ===== extractFromImage: extrator injetado; devolve linhas, NÃO salva =====
  __setSellerSalesExtractorForTests(async () => JSON.stringify({ vendedores: [{ nome: "Carla", valor: 150.5, pecas: 3 }, { nome: "", valor: null, pecas: null }], confidence: 92 }));
  const beforeCount = RetailSellerSalesService.list(A, P0, P1).length;
  const extracted = await RetailSellerSalesService.extractFromImage("Zm9v", "image/jpeg");
  check("extractFromImage: 1 linha legível (a vazia é descartada)", extracted.entries.length === 1 && extracted.entries[0].sellerName === "Carla", JSON.stringify(extracted));
  check("extractFromImage: confiança alta não pede revisão", extracted.needsReview === false && extracted.confidence === 92);
  check("extractFromImage NÃO salva nada", RetailSellerSalesService.list(A, P0, P1).length === beforeCount);
  __setSellerSalesExtractorForTests(null);

  // ===== update: edita nome, valor e peças de um lançamento =====
  const brunoRow = RetailSellerSalesService.list(A, P0, P1).find(x => x.seller_name === "Bruno");
  const upd = RetailSellerSalesService.update(A, brunoRow.id, { sellerName: "Bruno Silva", valor: 450, pecas: 9 }, U1);
  check("update: aplica nome/valor/peças", upd?.seller_name === "Bruno Silva" && Number(upd?.valor) === 450 && Number(upd?.pecas) === 9, JSON.stringify(upd));
  const afterUpd = RetailSellerSalesService.bySeller(A, P0, P1).find(s => s.sellerName === "Bruno Silva");
  check("update: agregação reflete o novo valor (450)", afterUpd?.sales === 450, JSON.stringify(afterUpd));
  check("update: linha vazia (valor 0 + peças 0) é rejeitada", (() => { try { RetailSellerSalesService.update(A, brunoRow.id, { valor: 0, pecas: 0 }); return false; } catch { return true; } })());
  check("update: nome em branco é rejeitado", (() => { try { RetailSellerSalesService.update(A, brunoRow.id, { sellerName: "  " }); return false; } catch { return true; } })());
  check("update: id inexistente devolve null", RetailSellerSalesService.update(A, "nao-existe", { valor: 10 }) === null);
  // patch parcial não zera os outros campos
  const upd2 = RetailSellerSalesService.update(A, brunoRow.id, { valor: 500 }, U1);
  check("update parcial: só valor muda, peças/nome mantêm", Number(upd2?.valor) === 500 && Number(upd2?.pecas) === 9 && upd2?.seller_name === "Bruno Silva", JSON.stringify(upd2));

  // ===== remove =====
  const first = RetailSellerSalesService.list(A, P0, P1)[0];
  check("remove: apaga o lançamento", RetailSellerSalesService.remove(A, first.id, U1) === true);
  check("remove: some da lista", !RetailSellerSalesService.list(A, P0, P1).some(x => x.id === first.id));

  // ===== isolamento =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  check("isolamento: org B sem lançamentos", RetailSellerSalesService.bySeller(B, P0, P1).length === 0);

  console.log("\n=== Vendas por vendedor manual/foto (Cenário B) ===");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
