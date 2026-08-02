/**
 * Retail Floor — Turno + Lista da Vez (ADR-150, Fatia 2).
 *
 * O turno é o dia operacional de UMA loja e o seu roster É o vínculo
 * vendedor↔loja do dia (ADR-150 §"Vínculo vendedor↔loja"). A fila implementa a
 * "lista da vez" com a POSIÇÃO SEMPRE DERIVADA por query (RN-150-003): nada de
 * coluna mutável de posição — o estado gravado é só o status do vendedor +
 * timestamps server-side (RN-150-002).
 *
 * Ordenação derivada (só quem está `waiting` tem posição):
 *  - chave de retorno = COALESCE(último atendimento encerrado, joined_at) —
 *    quem acabou de atender volta pro FIM da fila naturalmente, sem UPDATE de
 *    posição de ninguém;
 *  - `round_robin` (default): menos atendimentos no turno primeiro, empate
 *    pela chave de retorno — não pune quem pegou um atendimento longo;
 *  - `fifo`: só a chave de retorno.
 *  - "próximo" (next) é o 1º da ordenação — DERIVADO, nunca gravado.
 *
 * Autorização (RN-150-005): abrir/fechar turno e mexer no status de TERCEIRO
 * (inclusive `skipped`) é de gestor da loja (owner/admin ou manager_user_id) e
 * SEMPRE audita. O vendedor só muda o próprio status (waiting|break|
 * unavailable|offline). `serving`/`closing` são do fluxo de atendimento
 * (Fatia 3) — rejeitados aqui.
 *
 * RN-150-001: orgId sempre 1º arg; toda query filtra organization_id.
 * RN-150-010: fechar turno é UPDATE; sair da fila é status `offline` — nunca
 * DELETE (o roster do dia é histórico).
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { RetailFloorService, RetailFloorSettingsService } from "./RetailFloorService.js";

// Status que a FILA aceita gravar (Fatia 2). serving/closing pertencem ao
// fluxo de atendimento (Fatia 3) e `next` nunca é gravado (é derivado).
const SELF_STATUSES = ["waiting", "break", "unavailable", "offline"];
const MANAGER_ONLY_STATUSES = ["skipped"];
const QUEUE_STATUSES = [...SELF_STATUSES, ...MANAGER_ONLY_STATUSES];

type UserRef = { userId?: string; id?: string; role?: string };

const uid = (u: UserRef) => u?.userId || u?.id || null;

export class RetailFloorShiftService {
  /** Abre o turno da loja. 1 turno aberto por loja (unique parcial no banco). */
  static open(orgId: string, storeId: string, user: UserRef): any {
    RetailFloorService.assertStoreManager(orgId, user, storeId);
    const store = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, storeId) as any;
    if (!store) throw new Error("Loja não encontrada ou inativa.");
    const id = randomUUID();
    try {
      db.prepare(`INSERT INTO retail_floor_shifts (id, organization_id, store_id, status, opened_by) VALUES (?, ?, ?, 'open', ?)`)
        .run(id, orgId, storeId, uid(user));
    } catch (e: any) {
      if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) throw new Error("shift_already_open");
      throw e;
    }
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_SHIFT_OPEN", { shiftId: id, storeId }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /** Fecha o turno (UPDATE — RN-150-010). Idempotente sobre turno já fechado é erro claro. */
  static close(orgId: string, shiftId: string, user: UserRef): any {
    const shift = db.prepare(`SELECT * FROM retail_floor_shifts WHERE organization_id = ? AND id = ?`).get(orgId, shiftId) as any;
    if (!shift) throw new Error("Turno não encontrado.");
    RetailFloorService.assertStoreManager(orgId, user, shift.store_id);
    if (shift.status !== "open") throw new Error("Turno já está fechado.");
    db.prepare(`UPDATE retail_floor_shifts SET status = 'closed', closed_at = CURRENT_TIMESTAMP, closed_by = ? WHERE organization_id = ? AND id = ?`)
      .run(uid(user), orgId, shiftId);
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_SHIFT_CLOSE", { shiftId, storeId: shift.store_id }); } catch { /* noop */ }
    return this.get(orgId, shiftId);
  }

  /** Turno aberto da loja (ou null). */
  static currentForStore(orgId: string, storeId: string): any | null {
    const row = db.prepare(`SELECT * FROM retail_floor_shifts WHERE organization_id = ? AND store_id = ? AND status = 'open'`).get(orgId, storeId) as any;
    return row ? this.shape(row) : null;
  }

  static get(orgId: string, shiftId: string): any {
    const row = db.prepare(`SELECT * FROM retail_floor_shifts WHERE organization_id = ? AND id = ?`).get(orgId, shiftId) as any;
    if (!row) throw new Error("Turno não encontrado.");
    return this.shape(row);
  }

  private static shape(row: any) {
    return {
      id: row.id, storeId: row.store_id, status: row.status,
      openedAt: row.opened_at, openedBy: row.opened_by || null,
      closedAt: row.closed_at || null, closedBy: row.closed_by || null,
    };
  }
}

