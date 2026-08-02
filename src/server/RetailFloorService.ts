/**
 * Retail Floor — Atendimento de Loja / Lista da Vez (ADR-150, Fatia 1).
 *
 * Fundação do módulo: settings por org + CONTEXTO por escopo. O contexto é o
 * contrato que a UI enxuta (/loja/atendimento) consome para saber o que este
 * usuário pode ver/fazer — e é também onde o escopo por loja é RESOLVIDO no
 * backend (esconder menu não é segurança):
 *
 *  - owner/admin            → gerencia TODAS as lojas ativas da org;
 *  - manager_user_id da loja → gerencia SÓ aquela(s) loja(s) (ADR-083; sem
 *    role nova "store_manager" — decisão do ADR-150 §3);
 *  - retail_sellers.user_id → opera como VENDEDOR (entra na vez, atende).
 *
 * Regras duras (header obrigatório — ver ADR-150):
 *  - RN-150-001: orgId sempre 1º arg; toda query filtra organization_id.
 *  - RN-150-011: calibração — enquanto settings.calibration_until >= hoje, os
 *    indicadores do módulo NÃO alimentam cobrança/comissão; o contexto expõe o
 *    flag para a UI avisar.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

const QUEUE_POLICIES = ["round_robin", "fifo"];

// Taxonomia hierárquica do motivo de NÃO conversão (Fatia 4). Mora aqui (na
// fundação) pra rota/context e AttendanceService consumirem sem ciclo de
// import. Nível 2 usa a MESMA taxonomia de retail_floor_unmet_demand — o
// Pareto de perdas e o sinal de compra (Fatia 8) falam a mesma língua.
export const NOT_CONVERTED_CATEGORIES = ["product", "price", "size_fit", "service_time", "other"] as const;
export const PRODUCT_REASONS = ["no_assortment", "no_local_stock", "no_network_stock", "missing_size", "missing_color", "missing_category"] as const;

export class RetailFloorSettingsService {
  /** Lê (criando lazy com defaults) as settings do módulo para a org. */
  static get(orgId: string): any {
    let row = db.prepare(`SELECT * FROM retail_floor_settings WHERE organization_id = ?`).get(orgId) as any;
    if (!row) {
      db.prepare(`INSERT INTO retail_floor_settings (id, organization_id) VALUES (?, ?)`).run(randomUUID(), orgId);
      row = db.prepare(`SELECT * FROM retail_floor_settings WHERE organization_id = ?`).get(orgId) as any;
    }
    return this.shape(row);
  }

  /** Atualiza settings (só os campos conhecidos; valida invariantes). */
  static update(orgId: string, patch: any, actorId?: string): any {
    const current = this.get(orgId);
    const queuePolicy = patch.queuePolicy != null ? String(patch.queuePolicy) : current.queuePolicy;
    if (!QUEUE_POLICIES.includes(queuePolicy)) throw new Error("queue_policy inválida (round_robin|fifo).");
    const autoClose = patch.autoCloseMinutes != null ? Math.trunc(Number(patch.autoCloseMinutes)) : current.autoCloseMinutes;
    if (!Number.isFinite(autoClose) || autoClose < 10 || autoClose > 480) throw new Error("auto_close_minutes deve estar entre 10 e 480.");
    const anonymous = patch.anonymousDefault != null ? (patch.anonymousDefault ? 1 : 0) : (current.anonymousDefault ? 1 : 0);
    let calibrationUntil = current.calibrationUntil;
    if ("calibrationUntil" in patch) {
      const v = patch.calibrationUntil;
      if (v != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(v))) throw new Error("calibration_until deve ser YYYY-MM-DD ou null.");
      calibrationUntil = v == null ? null : String(v);
    }
    db.prepare(
      `UPDATE retail_floor_settings SET queue_policy = ?, auto_close_minutes = ?, anonymous_default = ?, calibration_until = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`
    ).run(queuePolicy, autoClose, anonymous, calibrationUntil, orgId);
    try { logAuthEvent(orgId, actorId, null, "RETAIL_FLOOR_SETTINGS_UPDATE", { queuePolicy, autoClose, anonymous, calibrationUntil }); } catch { /* noop */ }
    return this.get(orgId);
  }

  /** RN-150-011: a org está no período de calibração do piloto? */
  static inCalibration(orgId: string, today?: string): boolean {
    const s = this.get(orgId);
    if (!s.calibrationUntil) return false;
    const day = today || new Date().toISOString().slice(0, 10);
    return day <= s.calibrationUntil;
  }

  private static shape(row: any) {
    return {
      queuePolicy: row.queue_policy,
      autoCloseMinutes: Number(row.auto_close_minutes),
      anonymousDefault: Number(row.anonymous_default) === 1,
      calibrationUntil: row.calibration_until || null,
    };
  }
}

