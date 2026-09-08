/**
 * ManagerialBalanceSheetService — ADR-200 F1 (D1): Balanço Patrimonial GERENCIAL derivado.
 *
 * A "foto" do patrimônio numa data, montada A PARTIR DOS SUB-RAZÕES QUE JÁ EXISTEM (RN-FIN-2,
 * derivado/RN-004) — sem Razão/GL contábil, sem tabela de "saldo de balanço" mutável:
 *
 *   ATIVO   = Caixa (Motor de Caixa) + Contas a receber (`receivables`) + Estoque a custo
 *             (`retail_store_inventory` × `inventory_items.avg_cost`, ou o armazém `inventory_items`)
 *   PASSIVO = Contas a pagar (`payables`)
 *   PL      = Capital do sócio (aportes − retiradas de `owner_draws`, ADR-129)
 *             + "Resultado acumulado / a conciliar" (o RESIDUAL que os sub-razões não explicam)
 *
 * IDENTIDADE (RN-FIN-3): Ativo = Passivo + PL, SEMPRE. O que o capital do sócio não explica do PL
 * vira a linha "a conciliar" EXPLÍCITA — nunca é forçada a zero, nunca inventa (RN-FIN-5). Sem GL
 * gerencial não dá pra separar resultado acumulado de resíduo, então os dois vivem juntos, rotulados.
 *
 * O VALOR do CFO já aparece aqui: `preso` = a receber + estoque = capital de giro TRAVADO (o "2 mi
 * presos" da metáfora). O gap lucro≠caixa completo é a F2/F3.
 *
 * asOf: o caixa é RECONSTRUÍDO na data (saldo atual − eventos posteriores); a receber/a pagar são os
 * ABERTOS na data; o estoque é a POSIÇÃO ATUAL (sem histórico de custo por data — caveat honesto).
 *
 * Guardrails RN-FIN: 1 (gerencial≠contábil, disclaimer) · 2 (derivado, sem 2º motor) · 3 (identidade +
 * "a conciliar" explícito) · 5 (não inventa — sem custo → estoque parcial, coverage) · 6 (dois fluxos —
 * o estoque físico e o recebível de PDV já entram pelas mesmas fontes) · 7 (isolado por org).
 */
import db from "./db.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const isoDate = (s?: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? String(s) : new Date().toISOString().slice(0, 10));

export type StockSource = "retail_store" | "warehouse" | "none";

export interface BalanceSheetSnapshot {
  asOf: string;
  ativo: {
    caixa: number;
    contasReceber: number;
    estoque: number | null;         // null = sem estoque instrumentado (RN-FIN-5)
    total: number;
  };
  passivo: {
    contasPagar: number;
    total: number;
  };
  patrimonioLiquido: {
    capitalSocio: number;           // aportes − retiradas (derivado de owner_draws)
    aportes: number;
    retiradas: number;
    resultadoAConciliar: number;    // residual = Ativo − Passivo − capitalSocio (result. acum. + a conciliar)
    total: number;                  // = Ativo − Passivo (identidade)
  };
  preso: number;                    // a receber + estoque (capital de giro travado — o "preso" do CFO)
  balances: boolean;                // Ativo === Passivo + PL (sempre true por construção)
  stockSource: StockSource;
  stockCoverage: number | null;     // 0..1 fração da qtd com custo conhecido (null sem estoque)
  caveats: string[];
  disclaimer: string;
}

const DISCLAIMER = "Balanço gerencial e educativo — derivado dos seus registros, não substitui a contabilidade oficial.";

