import { CashForecastService, ForecastWeek } from "./CashForecastService.js";

/**
 * RecoveryScenarioService — Simulador de Recuperação + "quanto podemos prometer?" +
 * Assistente de Negociação (Financial Recovery OS, PRD-ZF-UNIFIED-GAP-CLOSURE-03
 * F3.9/F3.10/F3.11 / PR-8). Read-only, DETERMINÍSTICO, sem tabela nova.
 *
 * COMPÕE a projeção de 13 semanas do `CashForecastService` (ADR-125) — NÃO recria a
 * projeção: pega as semanas-base e aplica ALAVANCAS como deltas determinísticos por cima
 * (cortar despesa, renegociar/alongar, antecipar recebível, recuperar vencido, aumentar
 * margem/receita, testar um acordo), recalculando a cadeia de saldos + a 1ª ruptura.
 *
 * FATO × HIPÓTESE (RN-FR-11 / F3.9) — NUNCA misturados: cada alavanca carrega `basis`
 * (fact/estimate/hypothesis). O resultado reporta TRÊS visões separadas — baseline (estado
 * atual), factOnly (só alavancas `fact`) e scenario (todas) — em vez de um único número que
 * confunde o que já é fato com o que é aposta. `containsHypothesis` sinaliza.
 *
 * CÁLCULO sempre determinístico (o LLM nunca calcula caixa — só narraria). O Assistente de
 * Negociação PROPÕE termos que cabem no caixa e RASCUNHA a mensagem; NUNCA aceita, assina,
 * contrata crédito ou renegocia sozinho (RN §23). "Compatível/incompatível com a projeção"
 * — nunca "aceite".
 *
 * Dinheiro role-gated (§73): valores em R$ são redigidos quando `includeMoney:false`
 * (mantém veredito/semanas/risco/percentuais).
 */

export type LeverBasis = "fact" | "estimate" | "hypothesis";
export interface ScenarioLever {
  kind: string;               // cut_expense | renegotiate_debt | advance_receivable | recover_overdue | increase_revenue | increase_margin | new_commitment | other
  label: string;
  basis: LeverBasis;
  monthlyOutflowDelta?: number; // + aumenta saída mensal, − reduz (corte = negativo)
  monthlyInflowDelta?: number;  // + aumenta entrada mensal
  fromWeek?: number;            // índice de semana a partir do qual vale (default 0)
  oneTime?: { week: number; inflow?: number; outflow?: number }[];
}

interface Summary { minEnding: number | null; endEnding: number | null; firstRisk: ReturnType<typeof CashForecastService.firstRiskWeek> }

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
// meses→semana: 12 vencimentos/ano ÷ 52 semanas. Parcela mensal vira ocorrências ~a cada 4,33 semanas.
const WEEKS_PER_MONTH = 52 / 12;
const money = (v: number | null, includeMoney: boolean) => (includeMoney ? v : null);

export class RecoveryScenarioService {
  /** Aplica as alavancas sobre as semanas-base, recalculando a cadeia de saldos. Puro. */
  private static project(base: ForecastWeek[], levers: ScenarioLever[], minCash: number): ForecastWeek[] {
    let opening = base[0]?.opening ?? 0;
    return base.map((w, i) => {
      let inflow = w.inflow, outflow = w.outflow;
      for (const L of levers) {
        const from = L.fromWeek ?? 0;
        if (i >= from) {
          if (L.monthlyInflowDelta) inflow += L.monthlyInflowDelta / WEEKS_PER_MONTH;
          if (L.monthlyOutflowDelta) outflow += L.monthlyOutflowDelta / WEEKS_PER_MONTH;
        }
        for (const ot of L.oneTime || []) if (ot.week === i) { inflow += ot.inflow || 0; outflow += ot.outflow || 0; }
      }
      inflow = round2(inflow); outflow = round2(outflow);
      const ending = round2(opening + inflow - outflow);
      const risk: ForecastWeek["risk"] = ending < 0 ? "negative" : ending < minCash ? "tight" : "ok";
      const row: ForecastWeek = { weekStart: w.weekStart, opening: round2(opening), inflow, outflow, ending, risk };
      opening = ending;
      return row;
    });
  }

  private static summarize(weeks: ForecastWeek[], includeMoney: boolean): Summary {
    if (!weeks.length) return { minEnding: null, endEnding: null, firstRisk: null };
    const minEnding = Math.min(...weeks.map((w) => w.ending));
    return { minEnding: money(round2(minEnding), includeMoney), endEnding: money(weeks[weeks.length - 1].ending, includeMoney), firstRisk: CashForecastService.firstRiskWeek(weeks) };
  }

