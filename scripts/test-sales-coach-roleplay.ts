/**
 * TEST — Sales Coach F5 (ADR-202): roleplay(). Roteiros de treino determinísticos por
 * gap, SIMULAÇÃO INTERNA (RN-SC-1: nada enviado ao cliente). Prova: um cenário por gap
 * com template, grounded (cita o contexto do gap), disclaimer presente, saudável → sem
 * cenário (não inventa), inexistente/isolamento.
 *
 * Uso: npm run test:sales-coach-roleplay
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scrp-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scrp-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const scn = (r: any, key: string) => r.scenarios.find((s: any) => s.gapKey === key);

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesCoachService } = await import("../src/server/SalesCoachService.js");
  const ORG = "org-A", ASOF = "2026-09-12";

  const seller = db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)");
  const sale = db.prepare("INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')");
  let n = 0; const sk = () => `k${++n}`;

  // Time: 2 fortes + 1 em queda (para declining_trend + below_team_valor) + 1 saudável.
  seller.run("g1", ORG, "M1", "GoodA"); sale.run(sk(), ORG, "2026-08-05", "GoodA", "M1", 5000, 50); sale.run(sk(), ORG, "2026-09-05", "GoodA", "M1", 5000, 50);
  seller.run("g2", ORG, "M2", "GoodB"); sale.run(sk(), ORG, "2026-08-05", "GoodB", "M2", 5000, 50); sale.run(sk(), ORG, "2026-09-05", "GoodB", "M2", 5000, 50);
  seller.run("gd", ORG, "M3", "Decl");
  sale.run(sk(), ORG, "2026-06-05", "Decl", "M3", 2000, 20); sale.run(sk(), ORG, "2026-07-05", "Decl", "M3", 1500, 15);
  sale.run(sk(), ORG, "2026-08-05", "Decl", "M3", 1000, 10); sale.run(sk(), ORG, "2026-09-05", "Decl", "M3", 600, 6);
  seller.run("gh", ORG, "M5", "Heal"); sale.run(sk(), ORG, "2026-08-05", "Heal", "M5", 4000, 40); sale.run(sk(), ORG, "2026-09-05", "Heal", "M5", 4200, 42);

  const rd = SalesCoachService.roleplay(ORG, "gd", { asOf: ASOF });
  check("1.1 disclaimer de simulação interna presente", /interna de treino/i.test(rd.disclaimer) && /não é enviado ao cliente|nada aqui é enviado ao cliente/i.test(rd.disclaimer));
  check("1.2 cenário de queda presente com template", !!scn(rd, "declining_trend") && /ritmo/i.test(scn(rd, "declining_trend").title));
  check("1.3 cenário grounded (cita o contexto do gap)", scn(rd, "declining_trend").situation.includes("Treino motivado por"));
  check("1.4 tem fala simulada + resposta + prática", (() => { const s = scn(rd, "declining_trend"); return !!s.customerLine && !!s.suggestedResponse && !!s.practice; })());
  check("1.5 também gera cenário de abaixo-do-time (venda)", !!scn(rd, "below_team_valor"));
  check("1.6 nº de cenários = nº de gaps com template", rd.scenarios.length === rd.scenarios.filter((s: any) => ["declining_trend", "below_team_valor", "below_team_ticket"].includes(s.gapKey)).length && rd.scenarios.length >= 2);

  // ── saudável: sem gap → sem cenário (não inventa treino) ──
  const rh = SalesCoachService.roleplay(ORG, "gh", { asOf: ASOF });
  check("2.1 vendedor saudável → nenhum cenário", rh.hasData === true && rh.scenarios.length === 0);

  // ── sem base ──
  seller.run("ge", ORG, "M6", "Empty");
  const re = SalesCoachService.roleplay(ORG, "ge", { asOf: ASOF });
  check("3.1 sem base → hasData false, sem cenário", re.hasData === false && re.scenarios.length === 0);

  // ── inexistente / isolamento ──
  check("4.1 inexistente → seller null", SalesCoachService.roleplay(ORG, "nao-existe", { asOf: ASOF }).seller === null);
  check("4.2 outra org não vaza", SalesCoachService.roleplay("org-B", "gd", { asOf: ASOF }).seller === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sales-coach-roleplay: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
