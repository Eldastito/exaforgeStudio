/**
 * TESTE — Ranking dos melhores vendedores da REDE (SELLER-RANK-001).
 *
 * Pedido da dona (20/09/2026): "insere o ranking dos melhores vendedores da
 * rede — com a loja que ele pertence". Prova, offline:
 *  - agrega vendas por vendedor CRUZANDO as lojas (rede toda), no período;
 *  - a loja exibida é a de MAIOR venda do vendedor no período;
 *  - ordena por R$ vendido desc; respeita o limit;
 *  - consolida por matrícula (mesmo vendedor, casings diferentes);
 *  - só o período pedido entra (mês corrente);
 *  - isolamento multi-tenant; sem dado → vazio (nunca inventa).
 *
 * Uso:  npm run test:retail-network-top-sellers
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-sellrank-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-sellrank-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: any, b: number) => Math.abs(Number(a) - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailStoreService } = await import("../src/server/RetailStoreService.js");
  const { RetailSellerSalesService: SS } = await import("../src/server/RetailSellerSalesService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), A);
  const st1 = RetailStoreService.create(A, { name: "Nova Iguaçu", code: "1" }).id;
  const st2 = RetailStoreService.create(A, { name: "Carioca", code: "2" }).id;

  const seed = (storeId: string, date: string, name: string, valor: number, pecas: number, matricula?: string) =>
    db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), A, storeId, date, name, matricula || null, valor, pecas);

  // Ana: 800 na Nova Iguaçu + 300 na Carioca (mês) → total 1100, loja principal Nova Iguaçu.
  seed(st1, "2026-09-05", "Ana", 500, 10);
  seed(st1, "2026-09-10", "Ana", 300, 6);
  seed(st2, "2026-09-12", "Ana", 300, 5);
  // Bruno: 900 só na Carioca.
  seed(st2, "2026-09-08", "Bruno", 900, 12);
  // Carla: 400 na Nova Iguaçu.
  seed(st1, "2026-09-09", "Carla", 400, 8);
  // Fora do mês (agosto) — NÃO entra.
  seed(st1, "2026-08-20", "Ana", 5000, 99);

  const rank = SS.networkTopSellers(A, "2026-09-01", "2026-09-30", 10);

  // ===== 1. agrega a rede + ordena por R$ =====
  check("1.1 três vendedores no ranking", rank.length === 3, String(rank.length));
  check("1.2 1º = Ana (1100, cruzando lojas)", rank[0].sellerName === "Ana" && near(rank[0].sales, 1100), JSON.stringify(rank[0]));
  check("1.3 2º = Bruno (900)", rank[1].sellerName === "Bruno" && near(rank[1].sales, 900), JSON.stringify(rank[1]));
  check("1.4 3º = Carla (400)", rank[2].sellerName === "Carla" && near(rank[2].sales, 400));

  // ===== 2. loja exibida = a de MAIOR venda do vendedor =====
  check("2.1 Ana → loja principal Nova Iguaçu (800 > 300)", rank[0].storeName === "Nova Iguaçu", rank[0].storeName || "");
  check("2.2 Bruno → Carioca", rank[1].storeName === "Carioca", rank[1].storeName || "");

  // ===== 3. peças somadas =====
  check("3.1 Ana peças = 21 (10+6+5)", rank[0].pecas === 21, String(rank[0].pecas));

  // ===== 4. período: agosto (5000) não contaminou =====
  check("4.1 venda de agosto ficou fora (Ana = 1100, não 6100)", near(rank[0].sales, 1100));

  // ===== 5. limit =====
  check("5.1 limit=2 corta no top 2", SS.networkTopSellers(A, "2026-09-01", "2026-09-30", 2).length === 2);

  // ===== 6. consolida por matrícula (mesmo vendedor, grafias diferentes) =====
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), B);
  const stB = RetailStoreService.create(B, { name: "Loja B", code: "1" }).id;
  db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas) VALUES (?, ?, ?, ?, 'JOAO', '77', 200, 3)`).run(randomUUID(), B, stB, "2026-09-03");
  db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas) VALUES (?, ?, ?, ?, 'joao silva', '77', 150, 2)`).run(randomUUID(), B, stB, "2026-09-04");
  const rankB = SS.networkTopSellers(B, "2026-09-01", "2026-09-30", 10);
  check("6.1 mesma matrícula consolida num vendedor só (350)", rankB.length === 1 && near(rankB[0].sales, 350), JSON.stringify(rankB));

  // ===== 7. isolamento =====
  check("7.1 org B não vê vendedores de A", !rankB.some((s) => s.sellerName === "Ana" || s.sellerName === "Bruno"));

  // ===== 8. sem dado → vazio (não inventa) =====
  const C = `org_C_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Z', 'active')`).run(randomUUID(), C);
  check("8.1 org sem vendas → ranking vazio", SS.networkTopSellers(C, "2026-09-01", "2026-09-30", 10).length === 0);

  console.log("\n=== TEST: Ranking de vendedores da rede ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
