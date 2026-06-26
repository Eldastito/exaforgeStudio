import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { NotificationService } from "./NotificationService.js";

/**
 * Reposição inteligente (Fase 1 do "ZappFlow Supply"). Varre o estoque, encontra
 * itens abaixo do mínimo crítico (inventory_items.low_stock_threshold), calcula
 * o consumo médio diário (saídas em stock_movements nos últimos 30 dias) e
 * propõe uma REQUISIÇÃO DE COMPRA (rascunho) para o gestor aprovar.
 *
 * Tudo intra-cliente — não depende de fornecedor estar no ZappFlow. As Fases 2/3
 * (cotação com fornecedores + rede ZappFlow) reusam essa requisição como ponto
 * de partida.
 */
export class PurchaseRequisitionService {
  /** Calcula a sugestão de compra para um item específico (sem persistir). */
  static suggestForItem(orgId: string, params: {
    productId: string; variantId: string | null;
    currentStock: number; threshold: number; targetDays: number;
  }) {
    // Consumo médio diário pelas saídas (vendas/baixas) dos últimos 30 dias.
    const r = db.prepare(`
      SELECT COALESCE(SUM(quantity),0) AS total
      FROM stock_movements
      WHERE organization_id = ? AND product_service_id = ? AND type = 'saida'
        AND created_at >= datetime('now','-30 days')
        AND (? IS NULL OR variant_id IS NULL OR variant_id = ?)
    `).get(orgId, params.productId, params.variantId, params.variantId) as any;
    const sold30 = Number(r?.total || 0);
    const avgDaily = sold30 / 30;
    const cover = avgDaily > 0 ? Math.round((params.currentStock / avgDaily) * 10) / 10 : null;
    // Sugere o maior entre repor até o mínimo e cobrir os próximos N dias.
    const byThreshold = Math.max(0, (params.threshold || 0) - params.currentStock);
    const byTarget = Math.ceil(avgDaily * (params.targetDays || 14));
    const suggested = Math.max(byThreshold, byTarget, 1);
    return { suggestedQty: suggested, avgDailyConsumption: Math.round(avgDaily * 100) / 100, daysOfCover: cover };
  }

  /** Lista os itens da org abaixo do mínimo crítico (com sugestão de QTD). */
  static itemsBelowThreshold(orgId: string, targetDays = 14) {
    const rows = db.prepare(`
      SELECT ii.id, ii.product_service_id, ii.variant_id,
             ii.quantity_available, ii.quantity_reserved, ii.low_stock_threshold,
             p.name AS product_name, pv.name AS variant_name
      FROM inventory_items ii
      JOIN products_services p ON p.id = ii.product_service_id
      LEFT JOIN product_variants pv ON pv.id = ii.variant_id
      WHERE ii.organization_id = ?
        AND p.active = 1 AND p.stock_control_enabled = 1
        AND COALESCE(ii.low_stock_threshold,0) > 0
        AND (ii.quantity_available - COALESCE(ii.quantity_reserved,0)) <= ii.low_stock_threshold
    `).all(orgId) as any[];

    return rows.map(r => {
      const stock = (r.quantity_available || 0) - (r.quantity_reserved || 0);
      const s = this.suggestForItem(orgId, {
        productId: r.product_service_id, variantId: r.variant_id,
        currentStock: stock, threshold: r.low_stock_threshold, targetDays,
      });
      return {
        productServiceId: r.product_service_id,
        variantId: r.variant_id || null,
        name: r.variant_name ? `${r.product_name} (${r.variant_name})` : r.product_name,
        currentStock: stock,
        threshold: r.low_stock_threshold,
        ...s,
      };
    });
  }

  /** Requisição em rascunho aberta (no máximo uma por org). */
  static currentDraft(orgId: string): any | null {
    return db.prepare(`SELECT * FROM purchase_requisitions WHERE organization_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT 1`).get(orgId) as any || null;
  }

  /** Lista os itens de uma requisição. */
  static itemsOf(reqId: string): any[] {
    return db.prepare(`SELECT * FROM purchase_requisition_items WHERE requisition_id = ?`).all(reqId) as any[];
  }

  /**
   * Detecta itens em falta e cria/atualiza a requisição rascunho da org.
   * - Retorna null se não há nada abaixo do mínimo.
   * - Idempotente: se já existe um rascunho, substitui os itens (sem duplicar).
   */
  static syncDraft(orgId: string, targetDays = 14): { id: string; items: number } | null {
    const items = this.itemsBelowThreshold(orgId, targetDays);
    if (items.length === 0) {
      // Fechou tudo? Descarta o rascunho vazio.
      const cur = this.currentDraft(orgId);
      if (cur) {
        db.prepare(`DELETE FROM purchase_requisition_items WHERE requisition_id = ?`).run(cur.id);
        db.prepare(`DELETE FROM purchase_requisitions WHERE id = ? AND status = 'draft'`).run(cur.id);
      }
      return null;
    }

    let req = this.currentDraft(orgId);
    if (!req) {
      const id = uuidv4();
      db.prepare(`INSERT INTO purchase_requisitions (id, organization_id, status, created_by) VALUES (?, ?, 'draft', 'ai')`).run(id, orgId);
      req = { id };
    } else {
      // Substitui os itens — fonte da verdade é o estoque atual.
      db.prepare(`DELETE FROM purchase_requisition_items WHERE requisition_id = ?`).run(req.id);
    }

    const ins = db.prepare(`INSERT INTO purchase_requisition_items
      (id, requisition_id, organization_id, product_service_id, variant_id, current_stock, threshold, suggested_qty, avg_daily_consumption, days_of_cover)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of items) {
      ins.run(uuidv4(), req.id, orgId, it.productServiceId, it.variantId, it.currentStock, it.threshold, it.suggestedQty, it.avgDailyConsumption, it.daysOfCover);
    }
    return { id: req.id, items: items.length };
  }

  /** Aprovação humana: marca a requisição como approved. (Fase 2 transforma em PO.) */
  static approve(orgId: string, reqId: string, userId: string): boolean {
    const r = db.prepare(`UPDATE purchase_requisitions SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND status = 'draft'`).run(userId, reqId, orgId);
    return r.changes > 0;
  }

  /** Descarta a requisição (humano decidiu que não vai comprar agora). */
  static dismiss(orgId: string, reqId: string): boolean {
    const r = db.prepare(`UPDATE purchase_requisitions SET status = 'dismissed' WHERE id = ? AND organization_id = ? AND status = 'draft'`).run(reqId, orgId);
    return r.changes > 0;
  }

  /** Pass do Scheduler: roda em todas as orgs com procurement_enabled. */
  static async pass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT organization_id, COALESCE(procurement_target_days,14) AS target FROM organization_settings WHERE COALESCE(procurement_enabled,0) = 1`).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const before = this.currentDraft(org.organization_id);
        const beforeCount = before ? this.itemsOf(before.id).length : 0;
        const r = this.syncDraft(org.organization_id, Math.max(1, parseInt(String(org.target), 10) || 14));
        // Notifica só quando o rascunho cresce (novo item entrou em falta).
        if (r && r.items > beforeCount) {
          NotificationService.lowStock(org.organization_id, `${r.items} item(ns)`, 0);
        }
      } catch (e) { console.error('[Supply] Falha no pass de reposição', org.organization_id, e); }
    }
  }
}
