/**
 * TESTE — ADR-204 F3.4: PREVISÃO DO MÊS por loja (RetailForecastService + retailCalendar).
 * ----------------------------------------------------------------------------
 * Prova, nos serviços REAIS, com fechamentos diários simulados:
 *   A) calendário (puro): Páscoa/Carnaval/Corpus Christi/Black Friday/Dia das Mães/Pais, 12/10 fundido, filtro de intervalo;
 *   B) previsão: fechado + média do dia da semana dos dias que faltam; faixa ≈80%; feriado/data comercial FORA do padrão e,
 *      quando ainda vem no mês, alarga a faixa e derruba a confiança (sem fator inventado);
 *   C) meta: lida, NUNCA alterada; fallback = soma das cotas (declarado); sem meta → sem probabilidade; falta/por-dia são aritmética;
 *   D) gate de dados (RN-F3-5): < 12 semanas (Bangu), sem fechamento, amostra fraca do dia da semana → "histórico insuficiente"
 *      com motivo; dado atrasado → `stale_data`; 1–2 dias sem fechamento entram como INCERTOS; mês fechado → `month_complete`;
 *   E) loja fechada em dia fixo não entra nos dias a projetar; a hora do PDV nunca é usada; rede em quadratura, só lojas projetáveis;
 *   F) só leitura (nada escrito), isolado por empresa, rota dono/admin (403/200).
 *
 * Uso:  npm run test:retail-forecast
 */
import os from "os";
import path from "path";
import fs from "fs";
import http from "http";
import { randomUUID } from "crypto";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zf-retail-forecast-"));
process.env.DATA_DIR = tmpDir;
process.env.NODE_ENV = "production";
process.env.JWT_SECRET = "test-secret-retail-forecast-1234567890";

let failures = 0;
const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = "") { results.push({ name, ok, detail }); if (!ok) failures++; }
const DAY = 86400e3;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dowOf = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

