/**
 * TEST — Projeção de resultado do mês & ponto de equilíbrio pleno (ADR-188 F1). DB-backed, determinístico.
 * Prova: a conta (contribuição/razão/breakEven/run-rate), a ASSIMETRIA fixo × variável (custo fixo do
 * mês inteiro, receita/variável run-rated), honesto-null sem receita, confiança por dias decorridos,
 * onTrack abaixo/acima do equilíbrio, actual quando fechado, determinismo e isolamento.
 *
 * Uso: npm run test:result-projection
 */
import os from "os"; import path from "path"; import fs from "fs"; import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-resproj-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-resproj-123456";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const db = (await import("../src/server/db.js")).default;
  const { ResultProjectionService: RP } = await import("../src/server/ResultProjectionService.js");

  const mkOrg = () => { const o = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'O', 'active')`).run(randomUUID(), o); return o; };
  // Uma venda paga no período (line_total = receita; unit_cost*qty = CMV).
  const mkSale = (org: string, revenue: number, cost: number, day = "10") => {
    const oid = randomUUID();
    db.prepare(`INSERT INTO orders (id, organization_id, status, total_amount, created_at) VALUES (?, ?, 'pago', ?, ?)`).run(oid, org, revenue, `2026-06-${day} 10:00:00`);
    db.prepare(`INSERT INTO order_items (id, order_id, organization_id, name_snapshot, unit_price, quantity, line_total, unit_cost) VALUES (?, ?, ?, 'P', ?, 1, ?, ?)`).run(randomUUID(), oid, org, revenue, revenue, cost);
  };
  const mkPayable = (org: string, amount: number, recurrence: "none" | "monthly" | "weekly") =>
    db.prepare(`INSERT INTO payables (id, organization_id, description, amount, due_date, recurrence, status) VALUES (?, ?, 'D', ?, '2026-06-05', ?, 'open')`).run(randomUUID(), org, amount, recurrence);

  // ── Cenário A: receita 1000 / CMV 400 / variável 100 / fixo 300; asOf dia 15 de 30 (runRate 2) ──
  const A = mkOrg();
  mkSale(A, 1000, 400);
  mkPayable(A, 100, "none");     // variável
  mkPayable(A, 300, "monthly");  // fixo (whole-month)
  const a = RP.project(A, { period: "2026-06", asOf: "2026-06-15" });

  check("1.1 MTD lido do DRE (receita/cmv/variável/fixo)", a.mtd.receitaLiquida === 1000 && a.mtd.cmv === 400 && a.mtd.despesasVariaveis === 100 && a.mtd.despesasFixas === 300);
  check("1.2 razão de contribuição = (1000-400-100)/1000 = 0,5", a.contributionRatio === 0.5);
  check("1.3 breakEven = fixo/razão = 300/0,5 = 600", a.breakEvenRevenue === 600);
  check("1.4 run-rate: receita projetada = 1000 × 30/15 = 2000", a.projected.receita === 2000);
  check("1.5 resultado projetado = 2000×0,5 − 300 = 700 (custo fixo NÃO escalonado — RN-RP-3)", a.projected.resultado === 700);
  check("1.6 pctToBreakEven = 2000/600×100 ≈ 333,33", a.pctToBreakEven === 333.33);
  check("1.7 onTrack (700 ≥ 0) + confiança alta (15/30)", a.onTrack === true && a.confidence === "high");
  check("1.8 premissas explícitas (RN-RP-2)", Array.isArray(a.assumptions) && a.assumptions.length === 3);

  // ── Assimetria PROVADA: dobrar só os dias decorridos não muda o custo fixo projetado ──
  const aEarly = RP.project(A, { period: "2026-06", asOf: "2026-06-10" }); // runRate 3 → receita 3000
  check("2.1 receita run-rated muda com os dias (3000 no dia 10)", aEarly.projected.receita === 3000);
  check("2.2 custo fixo continua 300 no cálculo (resultado = 3000×0,5 − 300 = 1200)", aEarly.projected.resultado === 1200);

  // ── Cenário B: projeta ABAIXO do equilíbrio (onTrack false) ──
  const B = mkOrg();
  mkSale(B, 200, 80);
  mkPayable(B, 20, "none");
  mkPayable(B, 300, "monthly");
  const b = RP.project(B, { period: "2026-06", asOf: "2026-06-15" });
  // contribuição=100, razão=0,5, breakEven=600; receita proj=400; resultado=400×0,5−300=−100
  check("3.1 abaixo do equilíbrio: resultado projetado −100, onTrack false", b.projected.resultado === -100 && b.onTrack === false);

  // ── Cenário C: honesto-null sem receita (RN-RP-1) ──
  const C = mkOrg();
  mkPayable(C, 300, "monthly");
  const c = RP.project(C, { period: "2026-06", asOf: "2026-06-15" });
  check("4.1 sem receita → razão/breakEven/projeção null + confidence no_revenue", c.contributionRatio === null && c.breakEvenRevenue === null && c.projected.resultado === null && c.confidence === "no_revenue");

  // ── Confiança: poucos dias → insufficient_elapsed; mês fechado → actual ──
  const aDay3 = RP.project(A, { period: "2026-06", asOf: "2026-06-03" });
  check("5.1 poucos dias decorridos → insufficient_elapsed", aDay3.confidence === "insufficient_elapsed");
  const aDone = RP.project(A, { period: "2026-06", asOf: "2026-07-10" });
  check("5.2 mês fechado → actual + receita projetada = realizada (runRate 1)", aDone.confidence === "actual" && aDone.projected.receita === 1000 && aDone.elapsedDays === 30);

  // ── not_started: asOf antes do mês (mesmo com receita seeded) → não projeta ──
  const aBefore = RP.project(A, { period: "2026-06", asOf: "2026-05-20" });
  check("6.1 mês não começou → not_started, projeção null, breakEven ainda derivado", aBefore.confidence === "not_started" && aBefore.projected.resultado === null && aBefore.breakEvenRevenue === 600);

  // ── Determinismo + isolamento ──
  check("7.1 determinístico (2 chamadas iguais)", JSON.stringify(RP.project(A, { period: "2026-06", asOf: "2026-06-15" })) === JSON.stringify(RP.project(A, { period: "2026-06", asOf: "2026-06-15" })));
  check("7.2 isolado (A ≠ B)", a.projected.resultado !== b.projected.resultado);

  const passed = results.filter((x) => x.ok).length;
  for (const x of results) if (!x.ok) console.log(`  ✗ ${x.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} result-projection: ${passed}/${results.length} checks`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
