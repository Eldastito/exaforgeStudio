/**
 * TEST — Sales Coach F3 (ADR-202): feedback() determinístico + feedbackAsync() com
 * fallback. Prova: pontos de treino GROUNDED nos gaps (F2), headline por severidade,
 * tom advisório, honestidade (sem base / inexistente), e que o rephrase por IA cai no
 * texto determinístico sem chave (RN-SC-4: determinístico antes de LLM). Isolamento.
 *
 * Uso: npm run test:sales-coach-feedback
 */
import os from "os"; import path from "path"; import fs from "fs";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scfb-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-scfb-123456";
delete process.env.OPENAI_API_KEY; // garante o caminho de fallback determinístico

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }
const hasPoint = (r: any, key: string) => r.points.some((p: any) => p.key === key);

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { SalesCoachService } = await import("../src/server/SalesCoachService.js");
  const ORG = "org-A", ASOF = "2026-09-12";

  const seller = db.prepare("INSERT INTO retail_sellers (id, organization_id, matricula, name, active) VALUES (?, ?, ?, ?, 1)");
  const sale = db.prepare("INSERT INTO retail_seller_sales (id, organization_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, 'manual')");
  let n = 0; const sk = () => `k${++n}`;

  seller.run("g1", ORG, "M1", "GoodA"); sale.run(sk(), ORG, "2026-08-05", "GoodA", "M1", 5000, 50); sale.run(sk(), ORG, "2026-09-05", "GoodA", "M1", 5000, 50);
  seller.run("g2", ORG, "M2", "GoodB"); sale.run(sk(), ORG, "2026-08-05", "GoodB", "M2", 5000, 50); sale.run(sk(), ORG, "2026-09-05", "GoodB", "M2", 5000, 50);
  seller.run("gd", ORG, "M3", "Decl");
  sale.run(sk(), ORG, "2026-06-05", "Decl", "M3", 2000, 20); sale.run(sk(), ORG, "2026-07-05", "Decl", "M3", 1500, 15);
  sale.run(sk(), ORG, "2026-08-05", "Decl", "M3", 1000, 10); sale.run(sk(), ORG, "2026-09-05", "Decl", "M3", 600, 6);
  seller.run("gh", ORG, "M5", "Heal"); sale.run(sk(), ORG, "2026-08-05", "Heal", "M5", 4000, 40); sale.run(sk(), ORG, "2026-09-05", "Heal", "M5", 4200, 42);

  // ── vendedor em queda: feedback grounded ──
  const fd = SalesCoachService.feedback(ORG, "gd", { asOf: ASOF });
  check("1.1 hasData + headline de atenção (severidade high)", fd.hasData && /importantes/i.test(fd.headline));
  check("1.2 ponto de queda presente", hasPoint(fd, "declining_trend"));
  check("1.3 ponto grounded (cita as 3 quedas)", fd.points.find((p: any) => p.key === "declining_trend").text.includes("3 meses"));
  check("1.4 também aponta abaixo do time", hasPoint(fd, "below_team_valor"));

  // ── saudável ──
  const fh = SalesCoachService.feedback(ORG, "gh", { asOf: ASOF });
  check("2.1 saudável → headline saudável + ponto healthy", /saudável/i.test(fh.headline) && hasPoint(fh, "healthy"));

  // ── sem base ──
  seller.run("ge", ORG, "M6", "Empty");
  const fe = SalesCoachService.feedback(ORG, "ge", { asOf: ASOF });
  check("3.1 sem base → hasData false + ponto insufficient_data", fe.hasData === false && hasPoint(fe, "insufficient_data"));

  // ── inexistente ──
  const fn = SalesCoachService.feedback(ORG, "nao-existe", { asOf: ASOF });
  check("4.1 inexistente → seller null, sem pontos", fn.seller === null && fn.points.length === 0);

  // ── feedbackAsync sem chave → fallback determinístico ──
  const fa = await SalesCoachService.feedbackAsync(ORG, "gd", { asOf: ASOF });
  check("5.1 sem IA → aiUsed false", fa.aiUsed === false);
  check("5.2 narrativa = texto determinístico (headline + pontos)", fa.narrative.includes(fa.headline) && fa.narrative.includes("queda"));
  check("5.3 async não fala com cliente (só pontos do vendedor)", fa.points.length === fd.points.length);

  // ── isolamento ──
  check("6.1 vendedor de outra org não vaza", SalesCoachService.feedback("org-B", "gd", { asOf: ASOF }).seller === null);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} sales-coach-feedback: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
