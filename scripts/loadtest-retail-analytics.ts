/**
 * LOAD TEST — telas analíticas de varejo em volume representativo (PDR TOULON,
 * §12.3 / Fatia 4E). NÃO é um teste de CI (prefixo `loadtest:`, fora do matrix
 * `test:*`): é um harness manual para medir, com volume ≥ ao da TOULON, que as
 * consultas otimizadas (4A–4C) rodam rápido e a aplicação de preço em lote
 * (PERF-008) escala.
 *
 * Semeia N lojas × N produtos × N itens de PDV + fechamentos, resolve o catálogo
 * (backfill), e cronometra:
 *   - backfill de resolução (PERF-001);
 *   - Resultado da Rede set-based (PERF-003);
 *   - CMV agregado por loja (PERF-002/003/004);
 *   - lista de precificação;
 *   - aplicação de preço em lote de 500 (PERF-008).
 *
 * Volume por env: STORES, PRODUCTS, ITEMS (defaults representativos).
 *
 * Uso:  npm run loadtest:retail-analytics
 *       STORES=8 PRODUCTS=10000 ITEMS=120000 npm run loadtest:retail-analytics
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-loadtest-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "loadtest-secret-1234567890";

const N_STORES = Math.max(1, Number(process.env.STORES) || 5);
const N_PRODUCTS = Math.max(1, Number(process.env.PRODUCTS) || 5000);
const N_ITEMS = Math.max(1, Number(process.env.ITEMS) || 60000);
const BUDGET_MS = Number(process.env.BUDGET_MS) || 3000; // orçamento por consulta

function timeIt<T>(label: string, fn: () => T): { label: string; ms: number; value: T } {
  const t0 = process.hrtime.bigint();
  const value = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms, value };
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailStoreCostService } = await import("../src/server/RetailStoreCostService.js");
  const { RetailPricingService } = await import("../src/server/RetailPricingService.js");
  const { RetailPdvCatalogResolver } = await import("../src/server/RetailPdvCatalogResolver.js");

  const org = `org_load_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Load', 'active')`).run(randomUUID(), org);

  const period = new Date().toISOString().slice(0, 7);
  console.log(`\nSemeando: ${N_STORES} lojas × ${N_PRODUCTS} produtos × ${N_ITEMS} itens de PDV…`);

  const stores: any[] = [];
  for (let i = 0; i < N_STORES; i++) {
    const s = RetailStoreService.create(org, { name: `Loja ${i + 1}`, code: String(10 + i) });
    RetailStoreService.update(org, s.id, { grossMarginPercent: 55 });
    stores.push(s);
  }

  // Catálogo + estoque com custo (external_ref = "P<i>").
  const refs: string[] = [];
  const seedCatalog = db.transaction(() => {
    const insP = db.prepare(`INSERT INTO products_services (id, organization_id, name, type, active, external_ref, price) VALUES (?, ?, ?, 'product', 1, ?, ?)`);
    const insInv = db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, 0, ?)`);
    for (let i = 0; i < N_PRODUCTS; i++) {
      const id = randomUUID(); const ref = `P${i}`; refs.push(ref);
      insP.run(id, org, `Produto ${i}`, ref, 50 + (i % 50));
      insInv.run(randomUUID(), org, id, 20 + (i % 30)); // custo conhecido
    }
  });
  seedCatalog();

  // Itens de PDV distribuídos por loja/dia/produto.
  const seedItems = db.transaction(() => {
    const ins = db.prepare(`INSERT INTO retail_pdv_sale_items (id, organization_id, filial, boleta, sale_date, item_seq, produto, quantidade, valor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (let i = 0; i < N_ITEMS; i++) {
      const st = stores[i % N_STORES];
      const day = String((i % 27) + 1).padStart(2, "0");
      ins.run(randomUUID(), org, st.code, `B${i}`, `${period}-${day}`, (i % 5) + 1, refs[i % N_PRODUCTS], (i % 3) + 1, 50 + (i % 100));
    }
  });
  seedItems();

  // Fechamentos (faturamento) por loja/dia.
  const seedClosings = db.transaction(() => {
    const ins = db.prepare(`INSERT INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, informed_total, system_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`);
    for (const st of stores) for (let d = 1; d <= 27; d++) ins.run(randomUUID(), org, st.id, `${period}-${String(d).padStart(2, "0")}`, 5000, 5000);
  });
  seedClosings();

  console.log("Semeadura pronta. Medindo…\n");

  const screen: { label: string; ms: number }[] = []; // consultas de TELA (têm orçamento)
  const rec = (r: { label: string; ms: number }, budgeted = true) => { if (budgeted) screen.push(r); console.log(`  ${r.ms.toFixed(0).padStart(6)} ms  ${r.label}${budgeted ? '' : '  (batch/background — sem orçamento de tela)'}`); };

  // 0. Backfill de resolução do catálogo (PERF-001) — BACKGROUND: em produção
  //    roda no Scheduler em lotes (limit 2000/passe); aqui resolvemos tudo de
  //    uma vez só pra deixar as consultas de tela medirem o caminho resolvido.
  //    Não entra no orçamento de TELA (não é uma tela).
  const bf = timeIt("backfill de catálogo (resolução completa, background)", () => {
    let total = 0;
    for (let guard = 0; guard < 1000; guard++) {
      const r = RetailPdvCatalogResolver.backfill(org, { limit: 5000 });
      total += r.processed;
      if (r.processed === 0) break;
    }
    return total;
  });
  rec(bf, false); console.log(`         → ${bf.value} itens resolvidos; pendentes: ${RetailPdvCatalogResolver.pendingCount(org)}`);

  // 1. Resultado da Rede set-based (PERF-003) — TELA.
  const all = timeIt("allStoresResult (rede set-based)", () => RetailStoreCostService.allStoresResult(org, period));
  rec(all); console.log(`         → ${all.value.perStore.length} lojas; faturamento rede ${all.value.totals.faturamento}`);

  // 2. CMV agregado por loja (PERF-002/003/004) — TELA.
  const cmv = timeIt("monthlyCogsBreakdownAll (CMV por loja)", () => RetailStoreCostService.monthlyCogsBreakdownAll(org, period));
  rec(cmv); console.log(`         → ${cmv.value.size} lojas com CMV`);

  // 3. Lista de precificação — TELA.
  const pl = timeIt("listProducts (precificar, 500)", () => RetailPricingService.listProducts(org, { limit: 500 }));
  rec(pl); console.log(`         → ${pl.value.items.length} produtos`);

  // 4. Mais vendidos (PERF-002/004) — TELA. Roda a MESMA SQL da rota, resolvidos
  //    pela coluna + prefixo confinado aos não-resolvidos.
  const tp = timeIt("pdv-top-products (mais vendidos)", () => db.prepare(
    `SELECT g.produto, COALESCE(rprod.name, p2.name) AS nome, g.pecas, g.valor
       FROM (
         SELECT i.produto, MAX(i.product_service_id) psid, MAX(i.catalog_resolved_at) resolved_at,
                SUM(i.quantidade) pecas, SUM(i.valor) valor
           FROM retail_pdv_sale_items i
          WHERE i.organization_id = ? AND i.sale_date BETWEEN ? AND ? AND COALESCE(i.produto,'') <> ''
          GROUP BY i.produto
       ) g
       LEFT JOIN products_services rprod ON g.resolved_at IS NOT NULL AND rprod.organization_id = ? AND rprod.id = g.psid
       LEFT JOIN products_services p2 ON g.resolved_at IS NULL AND p2.organization_id = ? AND g.produto LIKE p2.external_ref || '%' AND length(p2.external_ref) >= 4
      ORDER BY g.pecas DESC, g.valor DESC LIMIT 100`
  ).all(org, `${period}-01`, `${period}-31`, org, org) as any[]);
  rec({ label: tp.label, ms: tp.ms }); console.log(`         → ${tp.value.length} produtos no ranking`);

  // 5. Aplicação de preço em lote de 500 (PERF-008) — ação do usuário.
  const batch = pl.value.items.slice(0, 500).map((it: any) => ({ productId: it.productId, newPrice: (Number(it.currentPrice) || 50) + 1 }));
  const ap = timeIt("applyBulk (500 preços)", () => RetailPricingService.applyBulk(org, "u-load", batch));
  rec(ap); console.log(`         → ${ap.value.appliedCount} aplicados · ${ap.value.skippedCount} skipped · ${ap.value.failedCount} failed`);

  const over = screen.filter((r) => r.ms > BUDGET_MS);
  console.log(`\nOrçamento por consulta de TELA: ${BUDGET_MS} ms. ${over.length ? `ACIMA: ${over.map((o) => `${o.label} (${o.ms.toFixed(0)}ms)`).join(", ")}` : "todas dentro do orçamento."}`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(over.length ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
