import db from "./db.js";
import { randomUUID } from "crypto";
import { ProductionService } from "./ProductionService.js";
import { ProductionShopFloorService } from "./ProductionShopFloorService.js";

/**
 * ProductionOrderService (Supervisor de Produção IA — fatia 2, ADR-141).
 *
 * Ordem de produção: quantidade planejada/produzida/refugada/PENDENTE, etapas e
 * responsáveis, apontamento de progresso, e ATRASO determinístico (data
 * prometida × hoje). Reusa a BOM (necessidade de materiais) da fatia 1. Cada
 * apontamento vira um `production_events` (auditável). Sem execução externa —
 * o apontamento é humano (ou preparado pela IA para confirmação). Isolado por
 * organization_id.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export class ProductionOrderService {
  static create(orgId: string, input: { manufacturedProductId: string; bomId?: string | null; qtyPlanned: number; promisedDate?: string | null; expectedDate?: string | null; createdBy?: string }): { ok: boolean; id?: string; error?: string } {
    const mp = db.prepare("SELECT id FROM manufactured_products WHERE id = ? AND organization_id = ?").get(input.manufacturedProductId, orgId) as any;
    if (!mp) return { ok: false, error: "Produto fabricado não encontrado." };
    const qty = Number(input.qtyPlanned);
    if (!(qty > 0)) return { ok: false, error: "Quantidade planejada deve ser > 0." };
    if (input.bomId) {
      const bom = db.prepare("SELECT id FROM bill_of_materials WHERE id = ? AND organization_id = ? AND manufactured_product_id = ?").get(input.bomId, orgId, input.manufacturedProductId) as any;
      if (!bom) return { ok: false, error: "BOM inválida para este produto." };
    }
    const id = randomUUID();
    db.prepare("INSERT INTO production_orders (id, organization_id, manufactured_product_id, bom_id, qty_planned, promised_date, expected_date, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, orgId, input.manufacturedProductId, input.bomId || null, round2(qty), input.promisedDate || null, input.expectedDate || null, input.createdBy || null);
    return { ok: true, id };
  }

  static addStep(orgId: string, orderId: string, input: { name: string; seq?: number; assignedTo?: string | null }): { ok: boolean; id?: string; error?: string } {
    const o = db.prepare("SELECT id FROM production_orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!o) return { ok: false, error: "Ordem não encontrada." };
    if (!String(input?.name || "").trim()) return { ok: false, error: "Informe o nome da etapa." };
    const seq = Number.isFinite(input.seq) ? Number(input.seq) : ((db.prepare("SELECT COALESCE(MAX(seq),0) m FROM production_steps WHERE order_id = ? AND organization_id = ?").get(orderId, orgId) as any).m + 1);
    const id = randomUUID();
    db.prepare("INSERT INTO production_steps (id, organization_id, order_id, seq, name, assigned_to) VALUES (?, ?, ?, ?, ?, ?)").run(id, orgId, orderId, seq, String(input.name).trim().slice(0, 160), input.assignedTo || null);
    return { ok: true, id };
  }

  static setStepStatus(orgId: string, stepId: string, status: string): { ok: boolean; error?: string } {
    if (!["pending", "in_progress", "done"].includes(status)) return { ok: false, error: "Status de etapa inválido." };
    const r = db.prepare("UPDATE production_steps SET status = ? WHERE id = ? AND organization_id = ?").run(status, stepId, orgId);
    return r.changes ? { ok: true } : { ok: false, error: "Etapa não encontrada." };
  }

  private static event(orgId: string, orderId: string, kind: string, opts: { stepId?: string | null; qty?: number | null; note?: string | null; createdBy?: string | null } = {}) {
    db.prepare("INSERT INTO production_events (id, organization_id, order_id, step_id, kind, qty, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), orgId, orderId, opts.stepId || null, kind, opts.qty != null ? Number(opts.qty) : null, opts.note || null, opts.createdBy || null);
  }

  static release(orgId: string, orderId: string, opts: { createdBy?: string } = {}): { ok: boolean; error?: string } {
    const o = db.prepare("SELECT status FROM production_orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!o) return { ok: false, error: "Ordem não encontrada." };
    if (!["draft"].includes(o.status)) return { ok: false, error: `Só libera ordem em rascunho (atual: ${o.status}).` };
    db.prepare("UPDATE production_orders SET status = 'released' WHERE id = ? AND organization_id = ?").run(orderId, orgId);
    this.event(orgId, orderId, "release", { createdBy: opts.createdBy });
    return { ok: true };
  }

  /** Apontamento de progresso (unidades boas e/ou refugo). Atualiza saldos e status. */
  static report(orgId: string, orderId: string, input: { producedQty?: number; scrappedQty?: number; stepId?: string | null; note?: string | null; createdBy?: string }): { ok: boolean; error?: string; status?: string } {
    const o = db.prepare("SELECT * FROM production_orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!o) return { ok: false, error: "Ordem não encontrada." };
    if (!["released", "in_progress"].includes(o.status)) return { ok: false, error: `Ordem não está em produção (atual: ${o.status}). Libere-a primeiro.` };
    const produced = Math.max(0, Number(input.producedQty) || 0);
    const scrapped = Math.max(0, Number(input.scrappedQty) || 0);
    if (produced === 0 && scrapped === 0) return { ok: false, error: "Informe quantidade produzida e/ou refugada." };

    const newProduced = round2(o.qty_produced + produced);
    const newScrapped = round2(o.qty_scrapped + scrapped);
    const done = newProduced >= o.qty_planned;
    db.prepare(`UPDATE production_orders SET qty_produced = ?, qty_scrapped = ?, status = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP), completed_at = ? WHERE id = ? AND organization_id = ?`)
      .run(newProduced, newScrapped, done ? "done" : "in_progress", done ? new Date().toISOString() : null, orderId, orgId);
    if (produced > 0) this.event(orgId, orderId, "progress", { stepId: input.stepId, qty: produced, note: input.note, createdBy: input.createdBy });
    if (scrapped > 0) this.event(orgId, orderId, "scrap", { stepId: input.stepId, qty: scrapped, note: input.note, createdBy: input.createdBy });
    if (done) this.event(orgId, orderId, "complete", { createdBy: input.createdBy });
    return { ok: true, status: done ? "done" : "in_progress" };
  }

  static cancel(orgId: string, orderId: string, opts: { createdBy?: string } = {}): { ok: boolean; error?: string } {
    const o = db.prepare("SELECT status FROM production_orders WHERE id = ? AND organization_id = ?").get(orderId, orgId) as any;
    if (!o) return { ok: false, error: "Ordem não encontrada." };
    if (["done", "cancelled"].includes(o.status)) return { ok: false, error: `Ordem já finalizada (${o.status}).` };
    db.prepare("UPDATE production_orders SET status = 'cancelled' WHERE id = ? AND organization_id = ?").run(orderId, orgId);
    this.event(orgId, orderId, "cancel", { createdBy: opts.createdBy });
    return { ok: true };
  }

  /** Saldo pendente e atraso determinísticos + etapas/eventos/necessidade. */
  static get(orgId: string, orderId: string, opts: { asOfDate?: string } = {}): any | null {
    const o = db.prepare(`SELECT po.*, mp.name AS product_name FROM production_orders po JOIN manufactured_products mp ON mp.id = po.manufactured_product_id AND mp.organization_id = po.organization_id WHERE po.id = ? AND po.organization_id = ?`).get(orderId, orgId) as any;
    if (!o) return null;
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOfDate || "")) ? opts.asOfDate! : today();
    o.pending = round2(Math.max(0, o.qty_planned - o.qty_produced));
    o.late = !!(o.promised_date && o.promised_date < asOf && !["done", "cancelled"].includes(o.status));
    o.steps = db.prepare("SELECT * FROM production_steps WHERE organization_id = ? AND order_id = ? ORDER BY seq, created_at").all(orgId, orderId);
    o.events = db.prepare("SELECT * FROM production_events WHERE organization_id = ? AND order_id = ? ORDER BY created_at DESC LIMIT 100").all(orgId, orderId);
    o.requirements = o.bom_id ? ProductionService.materialRequirements(orgId, o.bom_id, o.pending || o.qty_planned) : null;
    // Chão de fábrica (fatia 3): consumo real, qualidade e paradas.
    o.consumptions = ProductionShopFloorService.listConsumptions(orgId, orderId);
    o.qualityChecks = ProductionShopFloorService.listQualityChecks(orgId, orderId);
    o.downtime = ProductionShopFloorService.listDowntime(orgId, orderId);
    o.shopFloor = ProductionShopFloorService.summary(orgId, orderId);
    return o;
  }

  static list(orgId: string, opts: { status?: string; asOfDate?: string } = {}): any[] {
    let sql = "SELECT * FROM production_orders WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY created_at DESC LIMIT 200";
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOfDate || "")) ? opts.asOfDate! : today();
    return (db.prepare(sql).all(...params) as any[]).map((o) => ({
      ...o, pending: round2(Math.max(0, o.qty_planned - o.qty_produced)),
      late: !!(o.promised_date && o.promised_date < asOf && !["done", "cancelled"].includes(o.status)),
    }));
  }
}

export default ProductionOrderService;
