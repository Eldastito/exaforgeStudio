/**
 * Escopo de LOJA por usuário (PRD Moda/TOULON, CRM-002 / AC-04 / AC-18; ADR-173).
 *
 * Fecha a trava: um usuário atribuído à Loja A não enxerga a Loja B. É imposta
 * NO SERVIDOR (RN nº 4/10 do PRD) — não basta esconder na tela.
 *
 * Regra de resolução (`allowed`):
 *   - owner/admin (ou master) → SEM restrição (vê todas as lojas da org);
 *   - usuário SEM atribuição → SEM restrição (opt-in, retrocompatível — ninguém
 *     perde acesso num deploy; a trava só passa a valer quando o admin atribui);
 *   - usuário COM atribuição → restrito ao conjunto atribuído.
 *
 * Isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

const BYPASS_ROLES = new Set(["owner", "admin"]);

export type StoreScope = {
  unrestricted: boolean;   // true = vê tudo (owner/admin ou sem atribuição)
  storeIds: string[];      // lojas permitidas quando restrito
  storeCodes: string[];    // códigos (filial) correspondentes, p/ filtros por código
};

export class RetailStoreScopeService {
  /** IDs de loja atribuídos a um usuário (vazio = sem atribuição). */
  static forUser(orgId: string, userId: string): string[] {
    return (db.prepare(`SELECT store_id FROM user_stores WHERE organization_id = ? AND user_id = ?`).all(orgId, userId) as any[]).map(r => r.store_id);
  }

  /**
   * O usuário está EXPLICITAMENTE lotado nesta loja? (ADR-180/ADR-083 F-J — o
   * "gerente da loja"). Diferente de `canAccessStore`: aqui a ausência de
   * atribuição NÃO libera — é a base de quem PODE fechar/depositar o malote da
   * loja (owner/admin decidido à parte na rota). Isolado por org.
   */
  static isAssignedTo(orgId: string, userId: string, storeId: string): boolean {
    if (!orgId || !userId || !storeId) return false;
    return !!db.prepare(`SELECT 1 FROM user_stores WHERE organization_id = ? AND user_id = ? AND store_id = ? LIMIT 1`).get(orgId, userId, storeId);
  }

  /** Tem QUALQUER lotação de loja? (gerente de alguma loja — p/ ações sem loja fixa). */
  static hasAnyAssignment(orgId: string, userId: string): boolean {
    if (!orgId || !userId) return false;
    return !!db.prepare(`SELECT 1 FROM user_stores WHERE organization_id = ? AND user_id = ? LIMIT 1`).get(orgId, userId);
  }

  /** Resolve o escopo efetivo do usuário (papel + atribuições). */
  static allowed(orgId: string, userId: string, role?: string): StoreScope {
    if (role && BYPASS_ROLES.has(role)) return { unrestricted: true, storeIds: [], storeCodes: [] };
    const ids = this.forUser(orgId, userId);
    if (!ids.length) return { unrestricted: true, storeIds: [], storeCodes: [] };
    const codes = (db.prepare(`SELECT code FROM retail_stores WHERE organization_id = ? AND id IN (${ids.map(() => "?").join(",")}) AND code IS NOT NULL AND TRIM(code) <> ''`).all(orgId, ...ids) as any[]).map(r => String(r.code));
    return { unrestricted: false, storeIds: ids, storeCodes: codes };
  }

  /** Pode acessar ESTA loja (por id)? owner/admin e sem-atribuição → sempre. */
  static canAccessStore(orgId: string, userId: string, role: string | undefined, storeId: string): boolean {
    const s = this.allowed(orgId, userId, role);
    return s.unrestricted || s.storeIds.includes(storeId);
  }

  /** Pode acessar a loja por CÓDIGO (filial)? */
  static canAccessCode(orgId: string, userId: string, role: string | undefined, code: string): boolean {
    const s = this.allowed(orgId, userId, role);
    return s.unrestricted || s.storeCodes.includes(String(code));
  }

  /** Filtra uma lista de lojas (com `id`) ao escopo do usuário. */
  static filterStores(orgId: string, userId: string, role: string | undefined, stores: any[]): any[] {
    const s = this.allowed(orgId, userId, role);
    if (s.unrestricted) return stores;
    const set = new Set(s.storeIds);
    return stores.filter(st => set.has(st.id));
  }

  // ── Administração das atribuições (owner/admin) ──────────────────────────

  /** Substitui o conjunto de lojas de um usuário (lista completa). */
  static setForUser(orgId: string, userId: string, storeIds: string[], actorId?: string): string[] {
    const valid = (db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ?`).all(orgId) as any[]).map(r => r.id);
    const validSet = new Set(valid);
    const wanted = Array.from(new Set((storeIds || []).map(String))).filter(id => validSet.has(id));
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM user_stores WHERE organization_id = ? AND user_id = ?`).run(orgId, userId);
      const ins = db.prepare(`INSERT OR IGNORE INTO user_stores (id, organization_id, user_id, store_id, created_by) VALUES (?, ?, ?, ?, ?)`);
      for (const sid of wanted) ins.run(randomUUID(), orgId, userId, sid, actorId || null);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", userId, "USER_STORE_SCOPE_SET", { stores: wanted.length }); } catch { /* noop */ }
    return this.forUser(orgId, userId);
  }
}
