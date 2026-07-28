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
  address?: string | null;
  city?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

const STORE_COLS = `id, name, code, whatsapp_identifier, manager_user_id, manager_contact_id, active, address, city, latitude, longitude, created_at, updated_at`;
const numOrNull = (v: any): number | null => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

export class RetailStoreService {
  static list(orgId: string): any[] {
    return db.prepare(
      `SELECT ${STORE_COLS} FROM retail_stores WHERE organization_id = ? ORDER BY active DESC, name ASC`
    ).all(orgId) as any[];
  }

  static get(orgId: string, id: string): any | null {
    return (db.prepare(
      `SELECT ${STORE_COLS} FROM retail_stores WHERE organization_id = ? AND id = ?`
    ).get(orgId, id) as any) || null;
  }

  /** Resolve a loja pelo identificador de WhatsApp do remetente (fases B–D). */
  static findByWhatsapp(orgId: string, identifier: string): any | null {
    if (!identifier) return null;
    return (db.prepare(
      `SELECT * FROM retail_stores WHERE organization_id = ? AND whatsapp_identifier = ? AND active = 1 LIMIT 1`
    ).get(orgId, identifier) as any) || null;
  }

  /** Código de filial é a CHAVE do casamento com o ERP (estoque, caixa) — duas
   *  lojas ativas com o mesmo código fazem os dados caírem numa delas ao acaso. */
  private static assertCodeFree(orgId: string, code: string | null | undefined, exceptId?: string): void {
    const c = code ? String(code).trim() : "";
    if (!c) return;
    const dup = db.prepare(
      `SELECT name FROM retail_stores WHERE organization_id = ? AND active = 1 AND code = ? ${exceptId ? "AND id <> ?" : ""} LIMIT 1`
    ).get(...(exceptId ? [orgId, c, exceptId] : [orgId, c])) as any;
    if (dup) throw new Error(`Já existe a loja ativa "${dup.name}" com o código ${c}. Edite a loja existente em vez de criar outra (o código da filial precisa ser único — é por ele que o estoque e o caixa do ERP são casados).`);
  }

