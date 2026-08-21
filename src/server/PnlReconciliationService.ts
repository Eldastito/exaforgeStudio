/**
 * PnlReconciliationService — ADR-182 F1: read-model RECONCILIADO de receita mensal.
 *
 * O ZapFlow mede "faturamento do mês" por dois rails que não conversam: core/online (`orders`
 * + `comigo_orders`) e loja física (`retail_daily_closings`, via a ponte opt-in
 * `retail_revenue_bridge`). Eles são SEGMENTOS (canais distintos), não duplicatas — mas hoje são
 * somados de forma OPACA (sem decomposição) e SEM detecção de sobreposição (`LossMarginService.
 * monthlyRevenue` faz `a+b+c` cru). Este service é a FONTE ÚNICA: decompõe a receita por
 * segmento, mantém o MESMO total (0-regressão), e sinaliza HONESTAMENTE o risco de sobreposição
 * (única condição em que a dobra é possível: haver receita nos dois rails ao mesmo tempo).
 *
 * Guardrails RN-PNL:
 *  - 1 (segmentos, não duplicatas): cada segmento vem de UMA fonte; o total nunca soma 2×.
 *  - 2 (sobreposição detectada, não somada em silêncio): `overlapRisk` explícito.
 *  - 4 (read-only/derivado RN-004): só query; não muta nada.
 *  - 5 (ponte opt-in respeitada): ponte off → segmento de fechamentos = 0 (0-regressão).
 *  - 6 (0-regressão numérica): `total` idêntico ao `a+b+c` atual.
 *  - 7 (isolado por org; determinístico; honesto).
 */
import db from "./db.js";
import { RetailRevenueBridgeService } from "./RetailRevenueBridgeService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

function round2(n: number): number { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export interface RevenueSegments {
  coreOrders: number;    // `orders` pagos/em_preparo/entregue/concluido
  comigo: number;        // `comigo_orders` paid/done
  storeClosings: number; // `retail_daily_closings` elegíveis (só com a ponte ligada)
}

export interface PnlRevenueReconciliation {
  period: string;
  segments: RevenueSegments;
  total: number;                 // = coreOrders + comigo + storeClosings (0-regressão)
  bridgeEnabled: boolean;
  overlapRisk: boolean;          // core E loja com receita → dobra POSSÍVEL (sem chave p/ dedup)
  note: string;
}

export class PnlReconciliationService {
  /** Receita mensal DECOMPOSTA por segmento (fonte única). Mesmo total do `a+b+c` legado. */
  static monthlyRevenue(orgId: string, period: string): PnlRevenueReconciliation {
    const coreOrders = round2((db.prepare(
      "SELECT COALESCE(SUM(total_amount),0) s FROM orders WHERE organization_id = ? AND status IN ('pago','em_preparo','entregue','concluido') AND strftime('%Y-%m', created_at) = ?"
    ).get(orgId, period) as any).s);
    const comigo = round2((db.prepare(
      "SELECT COALESCE(SUM(total),0) s FROM comigo_orders WHERE organization_id = ? AND status IN ('paid','done') AND strftime('%Y-%m', created_at) = ?"
    ).get(orgId, period) as any).s);
    const bridgeEnabled = RetailRevenueBridgeService.isEnabled(orgId);
    const storeClosings = bridgeEnabled ? round2(RetailRevenueBridgeService.monthlyRevenue(orgId, period)) : 0;

    const total = round2(coreOrders + comigo + storeClosings);
    // Dobra só é POSSÍVEL quando há receita no rail core E no rail loja ao mesmo tempo — aí uma
    // venda pode existir nos dois (não há chave p/ provar). Sem os dois, sobreposição é impossível.
    const overlapRisk = coreOrders > 0 && storeClosings > 0;

    const note = !bridgeEnabled
      ? "Ponte Fechamento→Faturamento desligada: receita só dos canais core (pedidos + Comigo)."
      : overlapRisk
        ? "Receita soma canais core (pedidos + Comigo) E fechamentos de loja. Se uma mesma venda estiver registrada como pedido E como fechamento, ela é contada duas vezes — confira (não há como o sistema deduplicar automaticamente hoje)."
        : "Receita inclui fechamentos de loja (Operação da Rede) além dos canais core.";

    return { period, segments: { coreOrders, comigo, storeClosings }, total, bridgeEnabled, overlapRisk, note };
  }

  /** Só o total (compat com o `monthlyRevenue: number` legado — usado pela F2). */
  static monthlyRevenueTotal(orgId: string, period: string): number {
    return this.monthlyRevenue(orgId, period).total;
  }

  /**
   * F4 — sinal ADVISORY de sobreposição. Quando o `overlapRisk` do período existe (receita nos
   * dois rails → uma venda PODE estar contada em pedido E em fechamento), publica um
   * `business_signal` pro dono CONFERIR — nunca corrige sozinho (não há chave p/ deduplicar).
   * É hipótese (não prova de dobra): `basis:'hypothesis'`, `impactAmount:null` (não inventa
   * dinheiro). Self-healing: risco some → `resolveByDedupe`; recorre → `reopenByDedupe` (respeita
   * o `dismissed` humano — §65). Dedupe por período (1 sinal/mês/org). Best-effort.
   */
  static publishOverlapSignal(orgId: string, period: string): { published: boolean; resolved: boolean } {
    const dedupeKey = `pnl_overlap:${period}`;
    let published = false, resolved = false;
    try {
      const r = this.monthlyRevenue(orgId, period);
      if (r.overlapRisk) {
        BusinessSignalService.publish(orgId, {
          domain: "pnl_reconciliation",
          signalType: "overlap_risk",
          severity: "attention",
          basis: "hypothesis",            // risco, não prova de dobra
          confidence: 0.5,
          impactAmount: null,             // nunca inventa dinheiro
          sourceService: "PnlReconciliationService",
          evidence: {
            period, segments: r.segments, total: r.total,
            message: "Sua receita do mês soma pedidos (core) E fechamentos de loja. Confira se uma mesma venda não está registrada nas duas — o sistema não consegue deduplicar automaticamente.",
          },
          dedupeKey,
        });
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
        published = true;
      } else {
        try { const rr = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); resolved = !!rr?.ok; } catch { /* noop */ }
      }
    } catch { /* best-effort */ }
    return { published, resolved };
  }

  /** Passe do Scheduler: só orgs com a ponte ligada (sem ela não há fechamentos → sem overlap). */
  static pass(): void {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE retail_revenue_bridge = 1`).all() as any[]; }
    catch { return; }
    const period = new Date().toISOString().slice(0, 7);
    for (const o of orgs) {
      try { this.publishOverlapSignal(o.organization_id, period); }
      catch (e) { console.error("[PnL] overlap pass falhou", o.organization_id, e); }
    }
  }
}

export default PnlReconciliationService;
