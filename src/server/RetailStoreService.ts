/**
 * Retail Ops — Cadastro de lojas (ADR-083, Fase A).
 *
 * Dimensão de loja física, inexistente até aqui (estoque/pedidos do core são só
 * por organização). Camada ADITIVA: nada aqui toca orders/inventory (D1). Cada
 * loja carrega o `whatsapp_identifier` que, nas fases seguintes, casa o
 * fechamento recebido pelo WhatsApp ao remetente/loja. Isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type StoreInput = {
  name: string;
  code?: string | null;
  whatsappIdentifier?: string | null;
  managerUserId?: string | null;
  managerContactId?: string | null;
  active?: boolean;
};

export class RetailStoreService {
  static list(orgId: string): any[] {
    return db.prepare(
      `SELECT id, name, code, whatsapp_identifier, manager_user_id, manager_contact_id, active, created_at, updated_at
         FROM retail_stores WHERE organization_id = ? ORDER BY active DESC, name ASC`
    ).all(orgId) as any[];
  }

  static get(orgId: string, id: string): any | null {
    return (db.prepare(
      `SELECT id, name, code, whatsapp_identifier, manager_user_id, manager_contact_id, active, created_at, updated_at
         FROM retail_stores WHERE organization_id = ? AND id = ?`
    ).get(orgId, id) as any) || null;
  }

  /** Resolve a loja pelo identificador de WhatsApp do remetente (fases B–D). */
  static findByWhatsapp(orgId: string, identifier: string): any | null {
    if (!identifier) return null;
    return (db.prepare(
      `SELECT * FROM retail_stores WHERE organization_id = ? AND whatsapp_identifier = ? AND active = 1 LIMIT 1`
    ).get(orgId, identifier) as any) || null;
  }

  static create(orgId: string, input: StoreInput, actorId?: string): any {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("Nome da loja é obrigatório");
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_stores (id, organization_id, name, code, whatsapp_identifier, manager_user_id, manager_contact_id, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, orgId, name,
      input.code ? String(input.code).trim() : null,
      input.whatsappIdentifier ? String(input.whatsappIdentifier).trim() : null,
      input.managerUserId || null,
      input.managerContactId || null,
      input.active === false ? 0 : 1
    );
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_CREATED", { name }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  static update(orgId: string, id: string, patch: Partial<StoreInput>, actorId?: string): any | null {
    const cur = this.get(orgId, id);
    if (!cur) return null;
    const fields: string[] = [];
    const vals: any[] = [];
    const map: Record<string, any> = {
      name: patch.name !== undefined ? String(patch.name).trim() : undefined,
      code: patch.code !== undefined ? (patch.code ? String(patch.code).trim() : null) : undefined,
      whatsapp_identifier: patch.whatsappIdentifier !== undefined ? (patch.whatsappIdentifier ? String(patch.whatsappIdentifier).trim() : null) : undefined,
      manager_user_id: patch.managerUserId !== undefined ? (patch.managerUserId || null) : undefined,
      manager_contact_id: patch.managerContactId !== undefined ? (patch.managerContactId || null) : undefined,
      active: patch.active !== undefined ? (patch.active ? 1 : 0) : undefined,
    };
    for (const [col, v] of Object.entries(map)) {
      if (v !== undefined) { fields.push(`${col} = ?`); vals.push(v); }
    }
    if (!fields.length) return cur;
    fields.push(`updated_at = CURRENT_TIMESTAMP`);
    db.prepare(`UPDATE retail_stores SET ${fields.join(", ")} WHERE organization_id = ? AND id = ?`).run(...vals, orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_UPDATED", { fields: Object.keys(map).filter((k) => map[k] !== undefined) }); } catch { /* noop */ }
    return this.get(orgId, id);
  }
}
