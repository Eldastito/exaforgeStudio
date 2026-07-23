import db from "./db.js";
import { randomUUID } from "crypto";
import { InventoryService } from "./InventoryService.js";

/**
 * ProductionShopFloorService (Supervisor de Produção IA — fatia 3, ADR-141).
 *
 * Chão de fábrica: CONSUMO REAL de materiais (baixa o estoque via
 * `InventoryService`, o mesmo motor do recebimento de compras), CHECKLIST DE
 * QUALIDADE e MOTIVOS DE PARADA. Cada movimento é auditável (`production_events`
 * + a tabela específica). Só apontamento humano; determinístico; isolado por
 * organization_id. Não fecha a ordem — quem conclui é o ProductionOrderService.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

function orderInProgress(orgId: string, orderId: string): any | null {
  const o = db.prepare("SELECT id, bom_id, status FROM production_orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
  if (!o || !["released", "in_progress"].includes(o.status)) return null;
  return o;
}
function event(orgId: string, orderId: string, kind: string, opts: { qty?: number | null; note?: string | null; createdBy?: string | null } = {}) {
  db.prepare("INSERT INTO production_events (id, organization_id, order_id, kind, qty, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), orgId, orderId, kind, opts.qty != null ? Number(opts.qty) : null, opts.note || null, opts.createdBy || null);
}

export class ProductionShopFloorService {
  /** Consome um material da ordem: registra e BAIXA o estoque (saída). */
  static consumeMaterial(orgId: string, orderId: string, input: { materialProductServiceId: string; quantity: number; note?: string; createdBy?: string }): { ok: boolean; id?: string; error?: string } {
    const o = orderInProgress(orgId, orderId);
    if (!o) return { ok: false, error: "Ordem não está em produção (libere-a antes de consumir)." };
    const mat = db.prepare("SELECT id FROM products_services WHERE id = ? AND organization_id = ?").get(input.materialProductServiceId, orgId) as any;
    if (!mat) return { ok: false, error: "Material não encontrado no catálogo." };
    const qty = Number(input.quantity);
    if (!(qty > 0)) return { ok: false, error: "Quantidade consumida deve ser > 0." };

    const id = randomUUID();
    const tx = db.transaction(() => {
      db.prepare("INSERT INTO material_consumptions (id, organization_id, order_id, material_product_service_id, quantity, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, orgId, orderId, input.materialProductServiceId, round2(qty), input.note || null, input.createdBy || null);
      // Baixa o estoque de verdade (mesmo motor do recebimento).
      InventoryService.recordMovement(orgId, { productId: input.materialProductServiceId, type: "saida", quantity: qty, origin: "consumo_producao", note: `OP ${orderId.slice(0, 8)}`, createdBy: input.createdBy || null });
      event(orgId, orderId, "consume", { qty, note: input.note, createdBy: input.createdBy });
    });
    tx();
    return { ok: true, id };
  }

  /** Consome todos os materiais da BOM para produzir `quantity` unidades. */
  static consumeForBom(orgId: string, orderId: string, quantity: number, opts: { createdBy?: string } = {}): { ok: boolean; consumed?: number; error?: string } {
    const o = orderInProgress(orgId, orderId);
    if (!o) return { ok: false, error: "Ordem não está em produção." };
    if (!o.bom_id) return { ok: false, error: "Ordem sem BOM vinculada." };
    const qty = Number(quantity);
    if (!(qty > 0)) return { ok: false, error: "Quantidade deve ser > 0." };
    const items = db.prepare("SELECT material_product_service_id, quantity FROM bom_items WHERE organization_id = ? AND bom_id = ?").all(orgId, o.bom_id) as any[];
    let consumed = 0;
    for (const it of items) {
      const r = this.consumeMaterial(orgId, orderId, { materialProductServiceId: it.material_product_service_id, quantity: round2(Number(it.quantity) * qty), note: `BOM ×${qty}`, createdBy: opts.createdBy });
      if (r.ok) consumed++;
    }
    return { ok: true, consumed };
  }

  /** Checklist de qualidade (aprovado/reprovado). */
  static addQualityCheck(orgId: string, orderId: string, input: { name: string; passed?: boolean; stepId?: string | null; notes?: string; createdBy?: string }): { ok: boolean; id?: string; error?: string } {
    const o = db.prepare("SELECT id FROM production_orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!o) return { ok: false, error: "Ordem não encontrada." };
    if (!String(input?.name || "").trim()) return { ok: false, error: "Informe o item de qualidade." };
    const id = randomUUID();
    const passed = input.passed === false ? 0 : 1;
    db.prepare("INSERT INTO quality_checks (id, organization_id, order_id, step_id, name, passed, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, orgId, orderId, input.stepId || null, String(input.name).trim().slice(0, 160), passed, input.notes || null, input.createdBy || null);
    event(orgId, orderId, "quality", { note: `${input.name}: ${passed ? "OK" : "REPROVADO"}`, createdBy: input.createdBy });
    return { ok: true, id };
  }

  /** Registra uma parada (motivo + minutos). */
  static addDowntime(orgId: string, orderId: string, input: { reason: string; minutes?: number; note?: string; createdBy?: string }): { ok: boolean; id?: string; error?: string } {
    const o = db.prepare("SELECT id FROM production_orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!o) return { ok: false, error: "Ordem não encontrada." };
    if (!String(input?.reason || "").trim()) return { ok: false, error: "Informe o motivo da parada." };
    const minutes = Math.max(0, Math.trunc(Number(input.minutes) || 0));
    const id = randomUUID();
    db.prepare("INSERT INTO downtime_events (id, organization_id, order_id, reason, minutes, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, orgId, orderId, String(input.reason).trim().slice(0, 160), minutes, input.note || null, input.createdBy || null);
    event(orgId, orderId, "downtime", { qty: minutes, note: input.reason, createdBy: input.createdBy });
    return { ok: true, id };
  }

  static listConsumptions(orgId: string, orderId: string): any[] {
    return db.prepare(`SELECT mc.*, ps.name AS material_name FROM material_consumptions mc JOIN products_services ps ON ps.id = mc.material_product_service_id AND ps.organization_id = mc.organization_id WHERE mc.organization_id = ? AND mc.order_id = ? ORDER BY mc.created_at DESC`).all(orgId, orderId) as any[];
  }
  static listQualityChecks(orgId: string, orderId: string): any[] {
    return db.prepare("SELECT * FROM quality_checks WHERE organization_id = ? AND order_id = ? ORDER BY created_at DESC").all(orgId, orderId) as any[];
  }
  static listDowntime(orgId: string, orderId: string): any[] {
    return db.prepare("SELECT * FROM downtime_events WHERE organization_id = ? AND order_id = ? ORDER BY created_at DESC").all(orgId, orderId) as any[];
  }

  /** Resumo do chão de fábrica de uma ordem. */
  static summary(orgId: string, orderId: string): any {
    const consumed = round2((db.prepare("SELECT COALESCE(SUM(quantity),0) s FROM material_consumptions WHERE organization_id = ? AND order_id = ?").get(orgId, orderId) as any).s);
    const q = db.prepare("SELECT COUNT(*) total, COALESCE(SUM(CASE WHEN passed=0 THEN 1 ELSE 0 END),0) failed FROM quality_checks WHERE organization_id = ? AND order_id = ?").get(orgId, orderId) as any;
    const downtimeMinutes = (db.prepare("SELECT COALESCE(SUM(minutes),0) m FROM downtime_events WHERE organization_id = ? AND order_id = ?").get(orgId, orderId) as any).m;
    return { totalConsumed: consumed, qualityChecks: q.total, qualityFailed: q.failed, downtimeMinutes };
  }
}

export default ProductionShopFloorService;
