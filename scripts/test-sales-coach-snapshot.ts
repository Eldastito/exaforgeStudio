/**
 * TEST — Sales Coach F1 (ADR-202): performanceSnapshot. Read-model determinístico do
 * desempenho do vendedor. Prova: precedência ERP>manual>orders (NUNCA soma/dobra),
 * rótulo de fonte, série mensal + totais + ticket médio (null sem peças), tendência,
 * honestidade (vendedor sem venda / inexistente / outra org → sem inventar), isolamento.
 *
 * Uso: npm run test:sales-coach-snapshot
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scoach-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scoach-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesCoachService } = await import("../src/server/SalesCoachService.js");
  const ORG = "org-A", ASOF = "2026-09-12";

  const seller = db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, user_id, active) VALUES (?, ?, ?, ?, ?, 1)");
  const manual = db.prepare("INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')");
  const erp = db.prepare("INSERT INTO retail_erp_seller_sales (id, organization_id, filial, sale_date, matricula, seller_name, valor, pecas) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const order = db.prepare("INSERT INTO orders (id, organization_id, status, total_amount, seller_user_id, created_at) VALUES (?, ?, 'pago', ?, ?, ?)");

  // ── Vendedor MANUAL (queda) ──
  seller.run("sm", ORG, "M1", "Ana", null);
  manual.run("m1", ORG, "2026-07-05", "Ana", "M1", 1000, 10);
  manual.run("m2", ORG, "2026-08-05", "Ana", "M1", 800, 8);
  manual.run("m3", ORG, "2026-09-05", "Ana", "M1", 600, 6);
  const sm = SalesCoachService.performanceSnapshot(ORG, "sm", { asOf: ASOF });
  check("1.1 source=manual", sm.source === "manual");
  check("1.2 série de 3 meses ordenada", sm.monthly.length === 3 && sm.monthly[0].ym === "2026-07" && sm.monthly[2].ym === "2026-09");
  check("1.3 totais somam a janela", sm.totals.valor === 2400 && sm.totals.pecas === 24);
  check("1.4 ticket médio = valor/peças", sm.totals.avgTicket === 100);
  check("1.5 tendência de queda (down, -40%)", sm.trend.direction === "down" && sm.trend.deltaPct === -40);
  check("1.6 hasData true + seller resolvido", sm.hasData === true && sm.seller?.matricula === "M1");

  // ── Vendedor com ERP e MANUAL: precedência ERP, NUNCA soma ──
  seller.run("se", ORG, "M2", "Bruno", null);
  erp.run("e1", ORG, "F1", "2026-08-10", "M2", "Bruno", 5000, 50);
  erp.run("e2", ORG, "F1", "2026-09-10", "M2", "Bruno", 4000, 40);
  manual.run("mm1", ORG, "2026-08-15", "Bruno", "M2", 999, 9); // NÃO pode entrar (erp vence)
  const se = SalesCoachService.performanceSnapshot(ORG, "se", { asOf: ASOF });
  check("2.1 source=erp (precedência)", se.source === "erp");
  check("2.2 totais só do ERP (não dobra com manual)", se.totals.valor === 9000 && se.totals.pecas === 90);

  // ── Vendedor ORDERS (tem user_id, sem retail sales) ──
  seller.run("so", ORG, "M3", "Carla", "U3");
  order.run("o1", ORG, 1200, "U3", "2026-07-06 10:00:00");
  order.run("o2", ORG, 1500, "U3", "2026-09-05 10:00:00");
  order.run("o3", ORG, 300, "U3", "2026-09-06 10:00:00"); // mesmo mês → soma no mês (antes do asOf 12/09)
  const so = SalesCoachService.performanceSnapshot(ORG, "so", { asOf: ASOF });
  check("3.1 source=orders", so.source === "orders");
  check("3.2 orders sem peças → pecas null e avgTicket null (não inventa)", so.totals.pecas === null && so.totals.avgTicket === null);
  check("3.3 orders agrega por mês (set/2026 = 1800)", (so.monthly.find((m: any) => m.ym === "2026-09")?.valor) === 1800);
  check("3.4 tendência up (1200→1800)", so.trend.direction === "up");

  // ── Honestidade: vendedor existe mas sem venda ──
  seller.run("sx", ORG, "M4", "Diego", null);
  const sx = SalesCoachService.performanceSnapshot(ORG, "sx", { asOf: ASOF });
  check("4.1 sem venda → hasData false, source null, seller presente", sx.hasData === false && sx.source === null && sx.seller?.matricula === "M4");
  check("4.2 sem venda → totais/tendência nulos honestos", sx.totals.avgTicket === null && sx.trend.direction === null && sx.monthly.length === 0);

  // ── Vendedor inexistente ──
  const none = SalesCoachService.performanceSnapshot(ORG, "nao-existe", { asOf: ASOF });
  check("5.1 vendedor inexistente → seller null + hasData false", none.seller === null && none.hasData === false);

  // ── Isolamento multi-tenant ──
  const cross = SalesCoachService.performanceSnapshot("org-B", "sm", { asOf: ASOF });
  check("6.1 vendedor de outra org não vaza", cross.seller === null && cross.hasData === false);

  // ── Janela respeita o asOf (venda velha fora da janela de 6m não entra) ──
  seller.run("sw", ORG, "M5", "Elis", null);
  manual.run("w1", ORG, "2026-01-05", "Elis", "M5", 9999, 99); // jan/2026 < from(2026-03-12) → fora
  manual.run("w2", ORG, "2026-09-05", "Elis", "M5", 500, 5);
  const sw = SalesCoachService.performanceSnapshot(ORG, "sw", { asOf: ASOF, months: 6 });
  check("7.1 venda fora da janela é excluída", sw.monthly.length === 1 && sw.totals.valor === 500);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sales-coach-snapshot: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