export class RetailFloorQueueService {
  /**
   * Entra na lista da vez do turno ABERTO da loja. Auto-serviço (o próprio
   * vendedor) ou gestor adicionando alguém do roster. Rejoin (voltou de pausa/
   * offline) reativa a MESMA linha preservando joined_at — a justiça da
   * ordenação não zera porque alguém saiu pra almoçar.
   */
  static join(orgId: string, opts: { storeId: string; sellerId?: string | null }, user: UserRef): any {
    const shiftRow = db.prepare(`SELECT * FROM retail_floor_shifts WHERE organization_id = ? AND store_id = ? AND status = 'open'`).get(orgId, opts.storeId) as any;
    if (!shiftRow) throw new Error("Nenhum turno aberto nesta loja.");

    const self = this.sellerForUser(orgId, uid(user));
    const sellerId = opts.sellerId || self?.id;
    if (!sellerId) throw new Error("Informe o vendedor (ou vincule seu usuário em retail_sellers).");
    const seller = db.prepare(`SELECT id, name, matricula FROM retail_sellers WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, sellerId) as any;
    if (!seller) throw new Error("Vendedor não encontrado ou inativo.");

    const isSelf = !!self && self.id === sellerId;
    const byManager = !isSelf;
    if (byManager) RetailFloorService.assertStoreManager(orgId, user, opts.storeId);

    const existing = db.prepare(`SELECT * FROM retail_floor_queue_state WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`).get(orgId, shiftRow.id, sellerId) as any;
    if (existing) {
      if (existing.status !== "waiting") {
        db.prepare(`UPDATE retail_floor_queue_state SET status = 'waiting', status_changed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
      }
    } else {
      db.prepare(`INSERT INTO retail_floor_queue_state (id, organization_id, shift_id, seller_id, status) VALUES (?, ?, ?, ?, 'waiting')`)
        .run(randomUUID(), orgId, shiftRow.id, sellerId);
    }
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_QUEUE_JOIN", { shiftId: shiftRow.id, sellerId, byManager, rejoin: !!existing }); } catch { /* noop */ }
    return this.ordered(orgId, shiftRow.id);
  }

  /**
   * Muda o status de um vendedor na fila do turno aberto da loja. O próprio
   * vendedor: waiting|break|unavailable|offline. Gestor da loja: esses +
   * skipped (pulou a vez de quem não estava presente) — auditado (RN-150-005).
   */
  static setStatus(orgId: string, opts: { storeId: string; sellerId: string; status: string }, user: UserRef): any {
    const status = String(opts.status || "");
    if (!QUEUE_STATUSES.includes(status)) throw new Error(`Status inválido (${QUEUE_STATUSES.join("|")}). serving/closing são do fluxo de atendimento.`);
    const shiftRow = db.prepare(`SELECT * FROM retail_floor_shifts WHERE organization_id = ? AND store_id = ? AND status = 'open'`).get(orgId, opts.storeId) as any;
    if (!shiftRow) throw new Error("Nenhum turno aberto nesta loja.");
    const row = db.prepare(`SELECT * FROM retail_floor_queue_state WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`).get(orgId, shiftRow.id, opts.sellerId) as any;
    if (!row) throw new Error("Vendedor não está na lista deste turno.");

    const self = this.sellerForUser(orgId, uid(user));
    const isSelf = !!self && self.id === opts.sellerId;
    const managerAction = !isSelf || !SELF_STATUSES.includes(status);
    if (managerAction) RetailFloorService.assertStoreManager(orgId, user, opts.storeId);

    db.prepare(`UPDATE retail_floor_queue_state SET status = ?, status_changed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, row.id);
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_QUEUE_STATUS", { shiftId: shiftRow.id, sellerId: opts.sellerId, from: row.status, to: status, byManager: managerAction }); } catch { /* noop */ }
    return this.ordered(orgId, shiftRow.id);
  }

  /**
   * Lista da vez com posição DERIVADA (RN-150-003). Só `waiting` tem posição;
   * o 1º é o "próximo" (next=true). Os demais status aparecem sem posição (o
   * Kanban da Fatia 7 mostra as colunas). served/lastEndedAt vêm dos
   * atendimentos do turno (Fatia 3) — sem atendimentos, reduz a joined_at.
   */
  static ordered(orgId: string, shiftId: string): any {
    const policy = RetailFloorSettingsService.get(orgId).queuePolicy;
    const rows = db.prepare(
      `SELECT q.id, q.seller_id, q.status, q.joined_at, q.status_changed_at,
              s.name AS seller_name, s.matricula,
              (SELECT COUNT(*) FROM retail_floor_attendances a
                WHERE a.organization_id = q.organization_id AND a.shift_id = q.shift_id AND a.seller_id = q.seller_id) AS served,
              (SELECT MAX(a.ended_at) FROM retail_floor_attendances a
                WHERE a.organization_id = q.organization_id AND a.shift_id = q.shift_id AND a.seller_id = q.seller_id AND a.ended_at IS NOT NULL) AS last_ended_at
         FROM retail_floor_queue_state q
         JOIN retail_sellers s ON s.organization_id = q.organization_id AND s.id = q.seller_id
        WHERE q.organization_id = ? AND q.shift_id = ?`
    ).all(orgId, shiftId) as any[];

    // Chave de retorno: quem acabou de atender volta pro fim sem mexer em ninguém.
    const returnKey = (r: any) => String(r.last_ended_at || r.joined_at || "");
    const waiting = rows.filter((r) => r.status === "waiting").sort((a, b) => {
      if (policy === "round_robin" && a.served !== b.served) return a.served - b.served;
      const k = returnKey(a).localeCompare(returnKey(b));
      return k !== 0 ? k : String(a.id).localeCompare(String(b.id));
    });
    const positions = new Map(waiting.map((r, i) => [r.id, i + 1]));

    return {
      shiftId, policy,
      queue: rows
        .map((r) => ({
          sellerId: r.seller_id,
          sellerName: r.seller_name || null,
          matricula: r.matricula,
          status: r.status,
          position: positions.get(r.id) || null,
          next: positions.get(r.id) === 1,
          joinedAt: r.joined_at,
          statusChangedAt: r.status_changed_at,
          served: Number(r.served || 0),
          lastEndedAt: r.last_ended_at || null,
        }))
        .sort((a, b) => (a.position ?? 999) - (b.position ?? 999) || String(a.sellerId).localeCompare(String(b.sellerId))),
    };
  }

  /** Vendedor mapeado ao usuário logado (null quando não é vendedor). */
  static sellerForUser(orgId: string, userId: string | null): { id: string } | null {
    if (!userId) return null;
    return db.prepare(`SELECT id FROM retail_sellers WHERE organization_id = ? AND user_id = ? AND active = 1 LIMIT 1`).get(orgId, userId) as any || null;
  }
}

export default RetailFloorShiftService;
