import db from "./db.js";
import { randomUUID } from "crypto";
import { FinancialLedgerService } from "./FinancialLedgerService.js";

/**
 * Motor de Caixa — Projeção de 13 semanas (ADR-125 Fatia 2).
 *
 * Onde o caixa deixa de ser "registro" e vira PREVENÇÃO: projeta as próximas 13
 * semanas a partir do saldo atual + contas a pagar (com recorrência) + recebíveis
 * ponderados pela probabilidade, e aponta a PRIMEIRA semana em que o caixa fura
 * o mínimo (ruptura) + os dias de sobrevivência. Determinístico (zero-token) e
 * SEMPRE com premissas + nível de confiança explícitos (nunca um número "seco").
 * Isolado por organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const todayStr = () => new Date().toISOString().slice(0, 10);

function parse(dateStr: string): Date { const [y, m, d] = dateStr.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); }
function fmt(dt: Date): string { return dt.toISOString().slice(0, 10); }
function addDays(dateStr: string, n: number): string { const d = parse(dateStr); d.setUTCDate(d.getUTCDate() + n); return fmt(d); }
function addMonths(dateStr: string, n: number): string { const d = parse(dateStr); d.setUTCMonth(d.getUTCMonth() + n); return fmt(d); }
// Segunda-feira (UTC) da semana que contém a data.
function mondayOf(dateStr: string): string { const d = parse(dateStr); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return fmt(d); }

export type Scenario = "pessimista" | "provavel" | "otimista";
const SCENARIO_FACTOR: Record<Scenario, number> = { pessimista: 0.7, provavel: 1.0, otimista: 1.3 };

export interface ForecastWeek { weekStart: string; opening: number; inflow: number; outflow: number; ending: number; risk: "ok" | "tight" | "negative" }

export class CashForecastService {
  /** Vencimentos de uma conta a pagar (com recorrência) dentro do horizonte. */
  private static payableOccurrences(p: any, horizonStart: string, horizonEnd: string): string[] {
    const out: string[] = [];
    if (p.recurrence === "weekly" || p.recurrence === "monthly") {
      let d = p.due_date as string;
      // avança até o horizonte (não despeja ocorrências passadas)
      let guard = 0;
      while (d < horizonStart && guard++ < 400) d = p.recurrence === "weekly" ? addDays(d, 7) : addMonths(d, 1);
      while (d <= horizonEnd && guard++ < 400) { out.push(d); d = p.recurrence === "weekly" ? addDays(d, 7) : addMonths(d, 1); }
    } else {
      // não recorrente: vencido (antes do horizonte) cai na 1ª semana; senão na semana do vencimento
      const due = p.due_date < horizonStart ? horizonStart : p.due_date;
      if (due <= horizonEnd) out.push(due);
    }
    return out;
  }

  /** Constrói as N semanas (padrão 13) para um cenário. */
  static buildWeeks(orgId: string, opts: { scenario?: Scenario; minCash?: number; weeks?: number } = {}): ForecastWeek[] {
    const scenario = opts.scenario || "provavel";
    const factor = SCENARIO_FACTOR[scenario];
    const minCash = round2(opts.minCash || 0);
    const nWeeks = opts.weeks || 13;
    const week0 = mondayOf(todayStr());
    const horizonEnd = addDays(week0, nWeeks * 7 - 1);

    FinancialLedgerService.syncFromSales(orgId); // reflete vendas pagas no saldo
    let opening = FinancialLedgerService.cashOnHand(orgId);

    const payables = db.prepare("SELECT amount, due_date, recurrence FROM payables WHERE organization_id = ? AND status = 'open'").all(orgId) as any[];
    const receivables = db.prepare("SELECT amount, due_date, probability FROM receivables WHERE organization_id = ? AND status = 'open'").all(orgId) as any[];

    // Pré-espalha os vencimentos das contas a pagar por data.
    const outByDate = new Map<string, number>();
    for (const p of payables) for (const d of this.payableOccurrences(p, week0, horizonEnd)) outByDate.set(d, round2((outByDate.get(d) || 0) + p.amount));

    const weeks: ForecastWeek[] = [];
    for (let i = 0; i < nWeeks; i++) {
      const ws = addDays(week0, i * 7);
      const we = addDays(ws, 6);
      let inflow = 0, outflow = 0;
      for (const r of receivables) {
        if (r.due_date >= ws && r.due_date <= we) {
          const base = r.amount * (r.probability == null ? 1 : r.probability);
          inflow += Math.min(r.amount, base * factor);
        }
      }
      for (const [d, amt] of outByDate) if (d >= ws && d <= we) outflow += amt;
      inflow = round2(inflow); outflow = round2(outflow);
      const ending = round2(opening + inflow - outflow);
      const risk: ForecastWeek["risk"] = ending < 0 ? "negative" : ending < minCash ? "tight" : "ok";
      weeks.push({ weekStart: ws, opening: round2(opening), inflow, outflow, ending, risk });
      opening = ending;
    }
    return weeks;
  }

  /** Primeira semana em que o caixa fura o mínimo (ruptura) — ou null. */
  static firstRiskWeek(weeks: ForecastWeek[]) {
    const idx = weeks.findIndex((w) => w.risk !== "ok");
    if (idx < 0) return null;
    const w = weeks[idx];
    return { index: idx, weeksAhead: idx, weekStart: w.weekStart, ending: w.ending, risk: w.risk };
  }

  /** Dias de sobrevivência = caixa atual / média diária de saídas (30d). */
  static survivalDays(orgId: string): number | null {
    const cash = FinancialLedgerService.cashOnHand(orgId);
    const out = FinancialLedgerService.realizedCash(orgId, addDays(todayStr(), -29), todayStr()).outflow;
    const perDay = out / 30;
    if (!(perDay > 0)) return null;
    return Math.floor(cash / perDay);
  }

  /** Premissas + checklist de dados faltantes + nível de confiança. */
  private static confidence(orgId: string, minCash: number) {
    const missing: string[] = [];
    if (FinancialLedgerService.cashOnHand(orgId) === 0) missing.push("Saldo inicial do caixa");
    if (FinancialLedgerService.listPayables(orgId, "open").length === 0) missing.push("Contas a pagar (custos fixos)");
    if (FinancialLedgerService.listReceivables(orgId, "open").length === 0 && FinancialLedgerService.fiadoOutstanding(orgId) === 0) missing.push("Contas a receber");
    const level = missing.length === 0 ? "alta" : missing.length === 1 ? "media" : "baixa";
    const assumptions = [
      "Recebíveis entram na semana do vencimento, ponderados pela probabilidade.",
      "Contas recorrentes geram os vencimentos futuros automaticamente.",
      "Fiado sem data de vencimento não entra na projeção (aparece em 'a receber').",
      `Caixa mínimo considerado: R$ ${round2(minCash).toFixed(2)}.`,
    ];
    return { level, missing, assumptions };
  }

  /** Payload completo da projeção para a tela (3 cenários + ruptura + confiança). */
  static forecast(orgId: string, opts: { minCash?: number } = {}) {
    const minCash = round2(opts.minCash || 0);
    const provavel = this.buildWeeks(orgId, { scenario: "provavel", minCash });
    const pessimista = this.buildWeeks(orgId, { scenario: "pessimista", minCash });
    const otimista = this.buildWeeks(orgId, { scenario: "otimista", minCash });
    const summarize = (w: ForecastWeek[]) => ({ endEnding: w[w.length - 1]?.ending ?? 0, minEnding: Math.min(...w.map((x) => x.ending)), firstRisk: this.firstRiskWeek(w) });
    const { level, missing, assumptions } = this.confidence(orgId, minCash);
    return {
      weekStart: mondayOf(todayStr()),
      minCash,
      weeks: provavel,
      firstRisk: this.firstRiskWeek(provavel),
      survivalDays: this.survivalDays(orgId),
      scenarios: { pessimista: summarize(pessimista), provavel: summarize(provavel), otimista: summarize(otimista) },
      confidence: level,
      missing,
      assumptions,
    };
  }

  /** Persiste o snapshot (cenário provável) — idempotente por semana. */
  static snapshot(orgId: string, minCash = 0) {
    const weeks = this.buildWeeks(orgId, { scenario: "provavel", minCash });
    const up = db.prepare(`
      INSERT INTO cash_forecast_weeks (id, organization_id, week_start, opening, inflow, outflow, ending, risk_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, week_start) DO UPDATE SET
        opening=excluded.opening, inflow=excluded.inflow, outflow=excluded.outflow, ending=excluded.ending, risk_level=excluded.risk_level
    `);
    const tx = db.transaction((rows: ForecastWeek[]) => { for (const w of rows) up.run(randomUUID(), orgId, w.weekStart, w.opening, w.inflow, w.outflow, w.ending, w.risk); });
    tx(weeks);
    return { weeks: weeks.length };
  }
}

export default CashForecastService;
