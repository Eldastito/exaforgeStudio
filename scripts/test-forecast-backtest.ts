/**
 * TESTE — ADR-205 F4.7: backtest da previsão do mês (ForecastBacktestService).
 * Prova: replay do MESMO RetailForecastService (nada recalculado) em datas passadas · mês real só vale completo · recusa da previsão conta como
 * `skipped` (não some) · mudança de nível não prevista FORA da faixa (errorPct do sinal certo) · veredito honesto (amostra pequena = insufficient_data,
 * Wilson) · backtest ≠ promessa · só leitura · isolamento · gestor-only (rota) · validação · composição.
 * Uso: npm run test:forecast-backtest
 */
import os from "os"; import path from "path"; import fs from "fs"; import http from "http";
import { randomUUID } from "crypto";
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-fbt-"));
process.env.DATA_DIR = tmpDir; process.env.NODE_ENV = "production"; process.env.JWT_SECRET = "test-secret-fbt-1234567890";
let failures = 0; const results: { name: string; ok: boolean; d?: string }[] = [];
function check(name: string, ok: boolean, d = "") { results.push({ name, ok, d }); if (!ok) failures++; }
const DAY = 86400e3;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dowOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

async function main() {
  const { default: db } = await import("../src/server/db.js");
  const { ForecastBacktestService: B, verdictOf, NOMINAL_COVERAGE, MIN_SAMPLES } = await import("../src/server/ForecastBacktestService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const mkU = (org: string, role: string, key: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, 'U', ?, ?, 'active')`).run(id, org, `${id}@t.local`, role); const pid = (db.prepare(`SELECT id FROM role_profiles WHERE organization_id = ? AND system_key = ?`).get(org, key) as any)?.id; return { userId: id, id, role, role_profile_id: pid }; };
  const mkStore = (org: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active) VALUES (?, ?, ?, ?, 1)`).run(id, org, name, name.slice(0, 3)); return { id, name }; };
  const thrown = (f: () => any) => { try { f(); return null; } catch (e: any) { return e?.code || "error"; } };
  const BASE = [2000, 1500, 1600, 1700, 1800, 2600, 3200], noise = (i: number) => ((i % 5) - 2) * 60;
  const close = (org: string, st: string, date: string, total: number) => db.prepare(`INSERT OR REPLACE INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total, informed_total) VALUES (?, ?, ?, ?, 'approved', ?, ?)`).run(randomUUID(), org, st, date, total, total);
  const seed = (org: string, st: string, from: string, to: string, o: { skip?: (d: string) => boolean; mult?: (d: string) => number } = {}) => { let i = 0; for (let d = from; d <= to; d = addDays(d, 1), i++) { if (o.skip?.(d)) continue; close(org, st, d, (BASE[dowOf(d)] + noise(i)) * (o.mult ? o.mult(d) : 1)); } };

  const TODAY = "2026-10-15";                       // injetado: meses fechados = jul, ago, set/2026
  const A = mkOrg(), OTHER = mkOrg();
  const estavel = mkStore(A, "Estavel"), choque = mkStore(A, "Choque"), curta = mkStore(A, "Curta"), furo = mkStore(A, "Furo");
  seed(A, estavel.id, "2026-01-01", "2026-09-30");
  seed(A, choque.id, "2026-01-01", "2026-09-30", { mult: (d) => (d >= "2026-09-16" ? 3 : 1) });        // nível triplica no dia 16/set — ninguém previu
  seed(A, curta.id, "2026-08-10", "2026-09-30");                                                       // ~7 semanas: previsão se recusa
  seed(A, furo.id, "2026-01-01", "2026-09-30", { skip: (d) => d >= "2026-08-22" && d <= "2026-08-29" }); // 8 dias sem fechamento no fim de agosto (depois dos pontos de leitura)
  const dono = mkU(A, "owner", "owner"), vend = mkU(A, "agent", "vendedor");

  const count = () => ["retail_daily_closings", "business_signals", "decision_actions", "tasks"].map((t) => (db.prepare(`SELECT COUNT(*) c FROM ${t} WHERE organization_id = ?`).get(A) as any).c).join(",");
  const c0 = count();
  const r = B.run(A, { today: TODAY });
  check("só leitura: nada foi gravado (fechamentos, sinais, ações, tarefas)", count() === c0);
  check("rótulos: é backtest (não previsão, não executa, não é promessa), faixa nominal 80%, meses e pontos padrão", r.type === "forecast_backtest" && r.isForecast === false && r.executes === false && r.promise === false && r.nominalCoverage === NOMINAL_COVERAGE && r.months.join() === "2026-07,2026-08,2026-09" && r.checkpoints.join() === "10,15,20");
  const st = (name: string) => r.stores.find((s: any) => s.storeName === name) as any;

  // loja estável: replay produz comparações com real completo
  check("loja estável: gera comparações (previsão × real) com faixa, central, real e erro", st("Estavel").runs.length > 0 && st("Estavel").runs.every((x: any) => x.actual > 0 && x.low <= x.mid && x.mid <= x.high && x.errorPct != null && x.bandWidthPct != null));
  const act = (name: string, month: string) => (db.prepare(`SELECT SUM(system_total) t FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date BETWEEN ? AND ?`).get(A, name === "Estavel" ? estavel.id : choque.id, `${month}-01`, `${month}-31`) as any).t;
  check("o 'real' é o fechamento do mês inteiro da loja (soma dos fechamentos)", st("Estavel").runs.filter((x: any) => x.month === "2026-08").every((x: any) => Math.abs(x.actual - act("Estavel", "2026-08")) < 0.02));
  const { RetailForecastService: RF } = await import("../src/server/RetailForecastService.js");
  check("o replay devolve a MESMA faixa que a previsão daquele dia (sem recálculo próprio)", (() => { const x = st("Estavel").runs.find((y: any) => y.month === "2026-08" && y.checkpointDay === 15); const f = RF.storeForecast(A, { id: estavel.id, name: "Estavel" }, { asOf: "2026-08-15", month: "2026-08" }); return !!x && f.status === "ok" && x.low === f.projection.low && x.mid === f.projection.mid && x.high === f.projection.high; })());
  // choque: nível mudou sem aviso → fora da faixa, com erro pelo lado certo (previsão abaixo do real → errorPct < 0)
  const sepRuns = st("Choque").runs.filter((x: any) => x.month === "2026-09" && x.checkpointDay <= 15);
  check("mudança de nível não prevista: setembro fica FORA da faixa nos pontos 10 e 15, com erro NEGATIVO (previsão abaixo do real)", sepRuns.length === 2 && sepRuns.every((x: any) => x.inBand === false && x.errorPct < 0), JSON.stringify(sepRuns.map((x: any) => [x.inBand, x.errorPct])));
  check("meses sem choque do mesmo store seguem dentro da faixa (o teste distingue)", st("Choque").runs.filter((x: any) => x.month !== "2026-09").some((x: any) => x.inBand === true));
  // recusas e meses incompletos
  check("histórico curto: a previsão se recusa e isso CONTA em skipped (não some, não vira zero acerto)", st("Curta").runs.length === 0 && (r.skipped.forecastRefused.insufficient_history || 0) > 0);
  check("mês com dia de funcionamento sem fechamento NÃO é comparado: agosto da loja 'Furo' descartado e contado", st("Furo").runs.every((x: any) => x.month !== "2026-08") && st("Furo").runs.some((x: any) => x.month === "2026-09") && r.skipped.actualIncomplete === 3);
  // agregados
  const all = r.stores.flatMap((s: any) => s.runs);
  check("agregado por ponto de leitura: n = nº de comparações daquele dia; headline = ponto com mais amostras", r.byCheckpoint.every((c: any) => c.n === all.filter((x: any) => x.checkpointDay === c.checkpointDay).length) && r.overall.runsTotal === all.length && r.overall.n === Math.max(...r.byCheckpoint.map((c: any) => c.n)));
  check("amostra pequena é dita: abaixo do mínimo o veredito é 'insufficient_data' e a confiança fica baixa", r.overall.n < MIN_SAMPLES ? (r.overall.verdict === "insufficient_data" && r.confidence.level === "baixa") : true);
  check("vies/erro e largura da faixa vêm das comparações (mediana do erro assinado; nulos quando não há dado)", r.bias.medianErrorPct != null && r.bias.meanAbsErrorPct >= 0 && r.medianBandWidthPct > 0 && /ACIMA/.test(r.bias.note));
  check("probabilidade de meta: sem meta cadastrada → n=0 e números nulos (não inventa 0%)", r.goalProbability.n === 0 && r.goalProbability.meanStatedPct === null && r.goalProbability.observedHitPct === null);
  // com meta
  db.prepare(`INSERT INTO retail_store_monthly_goals (id, organization_id, store_id, month, goal_amount) VALUES (?, ?, ?, ?, 40000)`).run(randomUUID(), A, estavel.id, "2026-09");
  const rg = B.run(A, { today: TODAY });
  check("com meta: compara a probabilidade declarada com o resultado observado (meta batida ou não)", rg.goalProbability.n > 0 && rg.goalProbability.meanStatedPct != null && rg.goalProbability.observedHitPct != null);
  check("a confiança do backtest nunca é 'alta'", r.confidence.level !== ("alta" as string) && rg.confidence.level !== ("alta" as string) && r.caveats.some((c: string) => /PASSADO/.test(c)) && r.caveats.some((c: string) => /comiss/i.test(c)));

  // veredito (puro)
  check("veredito: sem dado → no_data; <8 amostras → insufficient_data; muito abaixo de 80% → faixa estreita; ~80% → compatível; ~100% com muita amostra → folgada",
    verdictOf(0, 0).verdict === "no_data" && verdictOf(7, 7).verdict === "insufficient_data" && verdictOf(4, 20).verdict === "band_too_narrow" && verdictOf(16, 20).verdict === "compatible_with_nominal" && verdictOf(40, 40).verdict === "band_conservative" && verdictOf(0, 0).hitRate === null);

  // validação
  check("valida meses e pontos de leitura", thrown(() => B.run(A, { months: 0 })) === "invalid_months" && thrown(() => B.run(A, { months: 13 })) === "invalid_months" && thrown(() => B.run(A, { months: "abc" })) === "invalid_months"
    && thrown(() => B.run(A, { checkpoints: "28" })) === "invalid_checkpoints" && thrown(() => B.run(A, { checkpoints: "10,10" })) === "invalid_checkpoints" && thrown(() => B.run(A, { checkpoints: "1,2,3,4,5" })) === "invalid_checkpoints" && B.run(A, { today: TODAY, months: 1, checkpoints: "12" }).checkpoints.join() === "12");

  // isolamento
  const o = B.run(OTHER, { today: TODAY });
  check("isolamento: empresa sem lojas → nenhuma comparação, veredito no_data, sem vazar a outra", o.stores.length === 0 && o.overall.verdict === "no_data" && o.overall.hitRate === null);

  // rota
  const { default: router } = await import("../src/server/routes/health.js");
  const express = (await import("express")).default;
  const who: any = { dono, vend };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-anon"] ? undefined : A; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/health-center", router);
  const server = http.createServer(app); await new Promise<void>((x) => server.listen(0, x));
  const port = (server.address() as any).port;
  const get = async (u: string, user: string, anon = false) => { const x = await fetch(`http://127.0.0.1:${port}/api/health-center${u}`, { headers: { "x-user": user, ...(anon ? { "x-anon": "1" } : {}) } }); return { status: x.status, body: await x.json().catch(() => ({})) as any }; };
  const g = await get("/forecast-backtest?months=2&checkpoints=10,20", "dono");
  check("rota: gestor lê (200) com meses/pontos por query", g.status === 200 && g.body.type === "forecast_backtest" && g.body.months.length === 2 && g.body.checkpoints.join() === "10,20");
  check("rota: vendedor 403, sem empresa 401, parâmetro inválido 400 com código", (await get("/forecast-backtest", "vend")).status === 403 && (await get("/forecast-backtest", "dono", true)).status === 401 && (await get("/forecast-backtest?months=99", "dono")).body.code === "invalid_months");
  server.close();

  // composição
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/ForecastBacktestService.ts"), "utf8").replace(/\/\*\*[\s\S]*?\*\//g, "");
  check("reusa o RetailForecastService (replay) e o Wilson; não reimplementa a previsão", /RetailForecastService\.storeForecast/.test(src) && /wilsonInterval/.test(src) && !/normalCdf|Z80|byDow|LOOKBACK/.test(src));
  check("só leitura: sem INSERT/UPDATE/DELETE, sem sinal/ação/envio", !/\b(INSERT|UPDATE|DELETE)\b|BusinessSignalService|DecisionActionService|CommandExecutor|MessageProvider/.test(src));

  for (const x of results) console.log(`${x.ok ? "PASS" : "FAIL"}  ${x.name}${x.ok ? "" : "  → " + x.d}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