export class RetailFloorService {
  /**
   * Contexto do usuário no módulo. Resolve o ESCOPO no backend:
   * `manageableStores` (onde gerencia fila/conciliação), `sellerProfile`
   * (quando ele mesmo é vendedor mapeado) e as settings. `canConfigure` é
   * owner/admin (settings da org são globais, não por loja).
   */
  static context(orgId: string, user: { userId?: string; id?: string; role?: string }): any {
    const userId = user?.userId || user?.id || null;
    const role = user?.role || "";
    const isOrgAdmin = role === "owner" || role === "admin";

    const allStores = db.prepare(
      `SELECT id, name, code, manager_user_id FROM retail_stores WHERE organization_id = ? AND active = 1 ORDER BY name`
    ).all(orgId) as any[];

    const manageableStores = (isOrgAdmin ? allStores : allStores.filter((s) => s.manager_user_id && s.manager_user_id === userId))
      .map((s) => ({ id: s.id, name: s.name, code: s.code || null }));

    const sellerRow = userId ? db.prepare(
      `SELECT id, matricula, name FROM retail_sellers WHERE organization_id = ? AND user_id = ? AND active = 1 LIMIT 1`
    ).get(orgId, userId) as any : null;

    return {
      module: "retail_floor",
      role,
      canConfigure: isOrgAdmin,
      manageableStores,
      // O vendedor entra na fila de QUALQUER loja com turno aberto (o roster do
      // turno é o vínculo do dia — ADR-150 §"Vínculo vendedor↔loja"), por isso
      // o contexto não prende o vendedor a uma loja.
      sellerProfile: sellerRow ? { sellerId: sellerRow.id, matricula: sellerRow.matricula, name: sellerRow.name || null } : null,
      settings: RetailFloorSettingsService.get(orgId),
      inCalibration: RetailFloorSettingsService.inCalibration(orgId),
      // Taxonomia de desfecho pros dropdowns da UI (Fatia 4) — fonte única.
      taxonomy: { notConvertedCategories: NOT_CONVERTED_CATEGORIES, productReasons: PRODUCT_REASONS },
    };
  }

  /**
   * Guarda de escopo por loja para as próximas fatias (fila/turno/conciliação):
   * gestor da loja = owner/admin OU manager_user_id daquela loja. Lança erro
   * padronizado — a rota converte em 403 (RN-150-005: override é só de gestor).
   */
  static assertStoreManager(orgId: string, user: { userId?: string; id?: string; role?: string }, storeId: string): void {
    const role = user?.role || "";
    if (role === "owner" || role === "admin") return;
    const userId = user?.userId || user?.id || null;
    const row = db.prepare(
      `SELECT id FROM retail_stores WHERE organization_id = ? AND id = ? AND active = 1 AND manager_user_id = ?`
    ).get(orgId, storeId, userId || "") as any;
    if (!row) throw new Error("store_scope_denied");
  }
}

export default RetailFloorService;
