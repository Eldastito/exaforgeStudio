/**
 * Contexto DURÁVEL de lista numerada (PRD WhatsApp Unificado — RF-06 / CA-06, F3.4).
 *
 * Quando um serviço MOSTRA uma lista numerada por WhatsApp ("1. …, 2. …"), a
 * ordem exata dos ids é guardada aqui. Uma resposta por índice ("aprovar 2",
 * "concluir 2") resolve contra ESTA lista — a mesma que o usuário viu — em vez
 * de uma lista RECOMPUTADA no momento, que após um restart do servidor poderia
 * estar reordenada e mapear "2" para a AÇÃO ERRADA (o risco exato do CA-06:
 * "reinício do servidor … não produz confirmação da ação errada").
 *
 * Substitui os Maps in-memory `GestorCommandService.lastActions` e
 * `CoordenadorService.lastList` (perdidos no restart). TTL evita que um "2"
 * resolva uma lista velha. Isolado por (org, usuário, escopo).
 */
import db from "./db.js";

const DEFAULT_TTL_MIN = 30;

export type NumberedListScope = "gestor_approvals" | "coordenador_tasks";

export class NumberedListContextService {
  /** Guarda a ordem exata mostrada ao usuário (upsert por org+usuário+escopo). */
  static remember(orgId: string, userId: string, scope: NumberedListScope, ids: string[], opts: { ttlMin?: number; now?: Date } = {}): void {
    if (!orgId || !userId) return;
    const now = opts.now || new Date();
    const expires = new Date(now.getTime() + (opts.ttlMin ?? DEFAULT_TTL_MIN) * 60_000).toISOString();
    try {
      db.prepare(
        `INSERT INTO numbered_list_contexts (organization_id, user_id, scope, item_ids_json, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(organization_id, user_id, scope)
         DO UPDATE SET item_ids_json = excluded.item_ids_json, created_at = CURRENT_TIMESTAMP, expires_at = excluded.expires_at`,
      ).run(orgId, userId, scope, JSON.stringify(ids || []), expires);
    } catch (e) { console.error("[NumberedListContext] remember falhou (best-effort)", e); }
  }

  /** Ids da última lista mostrada (não expirada), ou null se não há/expirou. */
  static resolvedIds(orgId: string, userId: string, scope: NumberedListScope, now: Date = new Date()): string[] | null {
    if (!orgId || !userId) return null;
    try {
      const r = db.prepare(
        `SELECT item_ids_json, expires_at FROM numbered_list_contexts WHERE organization_id = ? AND user_id = ? AND scope = ?`,
      ).get(orgId, userId, scope) as any;
      if (!r) return null;
      if (new Date(r.expires_at).getTime() < now.getTime()) { this.clear(orgId, userId, scope); return null; }
      const ids = JSON.parse(r.item_ids_json);
      return Array.isArray(ids) ? ids : null;
    } catch { return null; }
  }

  /** Resolve o índice 1-based contra a lista mostrada. null se fora da lista. */
  static resolveIndex(orgId: string, userId: string, scope: NumberedListScope, index: number, now: Date = new Date()): string | null {
    const ids = this.resolvedIds(orgId, userId, scope, now);
    if (!ids || !Number.isInteger(index) || index < 1 || index > ids.length) return null;
    return ids[index - 1] ?? null;
  }

  static clear(orgId: string, userId: string, scope: NumberedListScope): void {
    try { db.prepare(`DELETE FROM numbered_list_contexts WHERE organization_id = ? AND user_id = ? AND scope = ?`).run(orgId, userId, scope); } catch { /* noop */ }
  }
}

export default NumberedListContextService;
