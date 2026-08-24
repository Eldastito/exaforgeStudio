/**
 * CostCenterStatementService — ADR-185 F2: EXTRATO de um centro de custo.
 *
 * COMPÕE (read-only) as DUAS dimensões que a Controladoria tem por centro, LADO A LADO e NUNCA
 * somadas (unidades distintas — RN-CC-4): a DESPESA financeira (R$, de `payables` via
 * `FinancialLedgerService.expensesByCostCenter`) e o CONSUMO de material (QUANTIDADE por produto,
 * de `consumption_events`, cada item com sua UoM — não misturamos kg+unidade+litro num total).
 * Determinístico, derivado por query (RN-004), isolado por org, honesto (sem dado → 0/[]).
 */
import db from "./db.js";
import { CostCenterService } from "./CostCenterService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";

function round2(n: number): number { return Math.round((Number(n) + Number.EPSILON) * 100) / 100; }

export interface CostCenterStatement {
  costCenterId: string;
  name: string;
  from: string;
  to: string;
  expense: { total: number; currency: "BRL"; source: "payables" };
  consumption: {
    items: { productId: string; name: string | null; uom: string | null; net: number }[];
    note: string;
  };
  note: string;
}

export class CostCenterStatementService {
  /**
   * Extrato do centro no período. `from`/`to` alinham as duas fontes (competência do vencimento
   * pra despesa; `occurred_at` pro consumo). Consumo POR PRODUTO+UoM (nunca soma unidades distintas).
   * Retorna null se o centro não existe/não é da org.
   */
  static statement(orgId: string, costCenterId: string, opts: { from?: string; to?: string } = {}): CostCenterStatement | null {
    const center = CostCenterService.get(orgId, costCenterId);
    if (!center) return null;
    const from = opts.from || `${new Date().toISOString().slice(0, 7)}-01`;
    const to = opts.to || new Date().toISOString().slice(0, 10);

    // Despesa financeira (R$) — reusa o relatório da F1 e pega a fatia deste centro.
    const exp = FinancialLedgerService.expensesByCostCenter(orgId, { from, to });
    const expenseTotal = round2(exp.items.find((i) => i.costCenterId === costCenterId)?.total || 0);

    // Consumo de material (QUANTIDADE) — por produto+UoM, cada um com sua unidade (RN-CC-4).
    let consumptionItems: { productId: string; name: string | null; uom: string | null; net: number }[] = [];
    try {
      const rows = db.prepare(`
        SELECT ce.product_service_id AS productId, ps.name AS name, ce.uom AS uom,
               COALESCE(SUM(CASE WHEN ce.direction='out' THEN ce.quantity ELSE -ce.quantity END), 0) AS net
        FROM consumption_events ce
        LEFT JOIN products_services ps ON ps.id = ce.product_service_id AND ps.organization_id = ce.organization_id
        WHERE ce.organization_id = ? AND ce.cost_center_id = ? AND ce.occurred_at BETWEEN ? AND ?
        GROUP BY ce.product_service_id, ce.uom
        HAVING net <> 0
        ORDER BY net DESC`).all(orgId, costCenterId, from, to) as any[];
      consumptionItems = rows.map((r) => ({ productId: r.productId, name: r.name || null, uom: r.uom || null, net: round2(r.net) }));
    } catch { /* honesto: sem dado → [] */ }

    return {
      costCenterId,
      name: center.name,
      from, to,
      expense: { total: expenseTotal, currency: "BRL", source: "payables" },
      consumption: {
        items: consumptionItems,
        note: "Quantidade de material consumida por produto (cada um na sua unidade) — NÃO é R$, não somar com a despesa.",
      },
      note: "Despesa financeira (R$) e consumo de material (quantidade) são dimensões distintas — reportadas à parte, NUNCA somadas.",
    };
  }
}

export default CostCenterStatementService;
