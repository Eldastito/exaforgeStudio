import db from "./db.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";

/**
 * PurchasePayableService (Epic 5 — Comprador IA, fatia E5.3).
 *
 * Fecha compras no FINANCEIRO: gera a conta a pagar a partir de uma ordem de
 * compra confirmada/recebida, alimentando o mesmo `payables` que o caixa/DRE já
 * enxergam (via `FinancialLedgerService`). Guarda central do PRD §16:
 * **a conta a pagar não é criada duas vezes** — idempotente por
 * `UNIQUE(organization_id, source_purchase_order_id)` + verificação prévia.
 * Determinístico, isolado por organization_id. O valor devido reflete o que foi
 * de fato RECEBIDO (received_qty × preço), não o pedido — honesto com as
 * divergências da E5.2. Não paga nada (o pagamento é ação separada e humana).
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export class PurchasePayableService {
  /** Conta a pagar já vinculada a esta ordem (idempotência). */
  static getByOrder(orgId: string, poId: string): any | null {
    return db.prepare("SELECT * FROM payables WHERE organization_id = ? AND source_purchase_order_id = ?").get(orgId, poId) as any || null;
  }

  /**
   * Valor devido pela ordem, com base no que foi recebido bom
   * (`received_qty × unit_price`). Fallback opcional para o total do pedido.
   */
  static amountDue(orgId: string, poId: string, basis: "received" | "ordered" = "received"): number {
    if (basis === "ordered") {
      const o = db.prepare("SELECT total_amount FROM purchase_orders WHERE id = ? AND organization_id = ?").get(poId, orgId) as any;
      return round2(o?.total_amount || 0);
    }
    const rows = db.prepare("SELECT received_qty, unit_price FROM purchase_order_items WHERE purchase_order_id = ? AND organization_id = ?").all(poId, orgId) as any[];
    return round2(rows.reduce((s, r) => s + (Number(r.received_qty) || 0) * (Number(r.unit_price) || 0), 0));
  }

  /**
   * Cria (uma vez) a conta a pagar da ordem. Idempotente: se já existe, devolve
   * a existente. Exige ordem existente e um valor devido > 0 (algo recebido, ou
   * basis 'ordered'). `dueDate` obrigatória (o prazo de pagamento não é inferido).
   */
  static createFromOrder(orgId: string, poId: string, opts: { dueDate: string; basis?: "received" | "ordered"; createdBy?: string }): { ok: boolean; id: string | null; deduped: boolean; amount?: number; error?: string } {
    const existing = this.getByOrder(orgId, poId);
    if (existing) return { ok: true, id: existing.id, deduped: true, amount: existing.amount };

    const po = db.prepare("SELECT * FROM purchase_orders WHERE id = ? AND organization_id = ?").get(poId, orgId) as any;
    if (!po) return { ok: false, id: null, deduped: false, error: "Ordem de compra não encontrada." };
    if (po.status === "cancelled") return { ok: false, id: null, deduped: false, error: "Ordem cancelada não gera conta a pagar." };

    const amount = this.amountDue(orgId, poId, opts.basis || "received");
    if (!(amount > 0)) return { ok: false, id: null, deduped: false, error: "Nada recebido para faturar (valor devido é zero)." };

    let res: { ok: boolean; id?: string; error?: string };
    try {
      res = FinancialLedgerService.addPayable(orgId, {
        description: `Compra — ${po.supplier_name || "fornecedor"} (OC ${poId.slice(0, 8)})`,
        amount, dueDate: opts.dueDate, category: "compras", supplierName: po.supplier_name || null,
        createdBy: opts.createdBy, sourcePurchaseOrderId: poId,
      });
    } catch (e: any) {
      // Corrida com a UNIQUE parcial: se outra chamada criou primeiro, devolve.
      const dup = this.getByOrder(orgId, poId);
      if (dup) return { ok: true, id: dup.id, deduped: true, amount: dup.amount };
      return { ok: false, id: null, deduped: false, error: e?.message || "Falha ao criar a conta a pagar." };
    }
    if (!res.ok) {
      const dup = this.getByOrder(orgId, poId);
      if (dup) return { ok: true, id: dup.id, deduped: true, amount: dup.amount };
      return { ok: false, id: null, deduped: false, error: res.error };
    }
    return { ok: true, id: res.id!, deduped: false, amount };
  }
}

export default PurchasePayableService;
