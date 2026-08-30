/**
 * TESTE — Placar por vendedor (realizado vs cota: dia/semana/quinzena/mês).
 * ------------------------------------------------------------------------------
 * Cota SEMANAL como base (decisão do dono):
 *   - dia      = cota da semana ÷ dias escalados 'work' na semana;
 *   - semana   = cota semanal cadastrada;
 *   - quinzena = 2 semanas (semana atual + anterior); realizado = 14 dias;
 *   - mês      = soma das cotas semanais que tocam o mês; realizado = mês.
 *
 * Uso:  npm run test:retail-seller-scoreboard
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-scoreboard-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-scoreboard-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 0.02;

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionRaceService: Race } = await import("../src/server/RetailCommissionRaceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja Centro', 'LC', 1)`).run(store, A);

  const KEY = "mat:1024"; const NAME = "Maria"; const MAT = "1024";
  const refDate = "2026-08-15"; // sábado → semana domingo 09/08 → sábado 15/08

  // Cotas semanais (grade por domingo). monthWeekStarts de agosto: 26/07, 02/08,
  // 09/08, 16/08, 23/08, 30/08. Aug09=3500 (semana atual), Aug02=3000 (anterior),
  // resto=1000 → cota do mês = 3500+3000+1000*4 = 10500.
  const setQ = (weekStart: string, amount: number) => Race.setSellerQuotas(A, store, weekStart, [{ sellerKey: KEY, sellerName: NAME, amount }]);
  setQ("2026-07-26", 1000); setQ("2026-08-02", 3000); setQ("2026-08-09", 3500);
  setQ("2026-08-16", 1000); setQ("2026-08-23", 1000); setQ("2026-08-30", 1000);

  // Escala da semana atual (09→15): Maria trabalha 5 dias, folga 2 → cota do dia = 3500/5 = 700.
  Race.saveSchedule(A, store, "2026-08-09", "2026-08-15", [
    { date: "2026-08-09", sellerKey: KEY, sellerName: NAME, status: "work" },
    { date: "2026-08-10", sellerKey: KEY, sellerName: NAME, status: "work" },
    { date: "2026-08-11", sellerKey: KEY, sellerName: NAME, status: "work" },
    { date: "2026-08-12", sellerKey: KEY, sellerName: NAME, status: "work" },
    { date: "2026-08-13", sellerKey: KEY, sellerName: NAME, status: "work" },
    { date: "2026-08-14", sellerKey: KEY, sellerName: NAME, status: "off" },
    { date: "2026-08-15", sellerKey: KEY, sellerName: NAME, status: "off" },
  ]);

  // Vendas por vendedor (folha de ranking). Janelas: dia=15/08; semana=09→15;
  // quinzena=02→15; mês=agosto.
  const sale = db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`);
  sale.run(randomUUID(), A, store, "2026-08-15", NAME, MAT, 800, 10);  // dia + semana + quinzena + mês
  sale.run(randomUUID(), A, store, "2026-08-10", NAME, MAT, 1200, 8);  // semana + quinzena + mês
  sale.run(randomUUID(), A, store, "2026-08-05", NAME, MAT, 900, 6);   // quinzena + mês (fora da semana atual)
  sale.run(randomUUID(), A, store, "2026-08-20", NAME, MAT, 500, 4);   // só mês

  const sb = Race.sellerPeriodScoreboard(A, store, refDate);
  const m = sb.sellers.find((s: any) => s.matricula === MAT);
  check("0.1 vendedor aparece no placar", !!m, JSON.stringify(sb.sellers.map((s:any)=>s.sellerName)));
  if (!m) { report(); return; }

  // ===== DIA (15/08) =====
  check("1.1 dia: realizado = 800", near(m.day.sales, 800), `${m.day.sales}`);
  check("1.2 dia: cota = 3500 ÷ 5 escalados = 700", near(m.day.quota, 700), `${m.day.quota}`);
  check("1.3 dia: atingimento = 114,29%", near(m.day.attainment, 114.29), `${m.day.attainment}`);
  check("1.4 dias escalados na semana = 5", m.scheduledDaysThisWeek === 5, `${m.scheduledDaysThisWeek}`);

  // ===== SEMANA (09→15) =====
  check("2.1 semana: realizado = 2000 (800+1200)", near(m.week.sales, 2000), `${m.week.sales}`);
  check("2.2 semana: cota = 3500 (cadastrada)", near(m.week.quota, 3500), `${m.week.quota}`);
  check("2.3 semana: atingimento ≈ 57,14%", near(m.week.attainment, 57.14), `${m.week.attainment}`);
  check("2.4 origem da cota = explicit", m.quotaSource === "explicit", m.quotaSource);

  // ===== QUINZENA (02→15) =====
  check("3.1 quinzena: realizado = 2900 (+900)", near(m.fortnight.sales, 2900), `${m.fortnight.sales}`);
  check("3.2 quinzena: cota = 6500 (3500+3000)", near(m.fortnight.quota, 6500), `${m.fortnight.quota}`);
  check("3.3 quinzena: atingimento ≈ 44,62%", near(m.fortnight.attainment, 44.62), `${m.fortnight.attainment}`);

  // ===== MÊS (agosto) =====
  check("4.1 mês: realizado = 3400 (800+1200+900+500)", near(m.month.sales, 3400), `${m.month.sales}`);
  check("4.2 mês: cota = 10500 (soma das semanas)", near(m.month.quota, 10500), `${m.month.quota}`);
  check("4.3 mês: atingimento ≈ 32,38%", near(m.month.attainment, 32.38), `${m.month.attainment}`);

  // ===== isolamento =====
  let isoOk = false;
  try { isoOk = Race.sellerPeriodScoreboard(B, store, refDate).sellers.length === 0; } catch { isoOk = true; }
  check("5.1 org B não vê a loja de A (erro ou vazio)", isoOk);

  report();
  function report() {
    console.log("\n=== TEST: Placar por vendedor (realizado vs cota por período) ===\n");
    for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
    console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    process.exit(failures ? 1 : 0);
  }
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