export class ManagerialBalanceSheetService {
  /** Caixa RECONSTRUÍDO na data: saldo atual − eventos de caixa posteriores a asOf. */
  private static caixaAsOf(orgId: string, asOf: string): number {
    const now = FinancialLedgerService.cashOnHand(orgId);
    let netAfter = 0;
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END),0) AS net
          FROM cash_events WHERE organization_id = ? AND date(event_date) > date(?)
      `).get(orgId, asOf) as any;
      netAfter = Number(r?.net) || 0;
    } catch { netAfter = 0; }
    return round2(now - netAfter);
  }

  /** Recebíveis ABERTOS na data (criados até asOf e ainda não recebidos até asOf; exclui cancelados). */
  private static contasReceber(orgId: string, asOf: string): number {
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(amount),0) AS s FROM receivables
         WHERE organization_id = ? AND status != 'canceled' AND date(created_at) <= date(?)
           AND (received_at IS NULL OR date(received_at) > date(?))
      `).get(orgId, asOf, asOf) as any;
      return round2(r?.s);
    } catch { return 0; }
  }

  /** Contas a pagar ABERTAS na data (lançadas até asOf e ainda não pagas até asOf; exclui canceladas). */
  private static contasPagar(orgId: string, asOf: string): number {
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(amount),0) AS s FROM payables
         WHERE organization_id = ? AND status != 'canceled' AND date(created_at) <= date(?)
           AND (paid_at IS NULL OR date(paid_at) > date(?))
      `).get(orgId, asOf, asOf) as any;
      return round2(r?.s);
    } catch { return 0; }
  }

  /**
   * Estoque a CUSTO — posição atual. Prefere a rede física (`retail_store_inventory` × custo médio do
   * `inventory_items` por produto, casando por product_service_id como o DRE); se a org não tem estoque
   * de loja, cai pro armazém (`inventory_items`). Coverage = fração da qtd com custo conhecido (RN-FIN-5).
   */
  private static estoque(orgId: string, asOf: string): { value: number | null; source: StockSource; coverage: number | null; partialByDate: boolean } {
    // Rede física primeiro.
    try {
      const hasRetail = (db.prepare(`SELECT COUNT(*) AS n FROM retail_store_inventory WHERE organization_id = ? AND quantity_available > 0`).get(orgId) as any)?.n;
      if (Number(hasRetail) > 0) {
        const rows = db.prepare(`
          SELECT rsi.quantity_available AS qty,
                 (SELECT ii.avg_cost FROM inventory_items ii
                    WHERE ii.organization_id = rsi.organization_id AND ii.product_service_id = rsi.product_service_id
                      AND COALESCE(ii.avg_cost,0) > 0 LIMIT 1) AS cost
            FROM retail_store_inventory rsi
           WHERE rsi.organization_id = ? AND rsi.quantity_available > 0
        `).all(orgId) as any[];
        let value = 0, qtyTotal = 0, qtyCovered = 0;
        for (const r of rows) {
          const qty = Number(r.qty) || 0; const cost = Number(r.cost) || 0;
          qtyTotal += qty;
          if (cost > 0) { value += qty * cost; qtyCovered += qty; }
        }
        const coverage = qtyTotal > 0 ? round2(qtyCovered / qtyTotal) : null;
        return { value: round2(value), source: "retail_store", coverage, partialByDate: asOf < new Date().toISOString().slice(0, 10) };
      }
    } catch { /* tabela pode não existir em base antiga */ }
    // Armazém.
    try {
      const r = db.prepare(`
        SELECT COALESCE(SUM(quantity_available * COALESCE(avg_cost,0)),0) AS value,
               COALESCE(SUM(quantity_available),0) AS qtyTotal,
               COALESCE(SUM(CASE WHEN COALESCE(avg_cost,0) > 0 THEN quantity_available ELSE 0 END),0) AS qtyCovered
          FROM inventory_items WHERE organization_id = ? AND quantity_available > 0
      `).get(orgId) as any;
      const qtyTotal = Number(r?.qtyTotal) || 0;
      if (qtyTotal <= 0) return { value: null, source: "none", coverage: null, partialByDate: false };
      const coverage = round2((Number(r?.qtyCovered) || 0) / qtyTotal);
      return { value: round2(r?.value), source: "warehouse", coverage, partialByDate: asOf < new Date().toISOString().slice(0, 10) };
    } catch { return { value: null, source: "none", coverage: null, partialByDate: false }; }
  }

  /** Aportes (despesa empresarial paga pelo dono) e retiradas ACUMULADOS até a data. */
  private static socio(orgId: string, asOf: string): { aportes: number; retiradas: number } {
    const outflow = ["pro_labore", "distribuicao", "despesa_pessoal", "emprestimo_socio"];
    try {
      const marks = outflow.map(() => "?").join(",");
      const ret = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM owner_draws WHERE organization_id = ? AND kind IN (${marks}) AND date(draw_date) <= date(?)`).get(orgId, ...outflow, asOf) as any;
      const ap = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM owner_draws WHERE organization_id = ? AND kind = 'despesa_empresarial' AND date(draw_date) <= date(?)`).get(orgId, asOf) as any;
      return { aportes: round2(ap?.s), retiradas: round2(ret?.s) };
    } catch { return { aportes: 0, retiradas: 0 }; }
  }

  /** Balanço gerencial numa data (asOf = YYYY-MM-DD; padrão = hoje). */
  static snapshot(orgId: string, asOf?: string): BalanceSheetSnapshot {
    const day = isoDate(asOf);
    const caixa = this.caixaAsOf(orgId, day);
    const contasReceber = this.contasReceber(orgId, day);
    const est = this.estoque(orgId, day);
    const estoqueVal = est.value == null ? 0 : est.value;    // p/ somar; null vira 0 no total mas sinaliza
    const ativoTotal = round2(caixa + contasReceber + estoqueVal);

    const contasPagar = this.contasPagar(orgId, day);
    const passivoTotal = round2(contasPagar);

    const { aportes, retiradas } = this.socio(orgId, day);
    const capitalSocio = round2(aportes - retiradas);
    const plTotal = round2(ativoTotal - passivoTotal);                 // identidade (RN-FIN-3)
    const resultadoAConciliar = round2(plTotal - capitalSocio);        // residual explícito

    const caveats: string[] = [];
    if (est.source === "none") caveats.push("Sem estoque instrumentado — o Ativo não inclui mercadoria (pode subestimar o patrimônio).");
    else if (est.coverage != null && est.coverage < 0.999) caveats.push(`Estoque a custo PARCIAL — só ${Math.round((est.coverage || 0) * 100)}% da quantidade tem custo médio conhecido; o resto não entra no Ativo (não inventa custo).`);
    if (est.partialByDate && est.source !== "none") caveats.push("O estoque é a posição ATUAL (não há histórico de custo por data) — nas demais linhas a data foi respeitada.");
    if (Math.abs(resultadoAConciliar) > 0) caveats.push("A linha 'Resultado acumulado / a conciliar' junta o lucro retido de toda a vida da empresa com o que os registros não explicam — é gerencial, não um Razão contábil.");

    return {
      asOf: day,
      ativo: { caixa, contasReceber, estoque: est.value, total: ativoTotal },
      passivo: { contasPagar, total: passivoTotal },
      patrimonioLiquido: { capitalSocio, aportes, retiradas, resultadoAConciliar, total: plTotal },
      preso: round2(contasReceber + estoqueVal),
      balances: Math.abs(ativoTotal - (passivoTotal + plTotal)) < 0.01,
      stockSource: est.source,
      stockCoverage: est.coverage,
      caveats,
      disclaimer: DISCLAIMER,
    };
  }
}

export default ManagerialBalanceSheetService;
