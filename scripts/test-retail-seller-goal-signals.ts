/**
 * TESTE — Sinalização de META por vendedor (sequência de meses abaixo).
 * ------------------------------------------------------------------------------
 * Olha os meses FECHADOS (mês atual NÃO conta) e mede a sequência de meses
 * seguidos abaixo da meta — só meses COM meta cadastrada contam (mês sem meta é
 * neutro: não conta nem quebra). Escala neutra:
 *   ok (bateu) · attention (1) · critical (2) · action (3+) · none (sem meta).
 *
 * refDate = 2026-09-15 → meses fechados: 08, 07, 06, ... (setembro não entra).
 *
 * Uso:  npm run test:retail-seller-goal-signals
 */
import os from "os";
import path from "path";
import fs from "fs";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-goal-signals-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-goal-signals-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { RetailCommissionRaceService: Race } = await import("../src/server/RetailCommissionRaceService.js");

  const A = `org_A_${randomUUID().slice(0, 6)}`;
  const B = `org_B_${randomUUID().slice(0, 6)}`;
  for (const org of [A, B]) db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), org);
  const store = randomUUID();
  db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, 'Loja Centro', 'LC', 1)`).run(store, A);

  const sale = db.prepare(`INSERT INTO retail_seller_sales (id, organization_id, store_id, sale_date, seller_name, matricula, valor, pecas, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`);
  // Meta do mês = cota da 1ª semana do mês (as outras semanas resolvem 0 sem
  // escala) → month.quota = amount. Venda no dia 10 → month.sales = valor.
  const setGoal = (ym: string, mat: string, name: string, quota: number) => Race.setSellerQuotas(A, store, `${ym}-01`, [{ sellerKey: `mat:${mat}`, sellerName: name, amount: quota }]);
  const putSale = (ym: string, mat: string, name: string, valor: number) => sale.run(randomUUID(), A, store, `${ym}-10`, name, mat, valor, 1);

  // Ana (ok): agosto meta 1000, vendeu 1200 → bateu → streak 0.
  setGoal("2026-08", "100", "Ana", 1000); putSale("2026-08", "100", "Ana", 1200);
  // Bruno (attention): agosto abaixo; julho bateu → streak 1.
  setGoal("2026-08", "200", "Bruno", 1000); putSale("2026-08", "200", "Bruno", 500);
  setGoal("2026-07", "200", "Bruno", 1000); putSale("2026-07", "200", "Bruno", 1500);
  // Carla (critical): agosto e julho abaixo; junho bateu → streak 2.
  setGoal("2026-08", "300", "Carla", 1000); putSale("2026-08", "300", "Carla", 400);
  setGoal("2026-07", "300", "Carla", 1000); putSale("2026-07", "300", "Carla", 300);
  setGoal("2026-06", "300", "Carla", 1000); putSale("2026-06", "300", "Carla", 1100);
  // Davi (action): agosto, julho e junho abaixo → streak 3.
  setGoal("2026-08", "400", "Davi", 1000); putSale("2026-08", "400", "Davi", 200);
  setGoal("2026-07", "400", "Davi", 1000); putSale("2026-07", "400", "Davi", 200);
  setGoal("2026-06", "400", "Davi", 1000); putSale("2026-06", "400", "Davi", 200);
  // Edu (none): vende, mas SEM meta cadastrada em mês nenhum → none.
  putSale("2026-08", "500", "Edu", 900); putSale("2026-07", "500", "Edu", 900);
  // Fabi (critical via SKIP): agosto SEM meta (neutro, pula); julho e junho
  // abaixo → streak 2 (o mês sem meta não quebra a sequência).
  putSale("2026-08", "600", "Fabi", 300);                                   // agosto: venda sem meta
  setGoal("2026-07", "600", "Fabi", 1000); putSale("2026-07", "600", "Fabi", 200);
  setGoal("2026-06", "600", "Fabi", 1000); putSale("2026-06", "600", "Fabi", 200);

  const sig = Race.sellerGoalSignals(A, store, "2026-09-15");
  const by = (mat: string) => sig.sellers.find((s: any) => s.matricula === mat);

  check("mês atual (2026-09) NÃO entra; mais recente fechado = 2026-08", sig.months[0] === "2026-08" && !sig.months.includes("2026-09"), JSON.stringify(sig.months.slice(0, 3)));
  check("Ana = ok (bateu no mês fechado mais recente)", by("100")?.level === "ok" && by("100")?.streak === 0, JSON.stringify(by("100")));
  check("Bruno = attention (1 mês abaixo)", by("200")?.level === "attention" && by("200")?.streak === 1, JSON.stringify(by("200")));
  check("Carla = critical (2 meses seguidos)", by("300")?.level === "critical" && by("300")?.streak === 2, JSON.stringify(by("300")));
  check("Davi = action (3+ meses seguidos)", by("400")?.level === "action" && by("400")?.streak === 3, JSON.stringify(by("400")));
  check("Edu = none (sem meta cadastrada no histórico)", by("500")?.level === "none" && by("500")?.streak === 0, JSON.stringify(by("500")));
  check("Fabi = critical (mês sem meta é neutro, não quebra a sequência)", by("600")?.level === "critical" && by("600")?.streak === 2, JSON.stringify(by("600")));

  // Isolamento multi-tenant.
  let isoOk = false;
  try { isoOk = Race.sellerGoalSignals(B, store, "2026-09-15").sellers.length === 0; } catch { isoOk = true; }
  check("isolamento: org B não vê a loja de A", isoOk);

  console.log("\n=== TEST: Sinalização de meta por vendedor ===\n");
  for (const r of results) console.log(`${r.ok ? "✅" : "❌"} ${r.name}${r.ok || !r.detail ? "" : ` — ${r.detail}`}`);
  console.log(`\n${results.length - failures}/${results.length} checks passaram.`);
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} process.exit(1); });