  /**
   * Simula um conjunto de alavancas. Reporta baseline × factOnly × scenario (fato ≠ hipótese
   * nunca somados numa cifra só). Determinístico.
   */
  static simulate(orgId: string, opts: { levers?: ScenarioLever[]; minCash?: number; includeMoney?: boolean } = {}): any {
    const includeMoney = opts.includeMoney !== false;
    const minCash = round2(opts.minCash || 0);
    const levers = Array.isArray(opts.levers) ? opts.levers : [];
    const base = CashForecastService.buildWeeks(orgId, { scenario: "provavel", minCash });
    const factLevers = levers.filter((l) => l.basis === "fact");
    const containsHypothesis = levers.some((l) => l.basis === "hypothesis");
    const containsEstimate = levers.some((l) => l.basis === "estimate");

    const caveats: string[] = [];
    if (containsHypothesis) caveats.push("O cenário inclui HIPÓTESES (ex.: renegociação não aceita, aumento futuro de receita) — não é o resultado garantido; veja 'factOnly' para o efeito só das medidas já efetivadas.");
    if (containsEstimate) caveats.push("Inclui ESTIMATIVAS (ex.: recebível recuperável) — separadas dos fatos.");

    return {
      generatedAt: new Date().toISOString(),
      minCash: money(minCash, includeMoney),
      baseline: this.summarize(base, includeMoney),
      factOnly: this.summarize(this.project(base, factLevers, minCash), includeMoney),
      scenario: this.summarize(this.project(base, levers, minCash), includeMoney),
      containsHypothesis,
      levers: levers.map((l) => ({ kind: l.kind, label: l.label, basis: l.basis })),
      caveats,
      ...(includeMoney ? {} : { redacted: true }),
    };
  }

  /** Ocorrências mensais de uma parcela dentro do horizonte de 13 semanas (proxy determinístico). */
  private static monthlyOccurrences(monthly: number, installments: number, nWeeks = 13): { week: number; outflow: number }[] {
    const out: { week: number; outflow: number }[] = [];
    for (let k = 1; k <= installments; k++) {
      const week = Math.round(k * WEEKS_PER_MONTH);
      if (week >= nWeeks) break;
      out.push({ week, outflow: monthly });
    }
    return out;
  }

  /**
   * "Quanto podemos prometer?" (F3.10): dado um acordo proposto (entrada + N parcelas), diz se
   * é COMPATÍVEL com a projeção de caixa (saldo nunca fura o mínimo) — nunca "aceite".
   */
  static commitmentAffordability(orgId: string, opts: { downPayment?: number; monthlyAmount?: number; installments?: number; minCash?: number; includeMoney?: boolean }): any {
    const includeMoney = opts.includeMoney !== false;
    const minCash = round2(opts.minCash || 0);
    const down = round2(opts.downPayment || 0);
    const monthly = round2(opts.monthlyAmount || 0);
    const installments = Math.max(0, Math.floor(opts.installments || 0));
    const base = CashForecastService.buildWeeks(orgId, { scenario: "provavel", minCash });

    const oneTime: ScenarioLever["oneTime"] = [];
    if (down > 0) oneTime.push({ week: 0, outflow: down });
    for (const occ of this.monthlyOccurrences(monthly, installments)) oneTime.push(occ);
    const lever: ScenarioLever = { kind: "new_commitment", label: "Acordo proposto", basis: "hypothesis", oneTime };
    const weeks = this.project(base, [lever], minCash);
    const minEnding = weeks.length ? Math.min(...weeks.map((w) => w.ending)) : 0;
    const firstRisk = CashForecastService.firstRiskWeek(weeks);
    const compatible = minEnding >= minCash;

    return {
      generatedAt: new Date().toISOString(),
      proposal: { downPayment: money(down, includeMoney), monthlyAmount: money(monthly, includeMoney), installments },
      compatible,
      verdict: compatible
        ? "Este acordo é COMPATÍVEL com a projeção de caixa atual (o saldo não fura o mínimo no horizonte de 13 semanas)."
        : "Este acordo é INCOMPATÍVEL com a projeção de caixa atual (o saldo furaria o mínimo). Não significa recusar — significa que, do jeito proposto, o caixa não sustenta.",
      resultingMinEnding: money(round2(minEnding), includeMoney),
      firstRisk,
      minCash: money(minCash, includeMoney),
      caveats: ["Cálculo determinístico sobre a projeção de 13 semanas. A decisão é humana — o ZapFlow não aceita nem assina acordos."],
      ...(includeMoney ? {} : { redacted: true }),
    };
  }

