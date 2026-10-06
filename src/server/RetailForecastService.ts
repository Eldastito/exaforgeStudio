import db from "./db.js";
import { RetailClosingService } from "./RetailOpsService.js";
import { RetailMonthlyGoalService } from "./RetailMonthlyGoalService.js";
import { officialSaleSourceOf, officialSaleSql } from "./RetailSalesPolicy.js";
import { specialDaysBetween } from "./retailCalendar.js";

/**
 * RetailForecastService — PREVISÃO DO MÊS por loja (ADR-204 F3.4, PRD Fase 3 §12).
 *
 * Responde: "no ritmo atual, onde a loja fecha o mês, com que faixa, e qual a chance de bater a meta?" — SEM mexer na meta.
 *
 * BASE: os FECHAMENTOS OFICIAIS por dia (`retail_daily_closings`, a mesma base do "Mês X / R$ meta" do fechamento da noite) —
 * a data é confiável; a HORA da venda NÃO é (decisão do dono, 2026-10) → NADA aqui é intradiário: não existe "projeção de
 * fechamento do DIA" nem faixa por hora. É por loja × dia da semana × mês.
 *
 * MODELO (determinístico, sem LLM): fechado até ontem + soma, nos dias de funcionamento que faltam, da média do próprio dia da
 * semana (últimas 12 semanas, tirando feriados/datas comerciais). Faixa ≈ 80% (±1,28σ, dias independentes — premissa declarada);
 * probabilidade de bater a meta pela aproximação normal; "o que falta" e "quanto por dia" são aritmética sobre a meta.
 *
 * REGRAS (RN-F3-*):
 *  - RN-F3-5 (gate de dados): só projeta loja com ≥12 semanas de fechamentos e ≥6 amostras de cada dia da semana que ainda
 *    vem; senão `insufficient_history` com o motivo — nunca inventa faixa (ex.: loja nova, como Bangu).
 *  - RN-F3-6: a META OFICIAL é lida, jamais alterada/sugerida. Sem meta mensal → usa a soma das cotas diárias (declarado);
 *    sem nenhuma → sem probabilidade (`goal:null`), nunca meta inventada.
 *  - Dado atrasado (> 2 dias úteis sem fechamento no mês) → `stale_data`: não projeta em cima de buraco. 1–2 dias ainda não
 *    fechados entram como INCERTOS (estimados e listados), nunca somados como fato.
 *  - Datas especiais (feriados/Black Friday…) que ainda vêm: o dia usa a média do dia da semana (melhor dado que há — NÃO se
 *    inventa fator), mas a faixa é alargada (σ ≥ 50% da média) e a confiança cai. Feriado local/estadual não está no calendário.
 *  - fato ≠ estimativa: `sold` é fato; faixa/probabilidade são estimativa e nunca são somadas ao fato como se fossem dele.
 *  - Dinheiro: a rota é dono/admin sem trava de loja. Isolado por organização. Só leitura (não publica nada).
 */
const DAY = 86400e3;
const LOOKBACK_DAYS = 84;           // 12 semanas
const MIN_HISTORY_DAYS = 84;        // ≥ 12 semanas desde o 1º fechamento
const MIN_WEEKDAY_SAMPLES = 6;
const MAX_PENDING_DAYS = 2;         // dias úteis do mês passado sem fechamento tolerados (viram incerteza)
const Z80 = 1.2816;                 // 10%–90%
const SPECIAL_MIN_SIGMA = 0.5;      // σ do dia especial ≥ 50% da média do dia da semana
const CLOSED_OK = "('received','extracted','needs_review','reconciled','divergent','approved')";

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const dow = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const round2 = (n: number) => Math.round(n * 100) / 100;
const todaySP = (now = Date.now()) => new Date(now).toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
const monthEnd = (month: string) => { const [y, m] = month.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

/** Φ(x) — normal padrão (Abramowitz-Stegun 7.1.26). */
function normalCdf(x: number): number {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}
const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
const variance = (v: number[]) => { if (v.length < 2) return 0; const m = mean(v); return v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1); };
const DOW_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

export type ForecastStatus = "ok" | "insufficient_history" | "stale_data" | "month_complete" | "no_closings";

function probabilityLabel(p: number): string {
  if (p >= 0.8) return "muito provável"; if (p >= 0.6) return "provável"; if (p >= 0.4) return "incerto";
  if (p >= 0.2) return "improvável"; return "muito improvável";
}

export class RetailForecastService {
  /** Total oficial por dia da loja (fechamentos aceitos). */
  private static dailyTotals(orgId: string, storeId: string, from: string, to: string): Map<string, number> {
    const off = officialSaleSql(officialSaleSourceOf(orgId));
    const rows = db.prepare(`SELECT closing_date d, SUM(${off}) t FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND closing_date BETWEEN ? AND ? AND status IN ${CLOSED_OK} GROUP BY closing_date`).all(orgId, storeId, from, to) as any[];
    const m = new Map<string, number>();
    for (const r of rows) { const t = Number(r.t); if (Number.isFinite(t) && t > 0) m.set(r.d, t); }
    return m;
  }