async function main() {
  const cal = await import("../src/server/retailCalendar.js");
  const { default: db } = await import("../src/server/db.js");
  const { RetailForecastService: F } = await import("../src/server/RetailForecastService.js");
  const { PermissionService: PM } = await import("../src/server/PermissionService.js");

  // ── A) calendário ──
  check("Páscoa 2026 = 05/04; 2025 = 20/04", cal.easterSunday(2026) === "2026-04-05" && cal.easterSunday(2025) === "2025-04-20");
  const y26 = cal.specialDaysOfYear(2026); const has = (d: string, n?: RegExp) => y26.some((s: any) => s.date === d && (!n || n.test(s.name)));
  check("móveis: Carnaval 16–17/02, Sexta Santa 03/04, Corpus Christi 04/06", has("2026-02-16") && has("2026-02-17") && has("2026-04-03") && has("2026-06-04"));
  check("comerciais: Dia das Mães 10/05, Pais 09/08, Namorados 12/06, Black Friday 27/11", has("2026-05-10", /Mães/) && has("2026-08-09", /Pais/) && has("2026-06-12") && has("2026-11-27", /Black/));
  check("Consciência Negra só a partir de 2024", cal.specialDaysOfYear(2023).every((s: any) => !/Consci/.test(s.name)) && cal.specialDaysOfYear(2026).some((s: any) => /Consci/.test(s.name)));
  const mid = cal.specialDaysBetween("2026-10-01", "2026-10-31");
  check("intervalo + 12/10 fundido num item só (Aparecida / Crianças)", mid.length === 1 && mid[0].date === "2026-10-12" && /Aparecida/.test(mid[0].name) && /Crianças/.test(mid[0].name), JSON.stringify(mid));
  check("intervalo que cruza o ano", cal.specialDaysBetween("2026-12-20", "2027-01-02").map((s: any) => s.date).join() === "2026-12-24,2026-12-25,2027-01-01");

  // ── fixtures ──
  const mkOrg = () => { const id = `org_${randomUUID().slice(0, 8)}`; db.prepare(`INSERT INTO organization_settings (id, organization_id, business_name, status) VALUES (?, ?, 'X', 'active')`).run(randomUUID(), id); PM.seedSystemProfiles(id); return id; };
  const A = mkOrg(), B = mkOrg();
  const mkUser = (org: string, role: string, name: string) => { const id = randomUUID(); db.prepare(`INSERT INTO users (id, organization_id, name, email, role, global_status) VALUES (?, ?, ?, ?, ?, 'active')`).run(id, org, name, `${id}@t.local`, role); return { userId: id, id, role, name, email: `${id}@t.local` }; };
  const maria = mkUser(A, "owner", "Maria"), joao = mkUser(A, "agent", "João");
  const mkStore = (org: string, name: string, closedWeekdays?: number[]) => { const id = randomUUID(); db.prepare(`INSERT INTO retail_stores (id, organization_id, name, code, active, closed_weekdays) VALUES (?, ?, ?, ?, 1, ?)`).run(id, org, name, name.slice(0, 3), closedWeekdays ? JSON.stringify(closedWeekdays) : null); return { id, name }; };
  const BASE = [2000, 1500, 1600, 1700, 1800, 2600, 3200];          // dom..sáb
  const noise = (i: number) => ((i % 5) - 2) * 60;                   // simétrico: média ≈ 0
  const close = (org: string, storeId: string, date: string, total: number, status = "approved") =>
    db.prepare(`INSERT OR REPLACE INTO retail_daily_closings (id, organization_id, store_id, closing_date, status, system_total, informed_total) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), org, storeId, date, status, total, total);
  const seed = (org: string, storeId: string, from: string, to: string, o: { skip?: string[]; closedDow?: number[]; over?: Record<string, number> } = {}) => {
    let i = 0;
    for (let d = from; d <= to; d = addDays(d, 1), i++) {
      if ((o.closedDow || []).includes(dowOf(d)) || (o.skip || []).includes(d)) continue;
      close(org, storeId, d, o.over?.[d] ?? BASE[dowOf(d)] + noise(i));
    }
  };
  const ASOF = "2026-10-10", MONTH = "2026-10";                      // sábado
  const carioca = mkStore(A, "Carioca"), bangu = mkStore(A, "Bangu"), nova = mkStore(A, "Nova"), brasil = mkStore(A, "Brasil", [0]);
  seed(A, carioca.id, "2026-03-01", ASOF, { over: { "2026-09-07": 9000 } });  // 7/9 feriado: outlier que NÃO pode contaminar o padrão
  seed(A, bangu.id, addDays(ASOF, -42), ASOF);                               // 6 semanas
  seed(A, brasil.id, "2026-03-01", ASOF, { closedDow: [0] });
  db.prepare(`INSERT INTO retail_store_monthly_goals (id, organization_id, store_id, month, goal_amount) VALUES (?, ?, ?, ?, 60000)`).run(randomUUID(), A, carioca.id, MONTH);

  const sum = (rows: any[]) => rows.reduce((a, r) => a + r.t, 0);
  const soldOct = (db.prepare(`SELECT SUM(system_total) t FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date BETWEEN '2026-10-01' AND ?`).get(A, carioca.id, ASOF) as any).t;
  const NOW = Date.parse("2026-10-11T12:00:00Z");
  const r1 = F.forecast(A, { asOf: ASOF, month: MONTH, now: NOW });
  const c = r1.stores.find((s: any) => s.storeId === carioca.id);

  // ── B) previsão ──
  check("loja com histórico: status ok e o FECHADO é fato (soma exata do mês até ontem)", c.status === "ok" && Math.abs(c.sold - soldOct) < 0.01, `${c.status} ${c.sold} vs ${soldOct}`);
  check("faixa ordenada low < mid < high, rotulada como estimativa ≈80%", c.projection.low < c.projection.mid && c.projection.mid < c.projection.high && c.projection.basis === "estimate" && /80%/.test(c.projection.band));
  const remaining: string[] = []; for (let d = addDays(ASOF, 1); d <= "2026-10-31"; d = addDays(d, 1)) remaining.push(d);
  const expected = c.sold + remaining.reduce((a, d) => a + BASE[dowOf(d)], 0);
  check("mid ≈ fechado + soma da média do dia da semana dos dias que faltam (±3%)", Math.abs(c.projection.mid - expected) / expected < 0.03, `${c.projection.mid} vs ${expected}`);
  check("o mês tem 21 dias a projetar", c.remainingOpenDays === 21 && c.pendingDays.length === 0);
  check("feriado/data comercial que ainda vem (12/10) listado, confiança BAIXA e com o motivo", c.specialDays.length === 1 && c.specialDays[0].date === "2026-10-12" && c.confidence.label === "baixa" && c.confidence.reasons.some((x: string) => /datas especiais/.test(x)));
  // o outlier de 7/9 (feriado) é tirado do padrão: mudar o valor dele não muda a previsão
  const mid0 = c.projection.mid;
  close(A, carioca.id, "2026-09-07", 100);
  const c2 = F.storeForecast(A, carioca, { asOf: ASOF, month: MONTH });
  check("o feriado do histórico NÃO entra no padrão do dia da semana (9000 → 100 não muda nada)", Math.abs(c2.projection.mid - mid0) < 0.01, `${c2.projection.mid} vs ${mid0}`);
  // sem data especial → faixa mais estreita e confiança melhor
  const cEarly = F.storeForecast(A, carioca, { asOf: "2026-10-13", month: MONTH });
  seed(A, carioca.id, "2026-10-11", "2026-10-13");
  const cNoSpecial = F.storeForecast(A, carioca, { asOf: "2026-10-13", month: MONTH });
  check("depois da data especial, sem outra no mês: confiança sobe (alta, ≥24 semanas) e a faixa estreita", cNoSpecial.confidence.label === "alta" && (cNoSpecial.projection.high - cNoSpecial.projection.low) < (c.projection.high - c.projection.low));
  void cEarly;

  // ── C) meta ──
  check("meta mensal usada e rotulada", c.goal.amount === 60000 && c.goal.source === "meta_mensal");
  check("falta = meta − fechado (aritmética sobre a meta, não estimativa)", Math.abs(c.falta - (60000 - c.sold)) < 0.01);
  check("por dia que falta: aritmética; comparado ao dia típico", Math.abs(c.neededPerOpenDay - c.falta / c.remainingOpenDays) < 0.02 && typeof c.neededVsTypicalPct === "number");
  const probOf = (goal: number) => { db.prepare(`UPDATE retail_store_monthly_goals SET goal_amount = ? WHERE organization_id = ? AND store_id = ?`).run(goal, A, carioca.id); return F.storeForecast(A, carioca, { asOf: ASOF, month: MONTH }).goalProbability; };
  const pLow = probOf(30000), pMid = probOf(Math.round(c2.projection.mid)), pHigh = probOf(120000);
  check("meta muito baixa → muito provável; meta no meio → incerto; meta enorme → muito improvável", pLow.label === "muito provável" && pMid.label === "incerto" && pHigh.label === "muito improvável", JSON.stringify([pLow, pMid, pHigh]));
  check("probabilidade arredondada (múltiplos de 5), NUNCA 0% nem 100% (é estimativa) e rotulada como tal", [pLow, pMid, pHigh].every((p) => p.pct % 5 === 0 && p.pct >= 5 && p.pct <= 95 && p.basis === "estimate") && pLow.pct === 95 && pHigh.pct === 5);
  check("o aviso diz que a faixa não cobre mudança de tendência/promoção/ruptura", c.caveats.some((x: string) => /tendência/.test(x)));
  db.prepare(`DELETE FROM retail_store_monthly_goals WHERE organization_id = ? AND store_id = ?`).run(A, carioca.id);
  const noGoal = F.storeForecast(A, carioca, { asOf: ASOF, month: MONTH });
  check("sem meta e sem cotas → goal null e NENHUMA probabilidade/falta inventada", noGoal.goal.amount === null && !("goalProbability" in noGoal) && !("falta" in noGoal));
  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, '2026-10-05', 1000)`).run(randomUUID(), A, carioca.id);
  db.prepare(`INSERT INTO retail_store_quotas (id, organization_id, store_id, quota_date, quota_amount) VALUES (?, ?, ?, '2026-10-06', 1500)`).run(randomUUID(), A, carioca.id);
  const viaQuota = F.storeForecast(A, carioca, { asOf: ASOF, month: MONTH });
  check("sem meta mensal → usa a SOMA DAS COTAS DIÁRIAS e declara a origem", viaQuota.goal.amount === 2500 && viaQuota.goal.source === "soma_das_cotas");
  db.prepare(`INSERT INTO retail_store_monthly_goals (id, organization_id, store_id, month, goal_amount) VALUES (?, ?, ?, ?, 60000)`).run(randomUUID(), A, carioca.id, MONTH);

  // ── D) gate de dados ──
  const bg = r1.stores.find((s: any) => s.storeId === bangu.id), nv = r1.stores.find((s: any) => s.storeId === nova.id);
  check("loja com < 12 semanas (Bangu) → histórico insuficiente com o motivo; sem faixa", bg.status === "insufficient_history" && /12 semanas/.test(bg.reason) && !bg.projection);
  check("loja sem nenhum fechamento → no_closings", nv.status === "no_closings" && !nv.projection);
  const weak = mkStore(A, "Fraca"); seed(A, weak.id, "2026-03-01", ASOF, { closedDow: [] });
  db.prepare(`DELETE FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND strftime('%w', closing_date) = '3' AND closing_date > '2026-08-15'`).run(A, weak.id);
  const wk = F.storeForecast(A, weak, { asOf: ASOF, month: MONTH });
  check("amostra fraca de um dia da semana que ainda vem → insuficiente, citando o dia", wk.status === "insufficient_history" && /quarta/.test(wk.reason), wk.reason);
  const stale = mkStore(A, "Atrasada"); seed(A, stale.id, "2026-03-01", ASOF, { skip: ["2026-10-02", "2026-10-03", "2026-10-06", "2026-10-07"] });
  const st = F.storeForecast(A, stale, { asOf: ASOF, month: MONTH });
  check("4 dias úteis do mês sem fechamento → stale_data (não projeta em cima de buraco)", st.status === "stale_data" && st.pendingDays.length === 4 && !st.projection);
  const late = mkStore(A, "Quase"); seed(A, late.id, "2026-03-01", ASOF, { skip: ["2026-10-09", "2026-10-10"] });
  const lt = F.storeForecast(A, late, { asOf: ASOF, month: MONTH });
  check("1–2 dias ainda sem fechamento viram INCERTOS (listados), nunca fato", lt.status === "ok" && lt.pendingDays.join() === "2026-10-09,2026-10-10" && lt.remainingOpenDays === 21 && lt.confidence.reasons.some((x: string) => /sem fechamento/.test(x)) && lt.confidence.label !== "alta");
  check("o fechado desses incompletos NÃO inclui os dias pendentes", lt.sold < c.sold);
  const done = F.storeForecast(A, carioca, { asOf: "2026-10-31", month: MONTH });
  check("mês já fechado → month_complete (nada a projetar)", done.status === "month_complete" && done.sold > 0);
  const early = F.storeForecast(A, carioca, { asOf: "2026-09-30", month: MONTH });
  check("no dia 1º (asOf = fim do mês anterior): projeta o mês inteiro, fechado = 0", early.status === "ok" && early.sold === 0 && early.remainingOpenDays === 31);

  // ── E) fechada em dia fixo, hora, rede ──
  const br = r1.stores.find((s: any) => s.storeId === brasil.id);
  check("loja fechada aos domingos: os 3 domingos que faltam NÃO entram nos dias a projetar (21 − 3)", br.status === "ok" && br.remainingOpenDays === 18, String(br.remainingOpenDays));
  const src = fs.readFileSync(path.join(process.cwd(), "src/server/RetailForecastService.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  check("o código da previsão não lê hora do PDV nem a tabela de vendas do PDV", !/sale_time|retail_pdv_sales/.test(src));
  const okStores = r1.stores.filter((s: any) => s.status === "ok");
  check("rede: só as lojas projetáveis; as outras ficam em storesExcluded com o motivo", r1.network.storesProjected === okStores.length && r1.network.storesExcluded.some((x: any) => x.storeId === bangu.id && x.reason) && r1.network.storesExcluded.some((x: any) => x.storeId === nova.id));
  const netWidth = r1.network.projection.high - r1.network.projection.low, sumWidth = okStores.reduce((a: number, s: any) => a + (s.projection.high - s.projection.low), 0);
  check("rede soma σ em QUADRATURA (faixa da rede < soma das faixas das lojas) e não soma fato com estimativa", netWidth < sumWidth && Math.abs(r1.network.sold - okStores.reduce((a: number, s: any) => a + s.sold, 0)) < 0.01 && r1.network.projection.basis === "estimate");

  // ── F) só leitura, isolamento, rota ──
  const snap = () => JSON.stringify([db.prepare(`SELECT COUNT(*) c FROM business_signals WHERE organization_id = ?`).get(A), db.prepare(`SELECT goal_amount FROM retail_store_monthly_goals WHERE organization_id = ?`).all(A), db.prepare(`SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ?`).get(A)]);
  const s0 = snap(); F.forecast(A, { asOf: ASOF, month: MONTH, now: NOW });
  check("só leitura: não publica sinal, não cria ação e não toca a meta oficial", snap() === s0);
  const rB = F.forecast(B, { asOf: ASOF, month: MONTH, now: NOW });
  check("isolamento: empresa B não vê nada de A", rB.stores.length === 0 && rB.network.storesProjected === 0 && rB.network.projection === null);

  const express = (await import("express")).default;
  const router = (await import("../src/server/routes/retailops.js")).default;
  const who: Record<string, any> = { maria, joao };
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.organizationId = req.headers["x-org"] || undefined; req.user = who[String(req.headers["x-user"])]; next(); });
  app.use("/api/retail", router);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as any).port;
  const get = async (url: string, user: string | null, org: string | null) => { const h: any = {}; if (user) h["x-user"] = user; if (org) h["x-org"] = org; const r = await fetch(`http://127.0.0.1:${port}/api/retail${url}`, { headers: h }); return { status: r.status, body: await r.json().catch(() => ({})) as any }; };
  const g1 = await get(`/forecast?asOf=${ASOF}&month=${MONTH}`, "maria", A);
  check("rota: dono lê a previsão", g1.status === 200 && Array.isArray(g1.body.stores) && g1.body.dataBasis.includes("hora da venda não é usada"));
  check("rota: quem não é dono/admin → 403", (await get(`/forecast`, "joao", A)).status === 403);
  check("rota: sem empresa → 401/403", [401, 403].includes((await get(`/forecast`, null, null)).status));
  server.close();

  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  → " + r.detail}`);
  console.log(`\n${results.length - failures}/${results.length} checks`);
  void sum;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  process.exit(failures ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