  static create(orgId: string, input: StoreInput, actorId?: string): any {
    const name = String(input.name || "").trim();
    if (!name) throw new Error("Nome da loja é obrigatório");
    this.assertCodeFree(orgId, input.code);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO retail_stores (id, organization_id, name, code, whatsapp_identifier, manager_user_id, manager_contact_id, active, address, city, latitude, longitude)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, orgId, name,
      input.code ? String(input.code).trim() : null,
      input.whatsappIdentifier ? String(input.whatsappIdentifier).trim() : null,
      input.managerUserId || null,
      input.managerContactId || null,
      input.active === false ? 0 : 1,
      input.address ? String(input.address).trim() : null,
      input.city ? String(input.city).trim() : null,
      numOrNull(input.latitude),
      numOrNull(input.longitude)
    );
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_CREATED", { name }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /**
   * EXCLUI uma loja duplicada com segurança: se existir OUTRA loja com o mesmo
   * código, todo o histórico (estoque, fechamentos, cotas, tarefas, alertas,
   * pedidos) é UNIFICADO nela antes de apagar — excluir sem unificar perderia
   * fechamentos/estoque já gravados. Sem outra loja de mesmo código, só permite
   * excluir se a loja não tiver fechamentos nem estoque (senão: desativar).
   */
  static remove(orgId: string, id: string, actorId?: string): { deleted: boolean; mergedInto: string | null; mergedIntoName?: string } {
    const cur = this.get(orgId, id);
    if (!cur) throw new Error("Loja não encontrada.");
    const code = cur.code ? String(cur.code).trim() : "";
    const target = code
      ? (db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id <> ? AND code = ? ORDER BY active DESC, created_at ASC LIMIT 1`).get(orgId, id, code) as any)
      : null;

    if (!target) {
      const hasClosings = db.prepare(`SELECT 1 FROM retail_daily_closings WHERE organization_id = ? AND store_id = ? LIMIT 1`).get(orgId, id);
      const hasStock = db.prepare(`SELECT 1 FROM retail_store_inventory WHERE organization_id = ? AND store_id = ? LIMIT 1`).get(orgId, id);
      if (hasClosings || hasStock) throw new Error("Esta loja tem fechamentos/estoque e não existe outra loja com o mesmo código para unificar — desative em vez de excluir.");
      db.prepare(`DELETE FROM retail_stores WHERE organization_id = ? AND id = ?`).run(orgId, id);
      try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_DELETED", { name: cur.name }); } catch { /* noop */ }
      return { deleted: true, mergedInto: null };
    }

    const tx = db.transaction(() => {
      // Fechamentos: move os dias que o alvo não tem; nos conflitos, completa
      // campos vazios do alvo com os da duplicata e descarta a linha duplicada.
      const conflicts = db.prepare(
        `SELECT s.id AS src_id, t.id AS tgt_id, s.informed_total AS s_inf, s.system_total AS s_sys, t.informed_total AS t_inf, t.system_total AS t_sys
           FROM retail_daily_closings s JOIN retail_daily_closings t
             ON t.organization_id = s.organization_id AND t.store_id = ? AND t.closing_date = s.closing_date
          WHERE s.organization_id = ? AND s.store_id = ?`
      ).all(target.id, orgId, id) as any[];
      for (const c of conflicts) {
        if (Number(c.t_inf || 0) === 0 && Number(c.s_inf || 0) > 0) db.prepare(`UPDATE retail_daily_closings SET informed_total = ?, status = 'received' WHERE id = ?`).run(c.s_inf, c.tgt_id);
        if (Number(c.t_sys || 0) === 0 && Number(c.s_sys || 0) > 0) db.prepare(`UPDATE retail_daily_closings SET system_total = ? WHERE id = ?`).run(c.s_sys, c.tgt_id);
        db.prepare(`DELETE FROM retail_daily_closing_items WHERE closing_id = ?`).run(c.src_id);
        db.prepare(`DELETE FROM retail_daily_closings WHERE id = ?`).run(c.src_id);
      }
      db.prepare(`UPDATE retail_daily_closings SET store_id = ? WHERE organization_id = ? AND store_id = ?`).run(target.id, orgId, id);

      // Tabelas com UNIQUE por loja: move o que não conflita, descarta o resto
      // (o alvo, que continuou sincronizando, tende a estar mais fresco).
      for (const t of ["retail_store_quotas", "retail_store_inventory", "retail_stock_alerts", "retail_store_daily_tasks"]) {
        try {
          db.prepare(`UPDATE OR IGNORE ${t} SET store_id = ? WHERE organization_id = ? AND store_id = ?`).run(target.id, orgId, id);
          db.prepare(`DELETE FROM ${t} WHERE organization_id = ? AND store_id = ?`).run(orgId, id);
        } catch { /* tabela pode não existir em bases antigas */ }
      }
      // Referências sem UNIQUE: só re-aponta.
      for (const t of ["retail_store_responsibles", "retail_goods_receipts", "retail_store_patterns", "orders"]) {
        try { db.prepare(`UPDATE ${t} SET store_id = ? WHERE organization_id = ? AND store_id = ?`).run(target.id, orgId, id); } catch { /* noop */ }
      }
      db.prepare(`DELETE FROM retail_stores WHERE organization_id = ? AND id = ?`).run(orgId, id);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_STORE_MERGED_DELETED", { name: cur.name, into: target.id, intoName: target.name }); } catch { /* noop */ }
    return { deleted: true, mergedInto: target.id, mergedIntoName: target.name };
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
      address: patch.address !== undefined ? (patch.address ? String(patch.address).trim() : null) : undefined,
      city: patch.city !== undefined ? (patch.city ? String(patch.city).trim() : null) : undefined,
      latitude: patch.latitude !== undefined ? numOrNull(patch.latitude) : undefined,
      longitude: patch.longitude !== undefined ? numOrNull(patch.longitude) : undefined,
    };
    // Guarda de código único entre lojas ATIVAS: cobre troca de código e
    // REATIVAÇÃO de loja cujo código já está em uso por outra ativa.
    const nextCode = map.code !== undefined ? map.code : cur.code;
    const willBeActive = map.active !== undefined ? map.active === 1 : cur.active === 1;
    if (willBeActive) this.assertCodeFree(orgId, nextCode, id);
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
