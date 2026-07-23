import { BusinessSignalService, SignalInput } from "./BusinessSignalService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { CashForecastService } from "./CashForecastService.js";
import { OwnerDrawService } from "./OwnerDrawService.js";
import { BusinessHealthService } from "./BusinessHealthService.js";

/**
 * FinanceSignalPublisher (ADR-136, Epic 2 — C1).
 *
 * Deriva SINAIS financeiros tipados a partir dos motores que JÁ existem
 * (FinancialLedger/CashForecast/OwnerDraw/BusinessHealth) e os publica no ledger.
 * Determinístico (zero-token), sob demanda. Dedupe por tipo + dia → rodar duas
 * vezes no mesmo dia NÃO duplica (idempotência). Não executa nada.
 */

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export class FinanceSignalPublisher {
  static run(orgId: string): { published: string[]; count: number } {
    const day = new Date().toISOString().slice(0, 10);
    const sum = safe(() => FinancialLedgerService.summary(orgId) as any, null);
    const fc = safe(() => CashForecastService.forecast(orgId, { minCash: 0 }) as any, null);
    const owner = safe(() => OwnerDrawService.summary(orgId) as any, null);
    const dq = safe(() => BusinessHealthService.dataQuality(orgId) as any, null);

    const signals: SignalInput[] = [];
    const base = { domain: "finance", sourceService: "FinanceSignalPublisher", impactUnit: "BRL" as const };

    if (sum && Number(sum.caixaAtual) < 0) {
      signals.push({ ...base, signalType: "cash_below_minimum", severity: "critical", basis: "fact", confidence: 1,
        impactAmount: round2(sum.caixaAtual), evidence: { caixaAtual: round2(sum.caixaAtual) }, dedupeKey: `finance:cash_below_minimum:${day}` });
    }
    if (fc?.firstRisk) {
      const wk = Number(fc.firstRisk.weeksAhead);
      signals.push({ ...base, signalType: "cash_break_risk", severity: wk <= 2 ? "critical" : "risk", basis: "estimate", confidence: 0.7,
        impactAmount: round2(fc.firstRisk.ending), evidence: { semanasAdiante: wk, semana: fc.firstRisk.weekStart, saldoProjetado: round2(fc.firstRisk.ending), survivalDays: fc.survivalDays },
        premises: ["Projeção de caixa de 13 semanas (cenário provável)."], dedupeKey: `finance:cash_break_risk:${day}` });
    }
    if (sum && Number(sum.aReceberVencido) > 0) {
      signals.push({ ...base, signalType: "receivable_overdue", severity: "attention", basis: "fact", confidence: 1,
        impactAmount: round2(sum.aReceberVencido), evidence: { vencido: round2(sum.aReceberVencido), contas: sum.aReceberVencidoCount, totalAReceber: round2(sum.aReceber) },
        dedupeKey: `finance:receivable_overdue:${day}` });
    }
    // Contas a pagar vencendo em até 7 dias.
    const payables = safe(() => FinancialLedgerService.listPayables(orgId, "open") as any[], []);
    const in7 = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const dueSoon = payables.filter((p) => p.due_date && String(p.due_date) >= day && String(p.due_date) <= in7);
    const dueSoonAmount = round2(dueSoon.reduce((a, p) => a + (Number(p.amount) || 0), 0));
    if (dueSoonAmount > 0) {
      signals.push({ ...base, signalType: "payable_due_soon", severity: "attention", basis: "fact", confidence: 1,
        impactAmount: dueSoonAmount, evidence: { contas: dueSoon.length, valor: dueSoonAmount, ate: in7 }, dedupeKey: `finance:payable_due_soon:${day}` });
    }
    if (owner && owner.alerta?.nivel === "excesso" && Number(owner.retiradas) > 0) {
      signals.push({ ...base, signalType: "owner_draw_excess", severity: "risk", basis: "fact", confidence: 0.9,
        impactAmount: round2(owner.retiradas), evidence: { retiradas: round2(owner.retiradas), pctDoResultado: owner.pctDoResultado, msg: owner.alerta.msg }, dedupeKey: `finance:owner_draw_excess:${day}` });
    }
    if (dq && dq.level === "baixa") {
      signals.push({ ...base, impactUnit: "percent", signalType: "data_quality_low", severity: "info", basis: "estimate", confidence: 0.8,
        impactAmount: Number(dq.pct) || 0, evidence: { pct: dq.pct, faltando: (dq.items || []).filter((i: any) => !i.ok).map((i: any) => i.key) }, dedupeKey: `finance:data_quality_low:${day}` });
    }

    const published: string[] = [];
    for (const s of signals) {
      try { BusinessSignalService.publish(orgId, s); published.push(s.signalType); } catch { /* um sinal ruim não derruba os demais */ }
    }
    return { published, count: published.length };
  }
}

export default FinanceSignalPublisher;
