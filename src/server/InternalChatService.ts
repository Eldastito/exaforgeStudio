/**
 * InternalChatService — PRD 1 Fase 7 (§80): chat interno, FUNDAÇÃO-SÓ.
 *
 * Decisão de escopo (§80 + análise P8): NÃO virar clone de Slack. Sem canais,
 * presença, reações, DMs-como-produto. O valor é OPERAR o ZapFlow, não
 * funcionários conversando. Então a fundação é a mínima que agrega valor real:
 * NOTAS de equipe ancoradas a um CASO (`correlation_id`, a espinha ADR-158) —
 * "deixa um recado pro colega SOBRE esta decisão/aprovação".
 *
 * Superfícies: postar, minha caixa (notas endereçadas a mim), notas de um caso
 * (que a thread da Fase 6 costura como estágio 'nota'). Isolamento multi-tenant
 * sempre; visibilidade: autor, destinatário, ou nota-do-caso (to NULL).
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";

export class InternalChatService {
  /** Posta uma nota. `toUserId` NULL = nota do caso (broadcast p/ quem vê o caso). */
  static post(orgId: string, fromUserId: string, input: { toUserId?: string | null; correlationId?: string | null; body: string }): any {
    const body = String(input?.body || "").trim();
    if (!fromUserId) throw new Error("Nota exige um usuário identificado.");
    if (!body) throw new Error("Nota vazia.");
    if (body.length > 4000) throw new Error("Nota muito longa (máx 4000).");
    const id = randomUUID();
    db.prepare(`INSERT INTO internal_messages (id, organization_id, from_user_id, to_user_id, correlation_id, body) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, fromUserId, input.toUserId || null, input.correlationId || null, body);
    logAuthEvent(orgId, fromUserId, id, "INTERNAL_NOTE_POST", { to: input.toUserId || null, correlationId: input.correlationId || null });
    return this.get(orgId, id);
  }

  static get(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM internal_messages WHERE id = ? AND organization_id = ?`).get(id, orgId) || null;
  }

  /** Minha caixa: notas endereçadas a mim (mais recentes primeiro). */
  static inbox(orgId: string, userId: string, opts: { limit?: number; unreadOnly?: boolean } = {}): { total: number; unread: number; items: any[] } {
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const rows = db.prepare(
      `SELECT * FROM internal_messages WHERE organization_id = ? AND to_user_id = ? ${opts.unreadOnly ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT ?`
    ).all(orgId, userId, limit) as any[];
    const unread = (db.prepare(`SELECT COUNT(*) n FROM internal_messages WHERE organization_id = ? AND to_user_id = ? AND read_at IS NULL`).get(orgId, userId) as any).n;
    return { total: rows.length, unread, items: rows };
  }

  /** Marca como lida — só o destinatário (idempotente). */
  static markRead(orgId: string, userId: string, id: string): { read: boolean } {
    const r = db.prepare(`UPDATE internal_messages SET read_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ? AND to_user_id = ? AND read_at IS NULL`).run(id, orgId, userId);
    return { read: r.changes > 0 };
  }

  /**
   * Notas de um caso que o usuário pode ver: autor, destinatário, ou nota-do-caso
   * (to NULL). Usado pela thread (Fase 6) — o restante do caso já é gated por
   * domínio; a nota respeita o endereçamento pessoal.
   */
  static forThread(orgId: string, userId: string, correlationId: string): any[] {
    if (!correlationId) return [];
    return db.prepare(
      `SELECT * FROM internal_messages WHERE organization_id = ? AND correlation_id = ? AND (from_user_id = ? OR to_user_id = ? OR to_user_id IS NULL) ORDER BY created_at ASC`
    ).all(orgId, correlationId, userId, userId) as any[];
  }
}
