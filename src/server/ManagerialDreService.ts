import db from "./db.js";
import { ComigoHealthService } from "./ComigoHealthService.js";
import { OwnerDrawService } from "./OwnerDrawService.js";

/**
 * DRE Gerencial Simplificada (ADR-128) — venda × lucro × caixa em linguagem
 * simples. GERENCIAL e educativa: NÃO substitui a contabilidade oficial
 * (disclaimer obrigatório). Determinística (zero-token), isolada por org.
 *
 * Fontes (multi-vertical): receita e CMV somam o core (order_items) + o Comigo
 * (comigo_order_items). Descontos vêm das perdas (ADR-114, driver 'desconto').
 * Despesas = contas a pagar do mês por COMPETÊNCIA do vencimento (ADR-125) — a
 * diferença competência × caixa é justamente o que a DRE ensina; o caixa fica
 * no Motor de Caixa. Retiradas = 0 até o ADR Empresa × Proprietário.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const DISCLAIMER = "Visão gerencial e educativa — não substitui a contabilidade oficial.";

function monthBounds(period: string): { from: string; to: string } {
  const [y, m] = period.split("-").map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(last).padStart(2, "0")}` };
}

export class ManagerialDreService {
  private static coreRevCost(orgId: string, period: string) {
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(oi.line_total),0) AS revenue,
               COALESCE(SUM(oi.unit_cost * oi.quantity),0) AS cost
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE oi.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
          AND strftime('%Y-%m', o.created_at) = ?
      `).get(orgId, period) as any;
      return { revenue: round2(r?.revenue), cost: round2(r?.cost) };
    } catch { return { revenue: 0, cost: 0 }; }
  }

  private static lossDriver(orgId: string, period: string, driver: string): number {
    try { return round2((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM loss_events WHERE organization_id = ? AND driver = ? AND period = ?").get(orgId, driver, period) as any).s); } catch { return 0; }
  }

  /** Despesas do mês por competência, separando FIXAS (recorrentes) × VARIÁVEIS (avulsas). */
  private static despesasSplit(orgId: string, period: string): { fixas: number; variaveis: number; total: number } {
    try {
      const rows = db.prepare("SELECT recurrence, COALESCE(SUM(amount),0) s FROM payables WHERE organization_id = ? AND status IN ('open','paid') AND strftime('%Y-%m', due_date) = ? GROUP BY recurrence").all(orgId, period) as any[];
      let fixas = 0, variaveis = 0;
      for (const r of rows) { if (r.recurrence === "weekly" || r.recurrence === "monthly") fixas += r.s; else variaveis += r.s; }
      return { fixas: round2(fixas), variaveis: round2(variaveis), total: round2(fixas + variaveis) };
    } catch { return { fixas: 0, variaveis: 0, total: 0 }; }
  }

  private static prevPeriod(period: string): string {
    const [y, m] = period.split("-").map(Number);
    const d = new Date(Date.UTC(y, m - 2, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
  }

  /** Núcleo do cálculo (linhas + breakdown) para um período. */
  private static computeLines(orgId: string, period: string) {
    const { from, to } = monthBounds(period);
    const core = this.coreRevCost(orgId, period);
    const comigo = ComigoHealthService.rangeResult(orgId, from, to);

    const receitaBruta = round2(core.revenue + comigo.revenue);
    const descontos = this.lossDriver(orgId, period, "desconto");
    const devolucoes = this.lossDriver(orgId, period, "devolucao");
    const receitaLiquida = round2(receitaBruta - descontos - devolucoes);
    const cmv = round2(core.cost + comigo.cost);
    const margemBruta = round2(receitaLiquida - cmv);
    const margemPct = receitaLiquida > 0 ? round2((margemBruta / receitaLiquida) * 100) : null;
    const desp = this.despesasSplit(orgId, period);
    const resultadoOperacional = round2(margemBruta - desp.total);
    let retiradas = 0;
    try { retiradas = OwnerDrawService.monthlyRetiradas(orgId, period); } catch { retiradas = 0; } // ADR-129
    const sobra = round2(resultadoOperacional - retiradas);

    return {
      linhas: {
        receitaBruta, descontos, devolucoes, receitaLiquida, cmv, margemBruta, margemPct,
        despesas: desp.total, despesasFixas: desp.fixas, despesasVariaveis: desp.variaveis,
        resultadoOperacional, retiradas, sobra,
      },
      breakdown: {
        core: { revenue: core.revenue, cost: core.cost },
        comigo: { revenue: round2(comigo.revenue), cost: round2(comigo.cost) },
      },
    };
  }

  /** DRE gerencial do mês (period = YYYY-MM; padrão = mês corrente) + comparação. */
  static monthly(orgId: string, period = new Date().toISOString().slice(0, 7)) {
    const cur = this.computeLines(orgId, period);
    const prevP = this.prevPeriod(period);
    const prev = this.computeLines(orgId, prevP);
    const keys = ["receitaBruta", "receitaLiquida", "margemBruta", "despesas", "resultadoOperacional", "sobra"] as const;
    const comparacao: Record<string, { atual: number; anterior: number; delta: number }> = {};
    for (const k of keys) {
      const atual = Number((cur.linhas as any)[k]) || 0;
      const anterior = Number((prev.linhas as any)[k]) || 0;
      comparacao[k] = { atual, anterior, delta: round2(atual - anterior) };
    }

    return {
      period,
      linhas: cur.linhas,
      breakdown: cur.breakdown,
      comparacao: { period: prevP, ...comparacao },
      notas: {
        retiradas: "Retiradas dos sócios (pró-labore, distribuição, despesas pessoais) — cadastre no Empresa × Proprietário.",
        despesas: "Despesas por competência do vencimento — fixas = recorrentes, variáveis = avulsas. A visão de caixa fica no Motor de Caixa.",
      },
      disclaimer: DISCLAIMER,
    };
  }
}

export default ManagerialDreService;
