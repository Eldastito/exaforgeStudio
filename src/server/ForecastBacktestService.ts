import db from "./db.js";
import { RetailForecastService } from "./RetailForecastService.js";
import { RetailClosingService } from "./RetailOpsService.js";
import { wilsonInterval } from "./statsWilson.js";
import { todaySP } from "./spDate.js";

/**
 * ForecastBacktestService — ADR-205 F4.7 (backtest da PREVISÃO DO MÊS por loja, ADR-204 F3.4).
 *
 * Pergunta que responde: "se eu tivesse olhado a previsão no dia 10/15/20 de cada mês passado, a faixa de 80% teria
 * contido o que realmente aconteceu?" — ou seja, mede se a previsão merece a confiança que declara. REPLAY do mesmo
 * `RetailForecastService.storeForecast` (nenhum cálculo duplicado, RN-F4-11) em datas passadas, comparado ao fechamento
 * real do mês. Só leitura; não toca produção, não grava, não recalibra nada.
 *
 * Regras:
 *  - RN-F4-8: backtest ≠ promessa. Diz como o MODELO se comportou no passado, não que vai se repetir; nunca vira previsão.
 *  - Mês real só vale COMPLETO: dia de funcionamento sem fechamento → o mês daquela loja é descartado (`actualIncomplete`), não comparado.
 *  - Amostra pequena é dita: abaixo de MIN_SAMPLES o veredito é `insufficient_data`; a taxa de acerto vem com intervalo de Wilson.
 *  - Lojas/meses em que a previsão se recusou (histórico curto, dado atrasado) contam em `skipped` — recusar também é informação.
 *  - Sem dado → null, nunca 0. Confiança do backtest nunca é "alta".
 *  - Limites declarados: o replay lê os fechamentos COMO ESTÃO HOJE (correções posteriores entram), meta e dias de loja fechada
 *    também são os de hoje; os checkpoints do mesmo mês/loja e as lojas do mesmo mês NÃO são independentes.
 *  - Isolado por organização. Dono/gestor (mostra faturamento). NÃO cobre backtest de comissão/política/campanha (dependem de
 *    regras como dado e de histórico por vendedor/dia ainda não conferidos).
 */
export const NOMINAL_COVERAGE = 0.8;
export const MIN_SAMPLES = 8;
const DEFAULT_MONTHS = 3, MAX_MONTHS = 12, DEFAULT_CHECKPOINTS = [10, 15, 20], MAX_CHECKPOINTS = 4;

const bad = (code: string, message: string) => Object.assign(new Error(message), { code });
const round2 = (n: number) => Math.round(n * 100) / 100;
const pad = (n: number) => String(n).padStart(2, "0");
const monthEnd = (m: string) => { const [y, mo] = m.split("-").map(Number); return new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10); };
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const median = (v: number[]) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), h = Math.floor(s.length / 2); return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

function lastClosedMonths(today: string, n: number): string[] {
  let y = +today.slice(0, 4), m = +today.slice(5, 7);
  const out: string[] = [];
  for (let i = 0; i < n; i++) { m -= 1; if (m === 0) { m = 12; y -= 1; } out.push(`${y}-${pad(m)}`); }
  return out.reverse();
}

export function verdictOf(hits: number, n: number): { verdict: string; hitRate: number | null; interval: { lower: number; upper: number } | null } {
  if (n === 0) return { verdict: "no_data", hitRate: null, interval: null };
  const iv = wilsonInterval(hits, n);
  const base = { hitRate: round2(hits / n), interval: iv ? { lower: round2(iv.lower), upper: round2(iv.upper) } : null };
  if (n < MIN_SAMPLES || !iv) return { verdict: "insufficient_data", ...base };
  if (iv.upper < NOMINAL_COVERAGE) return { verdict: "band_too_narrow", ...base };
  if (iv.lower > NOMINAL_COVERAGE) return { verdict: "band_conservative", ...base };
  return { verdict: "compatible_with_nominal", ...base };
}

