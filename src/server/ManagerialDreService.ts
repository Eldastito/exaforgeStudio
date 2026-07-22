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

  private static descontos(orgId: string, period: string): number {
    try { return round2((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM loss_events WHERE organization_id = ? AND driver = 'desconto' AND period = ?").get(orgId, period) as any).s); } catch { return 0; }
  }

  private static despesas(orgId: string, period: string): number {
    try { return round2((db.prepare("SELECT COALESCE(SUM(amount),0) s FROM payables WHERE organization_id = ? AND status IN ('open','paid') AND strftime('%Y-%m', due_date) = ?").get(orgId, period) as any).s); } catch { return 0; }
  }

  /** DRE gerencial do mês (period = YYYY-MM; padrão = mês corrente). */
  static monthly(orgId: string, period = new Date().toISOString().slice(0, 7)) {
    const { from, to } = monthBounds(period);
    const core = this.coreRevCost(orgId, period);
    const comigo = ComigoHealthService.rangeResult(orgId, from, to); // {revenue, cost, ...}

    const receitaBruta = round2(core.revenue + comigo.revenue);
    const descontos = this.descontos(orgId, period);
    const receitaLiquida = round2(receitaBruta - descontos);
    const cmv = round2(core.cost + comigo.cost);
    const margemBruta = round2(receitaLiquida - cmv);
    const margemPct = receitaLiquida > 0 ? round2((margemBruta / receitaLiquida) * 100) : null;
    const despesas = this.despesas(orgId, period);
    const resultadoOperacional = round2(margemBruta - despesas);
    let retiradas = 0;
    try { retiradas = OwnerDrawService.monthlyRetiradas(orgId, period); } catch { retiradas = 0; } // ADR-129
    const sobra = round2(resultadoOperacional - retiradas);

    return {
      period,
      linhas: {
        receitaBruta,
        descontos,
        receitaLiquida,
        cmv,
        margemBruta,
        margemPct,
        despesas,
        resultadoOperacional,
        retiradas,
        sobra,
      },
      breakdown: {
        core: { revenue: core.revenue, cost: core.cost },
        comigo: { revenue: round2(comigo.revenue), cost: round2(comigo.cost) },
      },
      notas: {
        retiradas: "Retiradas dos sócios (pró-labore, distribuição, despesas pessoais) — cadastre no Empresa × Proprietário.",
        despesas: "Despesas por competência do vencimento — a visão de caixa fica no Motor de Caixa.",
      },
      disclaimer: DISCLAIMER,
    };
  }
}

export default ManagerialDreService;
