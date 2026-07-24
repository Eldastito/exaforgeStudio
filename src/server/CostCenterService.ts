import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

/**
 * CostCenterService — CONTROLER (PRD-E-007, Fatia 1a).
 *
 * Cadastro de CENTROS DE CUSTO — a dimensão em que todo consumo, despesa e rateio
 * futuro será apropriado (requisições, orçamento, custo indireto, precificação
 * penduram aqui). Aditivo e opt-in. Determinístico, auditável, isolado por
 * organization_id. Vínculo opcional a um departamento e a uma loja/unidade.
 */

export interface CostCenterInput {
  name: string;
  code?: string | null;
  departmentId?: string | null;
  storeId?: string | null;
  budgetOwnerUserId?: string | null;
  active?: boolean;
}

const clean = (s: any) => (s == null ? null : String(s).trim() || null);

export class CostCenterService {
  static get(orgId: string, id: string): any {
    return db.prepare("SELECT * FROM cost_centers WHERE id = ? AND organization_id = ?").get(id, orgId) || null;
  }

  static list(orgId: string, opts: { includeInactive?: boolean; departmentId?: string } = {}): any[] {
    let sql = "SELECT * FROM cost_centers WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (!opts.includeInactive) sql += " AND active = 1";
    if (opts.departmentId) { sql += " AND department_id = ?"; params.push(opts.departmentId); }
    sql += " ORDER BY name";
    return db.prepare(sql).all(...params) as any[];
  }

  private static assertValid(orgId: string, input: CostCenterInput, selfId?: string): { name: string; code: string | null; departmentId: string | null; storeId: string | null; ownerId: string | null } {
    const name = clean(input.name);
    if (!name) throw new Error("Centro de custo exige nome.");
    const code = clean(input.code);
    if (code) {
      const dup = db.prepare("SELECT id FROM cost_centers WHERE organization_id = ? AND code = ? AND id <> ?").get(orgId, code, selfId || "") as any;
      if (dup) throw new Error(`Já existe centro de custo com o código '${code}'.`);
    }
    const departmentId = clean(input.departmentId);
    if (departmentId && !db.prepare("SELECT id FROM business_departments WHERE id = ? AND organization_id = ?").get(departmentId, orgId)) throw new Error("Departamento não encontrado na organização.");
    const storeId = clean(input.storeId);
    const ownerId = clean(input.budgetOwnerUserId);
    if (ownerId && !db.prepare("SELECT id FROM users WHERE id = ? AND organization_id = ?").get(ownerId, orgId)) throw new Error("Dono do orçamento (usuário) não encontrado na organização.");
    return { name, code, departmentId, storeId, ownerId };
  }

  static create(orgId: string, input: CostCenterInput, actorId?: string): any {
    const v = this.assertValid(orgId, input);
    const id = randomUUID();
    db.prepare(`INSERT INTO cost_centers (id, organization_id, name, code, department_id, store_id, budget_owner_user_id, active)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)`).run(id, orgId, v.name, v.code, v.departmentId, v.storeId, v.ownerId);
    try { logAuthEvent(orgId, actorId || "system", id, "COST_CENTER_CREATE", { name: v.name, code: v.code }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static update(orgId: string, id: string, input: CostCenterInput, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Centro de custo não encontrado.");
    const v = this.assertValid(orgId, input, id);
    const active = input.active == null ? existing.active : (input.active ? 1 : 0);
    db.prepare(`UPDATE cost_centers SET name = ?, code = ?, department_id = ?, store_id = ?, budget_owner_user_id = ?, active = ?, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND organization_id = ?`).run(v.name, v.code, v.departmentId, v.storeId, v.ownerId, active, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, "COST_CENTER_UPDATE", { name: v.name }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static setActive(orgId: string, id: string, active: boolean, actorId?: string): any {
    const existing = this.get(orgId, id);
    if (!existing) throw new Error("Centro de custo não encontrado.");
    db.prepare("UPDATE cost_centers SET active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?").run(active ? 1 : 0, id, orgId);
    try { logAuthEvent(orgId, actorId || "system", id, active ? "COST_CENTER_ACTIVATE" : "COST_CENTER_DEACTIVATE", {}); } catch { /* noop */ }
    return this.get(orgId, id);
  }
}

export default CostCenterService;