export class ForecastBacktestService {
  static run(orgId: string, opts: { months?: unknown; checkpoints?: unknown; today?: string } = {}) {
    const today = opts.today || todaySP();
    const months = opts.months == null || opts.months === "" ? DEFAULT_MONTHS : Number(opts.months);
    if (!Number.isInteger(months) || months < 1 || months > MAX_MONTHS) throw bad("invalid_months", `Número de meses inválido (1 a ${MAX_MONTHS}).`);
    const cps = opts.checkpoints == null || opts.checkpoints === "" ? DEFAULT_CHECKPOINTS : (Array.isArray(opts.checkpoints) ? opts.checkpoints : String(opts.checkpoints).split(",")).map(Number);
    if (!cps.length || cps.length > MAX_CHECKPOINTS || cps.some((c) => !Number.isInteger(c) || c < 1 || c > 27) || new Set(cps).size !== cps.length) throw bad("invalid_checkpoints", `Pontos de leitura inválidos (até ${MAX_CHECKPOINTS} dias distintos entre 1 e 27).`);
    cps.sort((a, b) => a - b);

    const monthList = lastClosedMonths(today, months);
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    const skipped: Record<string, number> = {};
    let actualIncomplete = 0;
    const runs: any[] = [];
    const storeOut = stores.map((s) => {
      const sRuns: any[] = [];
      for (const month of monthList) {
        const from = `${month}-01`, to = monthEnd(month);
        const totals = RetailForecastService.dailyTotals(orgId, s.id, from, to);
        let missing = 0;
        for (let d = from; d <= to; d = addDays(d, 1)) if (!totals.has(d) && !RetailClosingService.isStoreClosedOnDate(orgId, s.id, d)) missing++;
        if (!totals.size || missing > 0) { actualIncomplete++; continue; }
        const actual = round2([...totals.values()].reduce((a, b) => a + b, 0));
        for (const day of cps) {
          const asOf = `${month}-${pad(day)}`;
          const f = RetailForecastService.storeForecast(orgId, { id: s.id, name: s.name }, { asOf, month });
          if (f.status !== "ok") { skipped[f.status] = (skipped[f.status] || 0) + 1; continue; }
          const { low, mid, high } = f.projection;
          const goalAmt = f.goal?.amount ?? null;
          const run = {
            storeId: s.id, storeName: s.name, month, checkpointDay: day, asOf, low, mid, high, actual,
            inBand: actual >= low && actual <= high,
            errorPct: mid > 0 ? round2(((mid - actual) / actual) * 100) : null,   // >0 = a previsão pecou por EXCESSO
            bandWidthPct: mid > 0 ? round2(((high - low) / mid) * 100) : null,
            goal: goalAmt, goalProbabilityPct: f.goalProbability?.pct ?? null, goalHit: goalAmt != null ? actual >= goalAmt : null,
          };
          sRuns.push(run); runs.push(run);
        }
      }
      const v = verdictOf(sRuns.filter((r) => r.inBand).length, sRuns.length);
      return { storeId: s.id, storeName: s.name, runs: sRuns, summary: { n: sRuns.length, inBand: sRuns.filter((r) => r.inBand).length, ...v } };
    });

    const byCheckpoint = cps.map((day) => {
      const rs = runs.filter((r) => r.checkpointDay === day), hits = rs.filter((r) => r.inBand).length;
      return { checkpointDay: day, n: rs.length, inBand: hits, ...verdictOf(hits, rs.length) };
    });
    // Headline = ponto de leitura com MAIS amostras (empate → o mais tardio): os checkpoints do mesmo mês não são independentes, então não se empilha.
    const primary = [...byCheckpoint].sort((a, b) => b.n - a.n || b.checkpointDay - a.checkpointDay)[0];
    const errs = runs.map((r) => r.errorPct).filter((x): x is number => x != null);
    const widths = runs.map((r) => r.bandWidthPct).filter((x): x is number => x != null);
    const gp = runs.filter((r) => r.goalProbabilityPct != null && r.goalHit != null);
    const goalProbability = {
      n: gp.length,
      meanStatedPct: gp.length ? round2(gp.reduce((a, r) => a + r.goalProbabilityPct, 0) / gp.length) : null,
      observedHitPct: gp.length ? round2((gp.filter((r) => r.goalHit).length / gp.length) * 100) : null,
    };

    const reasons: string[] = [];
    if (!runs.length) reasons.push("Nenhuma previsão pôde ser reproduzida (histórico curto, meses incompletos ou sem lojas).");
    else if (primary.n < MIN_SAMPLES) reasons.push(`Só ${primary.n} previsão(ões) comparáveis no melhor ponto de leitura (mínimo ${MIN_SAMPLES}).`);
    reasons.push("Lojas e checkpoints do mesmo mês não são independentes: o intervalo real é mais largo que o mostrado.");
    return {
      type: "forecast_backtest" as const, isForecast: false, executes: false, promise: false,
      nominalCoverage: NOMINAL_COVERAGE, months: monthList, checkpoints: cps, minSamples: MIN_SAMPLES,
      overall: runs.length ? { primaryCheckpointDay: primary.checkpointDay, n: primary.n, inBand: primary.inBand, hitRate: primary.hitRate, interval: primary.interval, verdict: primary.verdict, runsTotal: runs.length } : { primaryCheckpointDay: null, n: 0, inBand: 0, hitRate: null, interval: null, verdict: "no_data", runsTotal: 0 },
      byCheckpoint,
      bias: { medianErrorPct: errs.length ? round2(median(errs) as number) : null, meanAbsErrorPct: errs.length ? round2(errs.reduce((a, b) => a + Math.abs(b), 0) / errs.length) : null, note: "erro > 0 = a previsão central ficou ACIMA do real" },
      medianBandWidthPct: widths.length ? round2(median(widths) as number) : null,
      goalProbability,
      stores: storeOut,
      skipped: { forecastRefused: skipped, actualIncomplete },
      confidence: { level: runs.length && primary.n >= MIN_SAMPLES ? ("media" as const) : ("baixa" as const), reasons },
      caveats: [
        "Backtest descreve como a previsão se comportou no PASSADO; não promete que vai se repetir (mudança de tendência, promoção ou ruptura não aparecem).",
        "O replay usa os fechamentos como estão hoje (correções posteriores entram), e a meta e os dias de loja fechada de hoje.",
        "Faixa nominal ≈ 80%: taxa de acerto bem abaixo diz que a faixa está estreita demais; bem acima, que está folgada demais. Nada é recalibrado automaticamente.",
        "Não cobre backtest de comissão, política ou campanha: dependem de regras como dado e de histórico por vendedor/dia ainda não conferidos.",
      ],
    };
  }
}
export default ForecastBacktestService;
