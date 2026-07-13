/**
 * TESTE — ADR-085: capital parado em estoque + produtos sem giro (factual)
 * -----------------------------------------------------------------------
 * Prova, offline, a métrica de "dinheiro parado":
 *   - capital parado = custo médio × quantidade em estoque (fato); itens com
 *     saldo 0 não contam;
 *   - "sem giro" = com saldo e sem SAÍDA (venda) há N dias (ou nunca);
 *   - produto com saída recente NÃO é sem giro; isolamento por organização.
 *
 * Uso:  npm run test:retail-stock-capital
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-capital-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-para-retail-capital-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  if (!ok) failures++;
}

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailImpactService } = await import("../src/server/RetailImpactService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'A', 'active')`).run(randomUUID(), A);

  const inv = (prod: string, qty: number, cost: number) =>
    db.prepare(`INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, avg_cost) VALUES (?, ?, ?, ?, ?)`)
      .run(randomUUID(), A, prod, qty, cost);
  const saida = (prod: string, whenModifier: string) =>
    db.prepare(`INSERT INTO stock_movements (id, organization_id, product_service_id, type, quantity, created_at) VALUES (?, ?, ?, 'saida', 1, datetime('now', ?))`)
      .run(randomUUID(), A, prod, whenModifier);

  const p1 = randomUUID(), p2 = randomUUID(), p3 = randomUUID(), p4 = randomUUID();
  inv(p1, 10, 5);   // capital 50, saída hoje → gira
  inv(p2, 4, 25);   // capital 100, última saída há 90 dias → sem giro
  inv(p3, 2, 10);   // capital 20, nunca teve saída → sem giro
  inv(p4, 0, 100);  // saldo 0 → não conta
  saida(p1, "-1 days");
  saida(p2, "-90 days");

  const r = RetailImpactService.stockCapital(A, 60);

  check("Capital parado total = 170 (50+100+20; p4 saldo 0 fora)", r.totalCapital === 170);
  check("Itens em estoque = 3", r.itemsInStock === 3);
  check("Produtos sem giro = 2 (p2, p3)", r.slowMoverCount === 2);
  check("Capital sem giro = 120 (100+20)", r.slowMoverCapital === 120);
  const ids = r.slowMovers.map((s: any) => s.productId);
  check("Sem giro inclui p2 e p3, exclui p1 (girou)", ids.includes(p2) && ids.includes(p3) && !ids.includes(p1));
  check("Sem giro ordenado por capital (p2=100 antes de p3=20)", r.slowMovers[0].productId === p2 && r.slowMovers[0].capital === 100);

  // Isolamento
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'B', 'active')`).run(randomUUID(), B);
  const rb = RetailImpactService.stockCapital(B, 60);
  check("Isolamento: org B vem zerada", rb.totalCapital === 0 && rb.itemsInStock === 0 && rb.slowMoverCount === 0);

  console.log("\n=== ADR-085: capital parado + produtos sem giro (factual) ===");
  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok || !x.detail ? "" : ` — ${x.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} verificações OK`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
