/**
 * Retail Floor — Atendimento (ADR-150, Fatia 3).
 *
 * start/finish do atendimento com CRONÔMETRO SERVER-SIDE (RN-150-002):
 * started_at/ended_at são gravados pelo servidor; o tempo exibido é derivado —
 * nada vem do cliente (senão vendedor "pausa" a aba e zera o relógio).
 *
 * Concorrência (padrão AC-012 da Fatia 41/ADR-145): transação atômica com
 * SELECT COUNT do atendimento ativo DENTRO da tx antes do INSERT; o unique
 * parcial idx_retail_floor_attendance_active (Fatia 1) é a última linha de
 * defesa se dois processos disputarem.
 *
 * Vez de quem: o vendedor SÓ inicia quando é o "próximo" derivado da lista
 * (RN-150-003). Fora da vez (cliente pediu vendedor específico, correria) é
 * OVERRIDE de gestor da loja — auditado (RN-150-005). Encerrar atendimento de
 * terceiro idem.
 *
 * Conversão em 2 tempos (RN-150-004): outcome=converted grava
 * reconciliation_state='pending' + valor/peças DECLARADOS (insumo do matching
 * da Fatia 6). Declarado NUNCA vira venda confirmada aqui.
 *
 * Auto-encerramento (RN-150-010): atendimento esquecido além de
 * settings.auto_close_minutes é FECHADO com outcome='unknown' (UPDATE, nunca
 * DELETE) pelo passe rápido do Scheduler; o vendedor volta pra fila.
 * A taxonomia hierárquica do motivo de não conversão entra na Fatia 4.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { RetailFloorService, RetailFloorSettingsService } from "./RetailFloorService.js";
import { RetailFloorQueueService } from "./RetailFloorShiftService.js";

const OUTCOMES = ["converted", "not_converted", "walkout"];

type UserRef = { userId?: string; id?: string; role?: string };
const uid = (u: UserRef) => u?.userId || u?.id || null;

export class RetailFloorAttendanceService {
  /**
   * Inicia atendimento pro vendedor `waiting` do turno aberto da loja.
   * Self-service só quando ele é o próximo derivado; caso contrário é override
   * de gestor (auditado). Atômico: 1 atendimento ativo por vendedor.
   */
  static start(orgId: string, opts: { storeId: string; sellerId?: string | null }, user: UserRef): any {
    const shift = db.prepare(`SELECT * FROM retail_floor_shifts WHERE organization_id = ? AND store_id = ? AND status = 'open'`).get(orgId, opts.storeId) as any;
    if (!shift) throw new Error("Nenhum turno aberto nesta loja.");

    const self = RetailFloorQueueService.sellerForUser(orgId, uid(user));
    const sellerId = opts.sellerId || self?.id;
    if (!sellerId) throw new Error("Informe o vendedor (ou vincule seu usuário em retail_sellers).");
    const isSelf = !!self && self.id === sellerId;

    const queueRow = db.prepare(`SELECT * FROM retail_floor_queue_state WHERE organization_id = ? AND shift_id = ? AND seller_id = ?`).get(orgId, shift.id, sellerId) as any;
    if (!queueRow) throw new Error("Vendedor não está na lista deste turno.");
    if (queueRow.status !== "waiting") throw new Error(`Vendedor não está aguardando (status: ${queueRow.status}).`);

    const ordered = RetailFloorQueueService.ordered(orgId, shift.id);
    const isNext = ordered.queue.find((r: any) => r.next)?.sellerId === sellerId;
    let override = false;
    if (!isSelf || !isNext) {
      try { RetailFloorService.assertStoreManager(orgId, user, opts.storeId); }
      catch (e) { throw isSelf && !isNext ? new Error("not_your_turn") : e; }
      override = !isNext;
    }

    const id = randomUUID();
    const tx = db.transaction(() => {
      const active = db.prepare(`SELECT COUNT(*) AS n FROM retail_floor_attendances WHERE organization_id = ? AND seller_id = ? AND ended_at IS NULL`).get(orgId, sellerId) as any;
      if (Number(active.n) > 0) throw new Error("attendance_already_active");
      db.prepare(`INSERT INTO retail_floor_attendances (id, organization_id, store_id, shift_id, seller_id, created_by) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, orgId, opts.storeId, shift.id, sellerId, uid(user));
      db.prepare(`UPDATE retail_floor_queue_state SET status = 'serving', status_changed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(queueRow.id);
    });
    try { tx(); } catch (e: any) {
      if (String(e?.code || "").startsWith("SQLITE_CONSTRAINT")) throw new Error("attendance_already_active");
      throw e;
    }
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_ATTENDANCE_START", { attendanceId: id, shiftId: shift.id, sellerId, override, bySelf: isSelf }); } catch { /* noop */ }
    return this.get(orgId, id);
  }

  /**
   * Encerra o atendimento com desfecho. `converted` entra em conciliação
   * pendente (RN-150-004) com valor/peças declarados; o vendedor volta pra
   * fila (`waiting` — a chave de retorno da ordenação o manda pro fim).
   */
  static finish(orgId: string, attendanceId: string, opts: { outcome: string; declaredValue?: number | null; declaredPieces?: number | null; notes?: string | null }, user: UserRef): any {
    const att = db.prepare(`SELECT * FROM retail_floor_attendances WHERE organization_id = ? AND id = ?`).get(orgId, attendanceId) as any;
    if (!att) throw new Error("Atendimento não encontrado.");
    if (att.ended_at) throw new Error("Atendimento já encerrado.");
    const outcome = String(opts.outcome || "");
    if (!OUTCOMES.includes(outcome)) throw new Error(`Desfecho inválido (${OUTCOMES.join("|")}).`);

    const self = RetailFloorQueueService.sellerForUser(orgId, uid(user));
    const isSelf = !!self && self.id === att.seller_id;
    if (!isSelf) RetailFloorService.assertStoreManager(orgId, user, att.store_id);

    const converted = outcome === "converted";
    const declaredValue = converted && opts.declaredValue != null ? Number(opts.declaredValue) : null;
    const declaredPieces = converted && opts.declaredPieces != null ? Math.trunc(Number(opts.declaredPieces)) : null;
    if (declaredValue != null && !(declaredValue >= 0)) throw new Error("Valor declarado inválido.");
    if (declaredPieces != null && !(declaredPieces >= 0)) throw new Error("Peças declaradas inválidas.");

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE retail_floor_attendances SET ended_at = CURRENT_TIMESTAMP, outcome = ?, reconciliation_state = ?, declared_value = ?, declared_pieces = ?, notes = ? WHERE organization_id = ? AND id = ?`
      ).run(outcome, converted ? "pending" : null, declaredValue, declaredPieces, opts.notes || null, orgId, attendanceId);
      db.prepare(
        `UPDATE retail_floor_queue_state SET status = 'waiting', status_changed_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND shift_id = ? AND seller_id = ? AND status = 'serving'`
      ).run(orgId, att.shift_id, att.seller_id);
    });
    tx();
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_ATTENDANCE_FINISH", { attendanceId, sellerId: att.seller_id, outcome, byManager: !isSelf }); } catch { /* noop */ }
    return this.get(orgId, attendanceId);
  }

  /** Atendimentos ATIVOS da loja com tempo decorrido derivado (base do Kanban). */
  static active(orgId: string, storeId: string): any[] {
    const rows = db.prepare(
      `SELECT a.*, s.name AS seller_name, s.matricula,
              (strftime('%s','now') - strftime('%s', a.started_at)) AS elapsed_seconds
         FROM retail_floor_attendances a
         JOIN retail_sellers s ON s.organization_id = a.organization_id AND s.id = a.seller_id
        WHERE a.organization_id = ? AND a.store_id = ? AND a.ended_at IS NULL
        ORDER BY a.started_at`
    ).all(orgId, storeId) as any[];
    return rows.map((r) => ({ ...this.shapeRow(r), sellerName: r.seller_name || null, matricula: r.matricula, elapsedSeconds: Number(r.elapsed_seconds || 0) }));
  }

  /**
   * Auto-encerramento (passe rápido do Scheduler): atendimento ativo há mais
   * de settings.auto_close_minutes fecha com outcome='unknown' e devolve o
   * vendedor pra fila. Retorna quantos fechou (0 = nada a fazer).
   */
  static autoCloseStale(orgId: string): number {
    const minutes = RetailFloorSettingsService.get(orgId).autoCloseMinutes;
    const stale = db.prepare(
      `SELECT * FROM retail_floor_attendances
        WHERE organization_id = ? AND ended_at IS NULL
          AND started_at <= datetime('now', '-' || ? || ' minutes')`
    ).all(orgId, minutes) as any[];
    for (const att of stale) {
      const tx = db.transaction(() => {
        db.prepare(`UPDATE retail_floor_attendances SET ended_at = CURRENT_TIMESTAMP, outcome = 'unknown' WHERE organization_id = ? AND id = ?`).run(orgId, att.id);
        db.prepare(`UPDATE retail_floor_queue_state SET status = 'waiting', status_changed_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND shift_id = ? AND seller_id = ? AND status = 'serving'`)
          .run(orgId, att.shift_id, att.seller_id);
      });
      tx();
      try { logAuthEvent(orgId, "system", null, "RETAIL_FLOOR_ATTENDANCE_AUTOCLOSE", { attendanceId: att.id, sellerId: att.seller_id, minutes }); } catch { /* noop */ }
    }
    return stale.length;
  }

  static get(orgId: string, attendanceId: string): any {
    const row = db.prepare(`SELECT * FROM retail_floor_attendances WHERE organization_id = ? AND id = ?`).get(orgId, attendanceId) as any;
    if (!row) throw new Error("Atendimento não encontrado.");
    return this.shapeRow(row);
  }

  private static shapeRow(row: any) {
    return {
      id: row.id, storeId: row.store_id, shiftId: row.shift_id, sellerId: row.seller_id,
      startedAt: row.started_at, endedAt: row.ended_at || null,
      outcome: row.outcome || null, reconciliationState: row.reconciliation_state || null,
      declaredValue: row.declared_value != null ? Number(row.declared_value) : null,
      declaredPieces: row.declared_pieces != null ? Number(row.declared_pieces) : null,
      notes: row.notes || null,
    };
  }
}

export default RetailFloorAttendanceService;
