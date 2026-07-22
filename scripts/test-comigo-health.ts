/**
 * TEST — Comigo/Termômetro de Saúde (ADR-116 / ADR-088 D7, Fatia 2).
 *
 * Cobre lucro (receita − custo), comparação do MESMO período (hoje × 7 dias
 * atrás), sinal subindo/estável/caindo, ponto de equilíbrio + progresso e a
 * frase-conselho.
 *
 * Uso: npm run test:comigo-health
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-comigo-health-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-comigo-health-1234567890";

let failures = 0;
const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const near = (a: number, b: number, eps = 0.011) => Math.abs(a - b) <= eps;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ComigoHealthService: H } = await import("../src/server/ComigoHealthService.js");

  const orgId = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status, comigo_fixed_costs_monthly) VALUES (?, ?, 'X', 'active', ?)`)
    .run(randomUUID(), orgId, 300); // R$300/mês → R$10/dia de fixo

  // Helper: cria um pedido pago numa data específica com (preço, custo, qty).
  function sale(dateIso: string, price: number, cost: number, qty = 1) {
    const oid = randomUUID();
    db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total, created_at) VALUES (?, ?, 'paid', 'cash', ?, ?)`)
      .run(oid, orgId, price * qty, `${dateIso} 12:00:00`);
    db.prepare(`INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) VALUES (?, ?, 'Item', ?, ?, ?)`)
      .run(randomUUID(), oid, qty, price, cost);
    return oid;
  }

  const today = new Date().toISOString().slice(0, 10);
  const d = (days: number) => { const x = new Date(today + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + days); return x.toISOString().slice(0, 10); };

  // ===== 1. Lucro = receita − custo =====
  sale(today, 50, 30, 1); // hoje: receita 50, custo 30, lucro 20
  const r = H.rangeResult(orgId, today, today);
  check("receita do dia = 50", near(r.revenue, 50));
  check("custo do dia = 30", near(r.cost, 30));
  check("lucro do dia = 20", near(r.profit, 20));

  // ===== 2. Comparação MESMO período (hoje × 7 dias atrás) — sinal =====
  // 7 dias atrás: lucro menor (10) → hoje (20) está SUBINDO.
  sale(d(-7), 40, 30, 1); // lucro 10 na semana passada
  const t = H.trend(orgId, "dia", today);
  check("compara com 7 dias atrás (prevProfit=10)", near(t.prevProfit, 10));
  check("sinal SUBINDO (20 vs 10 = +100%)", t.signal === "subindo" && t.profitDeltaPct === 100);

  // ===== 3. Sinal CAINDO =====
  const org2 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Y', 'active')`).run(randomUUID(), org2);
  // hoje lucro 10, 7 dias atrás lucro 30 → caindo.
  db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total, created_at) VALUES (?, ?, 'paid','cash', 20, ?)`).run(randomUUID(), org2, `${today} 10:00:00`);
  db.prepare(`INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) SELECT ?, id, 'I', 1, 20, 10 FROM comigo_orders WHERE organization_id = ? AND date(created_at)=?`).run(randomUUID(), org2, today);
  db.prepare(`INSERT INTO comigo_orders (id, organization_id, status, paid_via, total, created_at) VALUES (?, ?, 'paid','cash', 50, ?)`).run(randomUUID(), org2, `${d(-7)} 10:00:00`);
  db.prepare(`INSERT INTO comigo_order_items (id, order_id, name, qty, unit_price, unit_cost_snapshot) SELECT ?, id, 'I', 1, 50, 20 FROM comigo_orders WHERE organization_id = ? AND date(created_at)=?`).run(randomUUID(), org2, d(-7));
  const t2 = H.trend(org2, "dia", today);
  check("sinal CAINDO (10 vs 30)", t2.signal === "caindo");

  // ===== 4. Ponto de equilíbrio + progresso =====
  // org: fixo diário 10; margem média ~ (lucro/receita) da janela; ticket médio.
  const be = H.breakEven(orgId, today);
  check("tem custos fixos informados", be.hasFixedCosts === true);
  check("custo fixo diário = 10 (300/30)", near(be.dailyFixed, 10));
  check("faturamento de equilíbrio > 0", be.breakEvenRevenue > 0);
  check("unidades de equilíbrio calculadas", be.breakEvenUnits >= 1);
  check("progresso entre 0 e 1", be.progress >= 0 && be.progress <= 1);

  // ===== 5. Frase-conselho coerente =====
  const ins = H.insight(orgId, "dia", today);
  check("frase de subindo menciona lucro", /lucro subiu/i.test(ins.text) && ins.signal === "subindo");

  // ===== 6. Isolamento =====
  const org3 = `org_${randomUUID().slice(0, 8)}`;
  db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'Z', 'active')`).run(randomUUID(), org3);
  const rEmpty = H.rangeResult(org3, today, today);
  check("isolamento: org sem vendas tem lucro 0", rEmpty.profit === 0 && rEmpty.orders === 0);

  // --- Relatório ---
  console.log("\n=== TEST: Comigo — Termômetro de Saúde (ADR-116) ===\n");
  for (const rr of results) console.log(`${rr.ok ? "✅" : "❌"} ${rr.name}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  if (failures > 0) { console.error(`\n❌ ${failures} FALHA(S).`); process.exit(1); }
  console.log("\n✅ Termômetro de saúde OK.");
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