  private static goalFor(orgId: string, storeId: string, month: string): { amount: number | null; source: "meta_mensal" | "soma_das_cotas" | null } {
    const g = RetailMonthlyGoalService.get(orgId, storeId, month);
    if (g != null) return { amount: g, source: "meta_mensal" };
    const q = db.prepare(`SELECT SUM(quota_amount) s, COUNT(*) n FROM retail_store_quotas WHERE organization_id = ? AND store_id = ? AND quota_date LIKE ?`).get(orgId, storeId, `${month}-%`) as any;
    const s = Number(q?.s);
    return Number(q?.n) > 0 && Number.isFinite(s) && s > 0 ? { amount: round2(s), source: "soma_das_cotas" } : { amount: null, source: null };
  }

  /** Previsão do mês de UMA loja. `asOf` = último dia FECHADO considerado (default: ontem em SP). */
  static storeForecast(orgId: string, store: { id: string; name: string }, opts: { asOf: string; month: string }): any {
    const { asOf, month } = opts;
    const monthStart = `${month}-01`, mEnd = monthEnd(month);
    const base: any = { storeId: store.id, storeName: store.name, month, asOf };
    const first = (db.prepare(`SELECT MIN(closing_date) d FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? AND status IN ${CLOSED_OK}`).get(orgId, store.id) as any)?.d as string | null;
    if (!first) return { ...base, status: "no_closings", reason: "A loja ainda não tem nenhum fechamento diário registrado." };
    const historyDays = Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${first}T00:00:00Z`)) / DAY);
    const goal = this.goalFor(orgId, store.id, month);
    const upTo = asOf < mEnd ? asOf : mEnd;
    const soldMap = asOf >= monthStart ? this.dailyTotals(orgId, store.id, monthStart, upTo) : new Map<string, number>();
    const sold = round2([...soldMap.values()].reduce((a, b) => a + b, 0));
    if (asOf >= mEnd) return { ...base, status: "month_complete", sold, goal, historyDays, reason: "O mês já fechou — não há o que projetar." };

    // dias do mês JÁ passados, em que a loja abriu e ainda não há fechamento
    const pendingPast: string[] = [];
    for (let d = monthStart; d <= upTo && asOf >= monthStart; d = addDays(d, 1)) if (!soldMap.has(d) && !RetailClosingService.isStoreClosedOnDate(orgId, store.id, d)) pendingPast.push(d);
    if (pendingPast.length > MAX_PENDING_DAYS) return { ...base, status: "stale_data", sold, goal, historyDays, pendingDays: pendingPast, reason: `Faltam ${pendingPast.length} fechamentos de dias em que a loja abriu neste mês — não projeto em cima de dado incompleto.` };

    if (historyDays < MIN_HISTORY_DAYS) return { ...base, status: "insufficient_history", sold, goal, historyDays, reason: `A loja tem ${Math.max(0, Math.floor(historyDays / 30))} mês(es) de fechamentos; preciso de pelo menos 12 semanas para projetar com honestidade.` };

    // padrão do dia da semana: últimas 12 semanas, só dias abertos com venda, SEM feriado/data comercial
    const histFrom = addDays(asOf, -(LOOKBACK_DAYS - 1));
    const special = new Set(specialDaysBetween(histFrom, asOf).map((s) => s.date));
    const hist = this.dailyTotals(orgId, store.id, histFrom, asOf);
    const byDow: number[][] = [[], [], [], [], [], [], []];
    for (const [d, t] of hist) if (!special.has(d) && !RetailClosingService.isStoreClosedOnDate(orgId, store.id, d)) byDow[dow(d)].push(t);

    // dias a projetar: faltam no mês (depois de asOf) + passados ainda não fechados — só dias de funcionamento
    const horizon: string[] = [];
    for (let d = addDays(asOf < monthStart ? addDays(monthStart, -1) : asOf, 1); d <= mEnd; d = addDays(d, 1)) if (!RetailClosingService.isStoreClosedOnDate(orgId, store.id, d)) horizon.push(d);
    const days = [...pendingPast, ...horizon];
    const specialAhead = new Map(specialDaysBetween(days[0] || mEnd, mEnd).map((s) => [s.date, s]));
    const weakDow = [...new Set(days.map(dow))].filter((w) => byDow[w].length < MIN_WEEKDAY_SAMPLES);
    if (weakDow.length) return { ...base, status: "insufficient_history", sold, goal, historyDays, reason: `Poucas amostras de ${weakDow.map((w) => DOW_PT[w]).join(", ")} (preciso de ${MIN_WEEKDAY_SAMPLES} dias de funcionamento sem feriado de cada).` };

    let mu = 0, v = 0;
    const typical: number[] = [];
    for (const d of days) {
      const arr = byDow[dow(d)], m = mean(arr), s2 = variance(arr);
      mu += m; typical.push(m);
      v += specialAhead.has(d) ? Math.max(s2, (SPECIAL_MIN_SIGMA * m) ** 2) : s2;
    }
    const sigma = Math.sqrt(v);
    const mid = sold + mu, low = Math.max(sold, mid - Z80 * sigma), high = mid + Z80 * sigma;

    const reasons: string[] = [];
    let confidence: "alta" | "média" | "baixa" = historyDays >= 168 ? "alta" : "média";
    if (historyDays < 168) reasons.push("menos de 24 semanas de histórico");
    const minSamples = Math.min(...[...new Set(days.map(dow))].map((w) => byDow[w].length));
    if (minSamples < 8) { confidence = "baixa"; reasons.push("poucas amostras de algum dia da semana"); }
    if (specialAhead.size) { confidence = "baixa"; reasons.push(`datas especiais ainda neste mês: ${[...specialAhead.values()].map((s) => `${s.name} (${s.date.slice(8, 10)}/${s.date.slice(5, 7)})`).join(", ")}`); }
    if (pendingPast.length) { if (confidence === "alta") confidence = "média"; reasons.push(`${pendingPast.length} dia(s) ainda sem fechamento entram como incerteza`); }

    const out: any = {
      ...base, status: "ok", historyDays, sold,
      goal, remainingOpenDays: horizon.length, pendingDays: pendingPast,
      projection: { low: round2(low), mid: round2(mid), high: round2(high), band: "faixa ≈ 80% (10%–90%)", basis: "estimate" },
      confidence: { label: confidence, reasons },
      specialDays: [...specialAhead.values()],
      caveats: ["Previsão por dia da semana a partir dos fechamentos (a hora da venda não é usada).", "A faixa mede só a variação normal de um dia para outro; não cobre mudança de tendência, promoção ou ruptura de estoque.", "Dias tratados como independentes. Feriado municipal/estadual não está no calendário."],
    };
    if (goal.amount != null) {
      const falta = Math.max(0, goal.amount - sold);
      const p = sigma > 0 ? 1 - normalCdf((goal.amount - mid) / sigma) : (mid >= goal.amount ? 1 : 0);
      const pr = Math.max(0.05, Math.min(0.95, Math.round(p * 20) / 20));   // estimativa nunca é certeza: 5%–95%
      out.falta = round2(falta);
      out.goalProbability = { pct: Math.round(pr * 100), label: probabilityLabel(pr), basis: "estimate" };
      if (days.length) {
        const need = falta / days.length, typ = mu / days.length;
        out.neededPerOpenDay = round2(need); out.typicalPerOpenDay = round2(typ);
        out.neededVsTypicalPct = typ > 0 ? Math.round((need / typ - 1) * 100) : null;
      }
    }
    return out;
  }

  /** Previsão do mês para as lojas ativas. Rede = só as lojas projetáveis (σ em quadratura), nunca somando faixas. */
  static forecast(orgId: string, opts: { asOf?: string; month?: string; now?: number } = {}): any {
    const now = opts.now || Date.now();
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf || "") ? opts.asOf! : addDays(todaySP(now), -1);
    const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month || "") ? opts.month! : (addDays(asOf, 1)).slice(0, 7);
    const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`).all(orgId) as any[];
    const results = stores.map((s) => this.storeForecast(orgId, s, { asOf, month }));
    const ok = results.filter((r) => r.status === "ok");
    const excluded = results.filter((r) => r.status !== "ok").map((r) => ({ storeId: r.storeId, storeName: r.storeName, status: r.status, reason: r.reason || null }));
    let network: any = { storesProjected: ok.length, storesExcluded: excluded, projection: null };
    if (ok.length) {
      const sold = ok.reduce((a, r) => a + r.sold, 0), mid = ok.reduce((a, r) => a + r.projection.mid, 0);
      // σ de cada loja a partir da própria faixa (high−mid = Z80·σ); a rede soma em QUADRATURA (premissa: lojas independentes).
      const sig = Math.sqrt(ok.reduce((a, r) => a + ((r.projection.high - r.projection.mid) / Z80) ** 2, 0));
      network = { ...network, sold: round2(sold), projection: { low: round2(Math.max(sold, mid - Z80 * sig)), mid: round2(mid), high: round2(mid + Z80 * sig), band: "faixa ≈ 80% (10%–90%)", basis: "estimate" }, note: "Só as lojas projetáveis; as demais aparecem em storesExcluded (não entram na soma)." };
    }
    return { asOf, month, dataBasis: "fechamentos oficiais por dia (a hora da venda não é usada)", stores: results, network };
  }
}

export default RetailForecastService;
