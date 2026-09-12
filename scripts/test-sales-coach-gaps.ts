/**
 * TEST — Sales Coach F2 (ADR-202): gaps(). Identificação determinística dos gaps do
 * vendedor (queda recorrente + abaixo do time em venda/ticket), advisória/qualitativa,
 * grounded, com baseline por mediana do time. Casos honestos: sem base, inexistente,
 * isolamento. Prova que "abaixo do time" só dispara com ≥2 comparáveis e não confunde
 * gap de ticket com gap de venda.
 *
 * Uso: npm run test:sales-coach-gaps
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scgaps-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scgaps-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const hasGap = (r: any, key: string) => r.gaps.some((g: any) => g.key === key);

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesCoachService } = await import("../src/server/SalesCoachService.js");
  const ORG = "org-A", ASOF = "2026-09-12";

  const seller = db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)");
  const sale = db.prepare("INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')");
  let n = 0; const sk = () => `k${++n}`;

  // Time: 2 fortes, 1 em queda, 1 de ticket baixo, 1 saudável.
  seller.run("g1", ORG, "M1", "GoodA"); sale.run(sk(), ORG, "2026-08-05", "GoodA", "M1", 5000, 50); sale.run(sk(), ORG, "2026-09-05", "GoodA", "M1", 5000, 50);
  seller.run("g2", ORG, "M2", "GoodB"); sale.run(sk(), ORG, "2026-08-05", "GoodB", "M2", 5000, 50); sale.run(sk(), ORG, "2026-09-05", "GoodB", "M2", 5000, 50);
  // Em queda (4 meses, 3 quedas): 2000→1500→1000→600
  seller.run("gd", ORG, "M3", "Decl");
  sale.run(sk(), ORG, "2026-06-05", "Decl", "M3", 2000, 20); sale.run(sk(), ORG, "2026-07-05", "Decl", "M3", 1500, 15);
  sale.run(sk(), ORG, "2026-08-05", "Decl", "M3", 1000, 10); sale.run(sk(), ORG, "2026-09-05", "Decl", "M3", 600, 6);
  // Ticket baixo (muita peça, pouco valor): ticket 10, avgMensal 3000
  seller.run("gt", ORG, "M4", "LowTk"); sale.run(sk(), ORG, "2026-08-05", "LowTk", "M4", 3000, 300); sale.run(sk(), ORG, "2026-09-05", "LowTk", "M4", 3000, 300);
  // Saudável (na mediana, subindo): 4000→4200
  seller.run("gh", ORG, "M5", "Heal"); sale.run(sk(), ORG, "2026-08-05", "Heal", "M5", 4000, 40); sale.run(sk(), ORG, "2026-09-05", "Heal", "M5", 4200, 42);

  const rd = SalesCoachService.gaps(ORG, "gd", { asOf: ASOF });
  const rt = SalesCoachService.gaps(ORG, "gt", { asOf: ASOF });
  const rh = SalesCoachService.gaps(ORG, "gh", { asOf: ASOF });

  // ── baseline do time ──
  check("1.1 baseline: mediana valor mensal = 4100, ticket = 100, 5 vendedores", rd.teamBaseline.avgMonthlyValor === 4100 && rd.teamBaseline.avgTicket === 100 && rd.teamBaseline.sellers === 5);

  // ── vendedor em queda ──
  check("2.1 queda recorrente detectada", hasGap(rd, "declining_trend"));
  check("2.2 queda severa é 'high'", rd.gaps.find((g: any) => g.key === "declining_trend").severity === "high");
  check("2.3 também abaixo do time em venda", hasGap(rd, "below_team_valor"));
  check("2.4 gap grounded (carrega os números)", rd.gaps.find((g: any) => g.key === "declining_trend").basis.declines === 3);

  // ── ticket baixo: dispara ticket, NÃO venda (3000 > 0.7*4100) e NÃO queda ──
  check("3.1 ticket abaixo do time detectado", hasGap(rt, "below_team_ticket"));
  check("3.2 NÃO marca venda abaixo do time (3000 acima do limiar)", !hasGap(rt, "below_team_valor"));
  check("3.3 NÃO marca queda (subiu/estável)", !hasGap(rt, "declining_trend"));

  // ── saudável: sem gaps ──
  check("4.1 vendedor saudável não tem gaps", rh.hasData === true && rh.gaps.length === 0);

  // ── honestidade ──
  seller.run("ge", ORG, "M6", "Empty");
  const re = SalesCoachService.gaps(ORG, "ge", { asOf: ASOF });
  check("5.1 sem base → insufficient_data + hasData false", re.hasData === false && hasGap(re, "insufficient_data") && re.teamBaseline === null);
  const rn = SalesCoachService.gaps(ORG, "nao-existe", { asOf: ASOF });
  check("5.2 vendedor inexistente → seller null, sem gaps", rn.seller === null && rn.gaps.length === 0);

  // ── below-team só com ≥2 comparáveis (org com 1 vendedor não sinaliza) ──
  const ORG2 = "org-solo";
  seller.run("s1", ORG2, "S1", "Solo"); sale.run(sk(), ORG2, "2026-09-05", "Solo", "S1", 10, 1);
  const rsolo = SalesCoachService.gaps(ORG2, "s1", { asOf: ASOF });
  check("6.1 org com 1 vendedor não dispara 'abaixo do time'", !hasGap(rsolo, "below_team_valor") && !hasGap(rsolo, "below_team_ticket"));

  // ── isolamento ──
  check("7.1 vendedor de outra org não vaza", SalesCoachService.gaps("org-B", "gd", { asOf: ASOF }).seller === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sales-coach-gaps: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