  /**
   * Assistente de Negociação (F3.11): PROPÕE a maior parcela mensal que ainda cabe no caixa
   * (mantém o saldo ≥ mínimo nas 13 semanas), por busca determinística. Rascunha a mensagem.
   * NUNCA aceita/assina/renegocia sozinho.
   */
  static negotiationProposal(orgId: string, opts: { debtTotal: number; maxInstallments?: number; minCash?: number; includeMoney?: boolean }): any {
    const includeMoney = opts.includeMoney !== false;
    const minCash = round2(opts.minCash || 0);
    const debtTotal = round2(opts.debtTotal || 0);
    const maxInstallments = Math.max(1, Math.min(48, Math.floor(opts.maxInstallments || 12)));
    const base = CashForecastService.buildWeeks(orgId, { scenario: "provavel", minCash });
    const baseMin = base.length ? Math.min(...base.map((w) => w.ending)) : 0;

    const fits = (monthly: number): boolean => {
      const oneTime = this.monthlyOccurrences(monthly, maxInstallments);
      const weeks = this.project(base, [{ kind: "renegotiate_debt", label: "Proposta", basis: "hypothesis", oneTime }], minCash);
      const min = weeks.length ? Math.min(...weeks.map((w) => w.ending)) : 0;
      return min >= minCash;
    };

    // Já em ruptura hoje: sem folga pra prometer parcela — recomenda alongamento/renegociação.
    if (baseMin < minCash) {
      return {
        generatedAt: new Date().toISOString(),
        feasible: false,
        affordableMonthly: money(0, includeMoney),
        installments: 0, downPaymentSuggested: money(0, includeMoney),
        risk: "high",
        note: "A projeção já fura o caixa mínimo antes de qualquer parcela — priorizar alongamento de prazo/carência e geração de caixa antes de assumir novas parcelas.",
        messageDraft: this.draftMessage({ debtTotal, monthly: 0, installments: 0, down: 0, feasible: false }),
        caveats: ["Determinístico. Proposta é sugestão — o humano decide, negocia e assina. O ZapFlow não renegocia sozinho."],
        ...(includeMoney ? {} : { redacted: true }),
      };
    }

    // Busca binária: maior parcela mensal M que ainda cabe.
    let lo = 0, hi = debtTotal, best = 0;
    for (let it = 0; it < 34 && hi - lo > 0.5; it++) {
      const mid = (lo + hi) / 2;
      if (fits(mid)) { best = mid; lo = mid; } else hi = mid;
    }
    best = round2(best);
    const installments = best > 0 ? Math.min(maxInstallments, Math.ceil(debtTotal / best)) : 0;
    const covered = round2(best * installments);
    const downPaymentSuggested = round2(Math.max(0, debtTotal - covered));
    const risk = best <= 0 ? "high" : covered >= debtTotal ? "low" : "medium";

    return {
      generatedAt: new Date().toISOString(),
      feasible: best > 0,
      affordableMonthly: money(best, includeMoney),
      installments,
      downPaymentSuggested: money(downPaymentSuggested, includeMoney),
      debtTotal: money(debtTotal, includeMoney),
      risk,
      assumptions: [
        "Parcela = maior valor mensal que mantém o saldo projetado ≥ caixa mínimo nas 13 semanas.",
        downPaymentSuggested > 0 ? "Entrada sugerida cobre o que as parcelas não alcançam dentro do teto de prazo." : "Parcelas cobrem o total dentro do teto de prazo.",
      ],
      messageDraft: this.draftMessage({ debtTotal, monthly: best, installments, down: downPaymentSuggested, feasible: best > 0 }),
      caveats: ["Determinístico. Proposta é sugestão — o humano decide, negocia e assina. O ZapFlow não aceita/assina/contrata crédito nem renegocia sozinho."],
      ...(includeMoney ? {} : { redacted: true }),
    };
  }

  /** Rascunho de mensagem (template determinístico — sem LLM; refino por IA é opcional/futuro). */
  private static draftMessage(x: { debtTotal: number; monthly: number; installments: number; down: number; feasible: boolean }): string {
    const brl = (n: number) => `R$ ${round2(n).toFixed(2).replace(".", ",")}`;
    if (!x.feasible) {
      return "Olá! Reconhecemos a pendência e queremos regularizar. No momento nosso fluxo de caixa não comporta parcelas fixas — poderíamos conversar sobre um período de carência ou alongamento de prazo? Obrigado pela compreensão.";
    }
    const entrada = x.down > 0 ? `uma entrada de ${brl(x.down)} e ` : "";
    return `Olá! Queremos quitar a pendência de ${brl(x.debtTotal)}. Conseguimos propor ${entrada}${x.installments}x de ${brl(x.monthly)}, dentro da nossa capacidade atual de pagamento. Podemos fechar nesses termos?`;
  }
}

export default RecoveryScenarioService;
