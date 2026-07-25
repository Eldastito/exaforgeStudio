import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { InventoryLocationService } from "./InventoryLocationService.js";
import { ConsumptionLedgerService } from "./ConsumptionLedgerService.js";

/**
 * MaterialRequestService — CONTROLER (PRD-E-007, Fatia 2, §11).
 *
 * Requisição interna GOVERNADA: solicitar → aprovar (maker-checker: quem aprova
 * ≠ quem solicitou, §4.4) → retirar (debita o saldo do LOCAL e registra consumo,
 * nunca edita saldo) → confirmar recebimento → devolver sobra (credita de volta
 * e estorna o consumo). Determinístico, auditável, isolado por organization_id.
 */

const PRIORITIES = ["baixa", "normal", "alta", "urgente"];
const clean = (s: any) => (s == null ? null : String(s).trim() || null);
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface RequestItemInput { productId: string; quantity: number; uom?: string | null; }
export interface RequestInput {
  requesterUserId?: string | null;
  departmentId?: string | null;
  costCenterId?: string | null;
  purpose?: string | null;
  priority?: string;
  notes?: string | null;
  items: RequestItemInput[];
}

export class MaterialRequestService {
  static get(orgId: string, id: string): any {
    const r = db.prepare("SELECT * FROM material_requests WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!r) return null;
    r.items = db.prepare("SELECT * FROM material_request_items WHERE request_id = ? AND organization_id = ? ORDER BY rowid").all(id, orgId);
    return r;
  }

  static list(orgId: string, opts: { status?: string; departmentId?: string } = {}): any[] {
    let sql = "SELECT * FROM material_requests WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    if (opts.departmentId) { sql += " AND department_id = ?"; params.push(opts.departmentId); }
    sql += " ORDER BY created_at DESC LIMIT 200";
    return db.prepare(sql).all(...params) as any[];
  }

  static create(orgId: string, input: RequestInput, actorId?: string): any {
    const items = Array.isArray(input.items) ? input.items : [];
    if (!items.length) throw new Error("A requisição exige ao menos um item.");
    const priority = clean(input.priority) || "normal";
    if (!PRIORITIES.includes(priority)) throw new Error(`Prioridade inválida. Use: ${PRIORITIES.join(", ")}.`);
    const requesterUserId = clean(input.requesterUserId) || actorId || null;
    if (requesterUserId && !db.prepare("SELECT id FROM users WHERE id = ? AND organization_id = ?").get(requesterUserId, orgId)) throw new Error("Solicitante não encontrado na organização.");
    const departmentId = clean(input.departmentId);
    if (departmentId && !db.prepare("SELECT id FROM business_departments WHERE id = ? AND organization_id = ?").get(departmentId, orgId)) throw new Error("Departamento não encontrado na organização.");
    const costCenterId = clean(input.costCenterId);
    if (costCenterId && !db.prepare("SELECT id FROM cost_centers WHERE id = ? AND organization_id = ?").get(costCenterId, orgId)) throw new Error("Centro de custo não encontrado na organização.");

    // Valida itens ANTES de gravar.
    const prepared = items.map((it) => {
      const qty = round2(it.quantity);
      if (!(qty > 0)) throw new Error("Quantidade de item deve ser positiva.");
      const prod = db.prepare("SELECT id, default_uom FROM products_services WHERE id = ? AND organization_id = ?").get(it.productId, orgId) as any;
      if (!prod) throw new Error("Produto do item não encontrado na organização.");
      return { productId: it.productId, quantity: qty, uom: clean(it.uom) || prod.default_uom || null };
    });

    const id = randomUUID();
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO material_requests (id, organization_id, requester_user_id, department_id, cost_center_id, purpose, priority, status, notes)
                  VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`).run(id, orgId, requesterUserId, departmentId, costCenterId, clean(input.purpose), priority, clean(input.notes));
      for (const p of prepared) {
        db.prepare(`INSERT INTO material_request_items (id, request_id, organization_id, product_service_id, uom, qty_requested)
                    VALUES (?, ?, ?, ?, ?, ?)`).run(randomUUID(), id, orgId, p.productId, p.uom, p.quantity);
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", id, "MATERIAL_REQUEST_CREATE", { items: prepared.length }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static approve(orgId: string, id: string, actorId: string | undefined, opts: { items?: Array<{ itemId: string; qtyApproved: number }> } = {}): any {
    const req = this.get(orgId, id);
    if (!req) throw new Error("Requisição não encontrada.");
    if (req.status !== "pending") throw new Error(`Só é possível aprovar requisição pendente (atual: ${req.status}).`);
    // Segregação de funções (§4.4): quem aprova ≠ quem solicitou.
    if (req.requester_user_id && actorId && req.requester_user_id === actorId) throw new Error("Segregação: o solicitante não pode aprovar a própria requisição.");
    const overrides = new Map((opts.items || []).map((i) => [i.itemId, round2(i.qtyApproved)]));
    const tx = db.transaction(() => {
      for (const it of req.items) {
        let qa = overrides.has(it.id) ? overrides.get(it.id)! : Number(it.qty_requested);
        if (qa < 0) qa = 0;
        if (qa > Number(it.qty_requested)) throw new Error("Quantidade aprovada não pode exceder a solicitada.");
        db.prepare("UPDATE material_request_items SET qty_approved = ? WHERE id = ? AND organization_id = ?").run(qa, it.id, orgId);
      }
      db.prepare("UPDATE material_requests SET status = 'approved', approved_by = ?, approved_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(actorId || null, id, orgId);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", id, "MATERIAL_REQUEST_APPROVE", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static reject(orgId: string, id: string, actorId?: string, reason?: string): any {
    const req = this.get(orgId, id);
    if (!req) throw new Error("Requisição não encontrada.");
    if (req.status !== "pending") throw new Error(`Só é possível rejeitar requisição pendente (atual: ${req.status}).`);
    db.prepare("UPDATE material_requests SET status = 'rejected', approved_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(actorId || null, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "MATERIAL_REQUEST_REJECT", { reason: reason || null }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static cancel(orgId: string, id: string, actorId?: string): any {
    const req = this.get(orgId, id);
    if (!req) throw new Error("Requisição não encontrada.");
    if (!["pending", "approved"].includes(req.status)) throw new Error(`Só é possível cancelar antes da retirada (atual: ${req.status}).`);
    db.prepare("UPDATE material_requests SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "MATERIAL_REQUEST_CANCEL", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Retirada do almoxarifado: debita o saldo do local e registra o consumo. */
  static issue(orgId: string, id: string, actorId: string | undefined, opts: { fromLocationId: string }): any {
    const req = this.get(orgId, id);
    if (!req) throw new Error("Requisição não encontrada.");
    if (req.status !== "approved") throw new Error(`Só é possível retirar requisição aprovada (atual: ${req.status}).`);
    const locId = clean(opts.fromLocationId);
    if (!locId) throw new Error("Informe o local de origem da retirada.");
    const loc = InventoryLocationService.get(orgId, locId);
    if (!loc || !loc.active) throw new Error("Local de origem inválido ou inativo.");

    const toIssue = req.items.filter((it: any) => Number(it.qty_approved) > 0);
    if (!toIssue.length) throw new Error("Nenhum item com quantidade aprovada para retirar.");
    // Valida saldo de TODOS os itens antes de mexer (tudo-ou-nada).
    for (const it of toIssue) {
      const bal = InventoryLocationService.balanceOf(orgId, locId, it.product_service_id);
      if (bal < Number(it.qty_approved)) throw new Error(`Saldo insuficiente de ${it.product_service_id} no local (disponível ${bal}, necessário ${it.qty_approved}).`);
    }
    const tx = db.transaction(() => {
      for (const it of toIssue) {
        const qty = Number(it.qty_approved);
        InventoryLocationService.issue(orgId, { locationId: locId, productId: it.product_service_id, quantity: qty }, actorId);
        db.prepare("UPDATE material_request_items SET qty_issued = ? WHERE id = ? AND organization_id = ?").run(qty, it.id, orgId);
        ConsumptionLedgerService.record(orgId, {
          productId: it.product_service_id, locationId: locId, costCenterId: req.cost_center_id, departmentId: req.department_id,
          direction: "out", quantity: qty, uom: it.uom, sourceType: "issue", sourceId: id, actorUserId: actorId,
        });
      }
      db.prepare("UPDATE material_requests SET status = 'issued', issued_by = ?, issued_at = CURRENT_TIMESTAMP, from_location_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(actorId || null, locId, id, orgId);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", id, "MATERIAL_REQUEST_ISSUE", { fromLocationId: locId }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Recebedor confirma o recebimento do material retirado. */
  static acknowledge(orgId: string, id: string, actorId?: string): any {
    const req = this.get(orgId, id);
    if (!req) throw new Error("Requisição não encontrada.");
    if (req.status !== "issued") throw new Error(`Só é possível confirmar recebimento de requisição retirada (atual: ${req.status}).`);
    db.prepare("UPDATE material_requests SET status = 'acknowledged', acknowledged_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "MATERIAL_REQUEST_ACK", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Devolução de sobra: credita de volta no local e estorna o consumo. */
  static returnItems(orgId: string, id: string, input: { items: Array<{ itemId: string; quantity: number }>; toLocationId?: string | null }, actorId?: string): any {
    const req = this.get(orgId, id);
    if (!req) throw new Error("Requisição não encontrada.");
    if (!["issued", "acknowledged"].includes(req.status)) throw new Error(`Só é possível devolver após a retirada (atual: ${req.status}).`);
    const toLoc = clean(input.toLocationId) || req.from_location_id;
    if (!toLoc) throw new Error("Informe o local de devolução.");
    if (!InventoryLocationService.get(orgId, toLoc)) throw new Error("Local de devolução não encontrado na organização.");
    const rows = Array.isArray(input.items) ? input.items : [];
    if (!rows.length) throw new Error("Informe os itens a devolver.");
    const byId = new Map(req.items.map((it: any) => [it.id, it]));

    const tx = db.transaction(() => {
      for (const r of rows) {
        const it: any = byId.get(r.itemId);
        if (!it) throw new Error("Item da devolução não pertence à requisição.");
        const qty = round2(r.quantity);
        const returnable = Number(it.qty_issued) - Number(it.qty_returned);
        if (!(qty > 0)) throw new Error("Quantidade de devolução deve ser positiva.");
        if (qty > returnable) throw new Error(`Devolução acima do retirado (retornável ${returnable}, pedido ${qty}).`);
        InventoryLocationService.receive(orgId, { locationId: toLoc, productId: it.product_service_id, quantity: qty }, actorId);
        db.prepare("UPDATE material_request_items SET qty_returned = ? WHERE id = ? AND organization_id = ?").run(round2(Number(it.qty_returned) + qty), it.id, orgId);
        ConsumptionLedgerService.record(orgId, {
          productId: it.product_service_id, locationId: toLoc, costCenterId: req.cost_center_id, departmentId: req.department_id,
          direction: "in", quantity: qty, uom: it.uom, sourceType: "return", sourceId: id, actorUserId: actorId,
        });
      }
      // Se tudo que saiu voltou, marca 'returned'.
      const after = db.prepare("SELECT SUM(qty_issued) AS iss, SUM(qty_returned) AS ret FROM material_request_items WHERE request_id = ? AND organization_id = ?").get(id, orgId) as any;
      if (Number(after.iss) > 0 && round2(Number(after.iss)) === round2(Number(after.ret))) {
        db.prepare("UPDATE material_requests SET status = 'returned', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(id, orgId);
      } else {
        db.prepare("UPDATE material_requests SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(id, orgId);
      }
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", id, "MATERIAL_REQUEST_RETURN", { toLocationId: toLoc }); } catch { /* noop */ }
    return this.get(orgId, id);
  }
}

export default MaterialRequestService;
