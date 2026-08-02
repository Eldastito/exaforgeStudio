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
 * (RN-150-003). Furar a fila (cliente pediu vendedor específico, correria) é
 * OVERRIDE de gestor — e a ordem é DURA (RN-150-012): exige `allowSkip`
 * explícito, não basta a conta ser gestora (o quiosque loga como gestor).
 * Auditado (RN-150-005). Encerrar atendimento de terceiro idem.
 *
 * Conversão em 2 tempos (RN-150-004): outcome=converted grava
 * reconciliation_state='pending' + valor/peças DECLARADOS (insumo do matching
 * da Fatia 6). Declarado NUNCA vira venda confirmada aqui.
 *
 * Auto-encerramento (RN-150-010): atendimento esquecido além de
 * settings.auto_close_minutes é FECHADO com outcome='unknown' (UPDATE, nunca
 * DELETE) pelo passe rápido do Scheduler; o vendedor volta pra fila.
 *
 * Taxonomia hierárquica (Fatia 4): not_converted EXIGE motivo estruturado —
 * nível 1 (categoria) e, quando a categoria é `product`, nível 2 com a MESMA
 * taxonomia da demanda não atendida (é o que vira sinal de compra/transferência
 * na Fatia 8, sem tradução no meio). converted/walkout não levam motivo — o
 * dado de "por que perdeu" só existe onde faz sentido, senão o Pareto mente.
 * O vínculo com unmet_demand continua nascendo do SCAN (RN-150-009, Fatia 5) —
 * aqui é só o desfecho declarado.
 *
 * Política de retorno (Fatia 4): ao encerrar, o vendedor volta pra fila
 * (`waiting`, default) ou vai direto pra pausa (`break` — foi almoçar). A
 * ordenação derivada da Fatia 2 cuida do resto.
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { logAuthEvent } from "./auditLog.js";
import { RetailFloorService, RetailFloorSettingsService, NOT_CONVERTED_CATEGORIES, PRODUCT_REASONS } from "./RetailFloorService.js";
import { RetailFloorQueueService } from "./RetailFloorShiftService.js";

const OUTCOMES = ["converted", "not_converted", "walkout"];
const RETURN_TO = ["waiting", "break"];

type UserRef = { userId?: string; id?: string; role?: string };
const uid = (u: UserRef) => u?.userId || u?.id || null;

export class RetailFloorAttendanceService {
  /**
   * Inicia atendimento pro vendedor `waiting` do turno aberto da loja.
   *
   * RN-150-012 (ordem dura da fila): SÓ o próximo derivado entra em
   * atendimento livremente. Iniciar QUALQUER outro (furar a fila) exige
   * liberação EXPLÍCITA do gestor via `allowSkip` — a conta gestora sozinha
   * NÃO basta, porque no quiosque (Fatia 12) o tablet loga sempre como gestor.
   * A liberação do gestor no quiosque é o PIN, que a UI traduz em `allowSkip`.
   * Sem o flag, o start fora da vez é rejeitado mesmo para conta gestora — foi
   * o vazamento que deixava o vendedor pular o da vez selecionando o 2º da fila.
   *
   * Atômico: 1 atendimento ativo por vendedor. Pode haver N atendimentos
   * simultâneos na loja (cada start avança a fila; o próximo derivado muda).
   */
  static start(orgId: string, opts: { storeId: string; sellerId?: string | null; allowSkip?: boolean }, user: UserRef): any {
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
    if (!isNext) {
      // Furar a fila (RN-150-012): exige liberação explícita do gestor. Sem o
      // flag, rejeita — inclusive pra gestor (o quiosque é sempre gestor). O
      // vendedor tentando a própria vez fora de hora vê `not_your_turn`.
      if (!opts.allowSkip) throw new Error(isSelf ? "not_your_turn" : "not_next");
      RetailFloorService.assertStoreManager(orgId, user, opts.storeId);
      override = true;
    } else if (!isSelf) {
      // É o próximo, mas quem dispara é o gestor iniciando por ele — ok, não é
      // furar a fila (a ordem é respeitada), só não é self-service.
      RetailFloorService.assertStoreManager(orgId, user, opts.storeId);
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
   * pendente (RN-150-004) com valor/peças declarados; `not_converted` EXIGE o
   * motivo hierárquico (Fatia 4). O vendedor volta pra fila (`waiting`,
   * default) ou vai pra pausa (`returnTo='break'`).
   */
  static finish(orgId: string, attendanceId: string, opts: { outcome: string; reason?: any; returnTo?: string | null; declaredValue?: number | null; declaredPieces?: number | null; notes?: string | null }, user: UserRef): any {
    const att = db.prepare(`SELECT * FROM retail_floor_attendances WHERE organization_id = ? AND id = ?`).get(orgId, attendanceId) as any;
    if (!att) throw new Error("Atendimento não encontrado.");
    if (att.ended_at) throw new Error("Atendimento já encerrado.");
    const outcome = String(opts.outcome || "");
    if (!OUTCOMES.includes(outcome)) throw new Error(`Desfecho inválido (${OUTCOMES.join("|")}).`);
    const reason = this.validateReason(outcome, opts.reason);
    const returnTo = opts.returnTo == null ? "waiting" : String(opts.returnTo);
    if (!RETURN_TO.includes(returnTo)) throw new Error("returnTo inválido (waiting|break).");

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
        `UPDATE retail_floor_attendances SET ended_at = CURRENT_TIMESTAMP, outcome = ?, outcome_reason_json = ?, reconciliation_state = ?, declared_value = ?, declared_pieces = ?, notes = ? WHERE organization_id = ? AND id = ?`
      ).run(outcome, reason ? JSON.stringify(reason) : null, converted ? "pending" : null, declaredValue, declaredPieces, opts.notes || null, orgId, attendanceId);
      db.prepare(
        `UPDATE retail_floor_queue_state SET status = ?, status_changed_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND shift_id = ? AND seller_id = ? AND status = 'serving'`
      ).run(returnTo, orgId, att.shift_id, att.seller_id);
    });
    tx();
    try { logAuthEvent(orgId, uid(user), null, "RETAIL_FLOOR_ATTENDANCE_FINISH", { attendanceId, shiftId: att.shift_id, storeId: att.store_id, sellerId: att.seller_id, outcome, reasonCategory: reason?.category || null, returnTo, byManager: !isSelf }); } catch { /* noop */ }
    return this.get(orgId, attendanceId);
  }

  /**
   * Valida o motivo hierárquico do desfecho (Fatia 4):
   *  - not_converted: EXIGE { category }; quando category='product', EXIGE
   *    productDetail.reason da taxonomia da demanda não atendida (+ campos
   *    livres opcionais: size/color/categoryLabel do que faltou);
   *  - converted/walkout: motivo é REJEITADO (não faz sentido e sujaria o
   *    Pareto de perdas).
   * Retorna o objeto canônico a persistir (ou null).
   */
  private static validateReason(outcome: string, raw: any): any | null {
    if (outcome !== "not_converted") {
      if (raw != null) throw new Error("Motivo só se aplica a desfecho not_converted.");
      return null;
    }
    const category = String(raw?.category || "");
    if (!(NOT_CONVERTED_CATEGORIES as readonly string[]).includes(category)) {
      throw new Error(`Motivo obrigatório: category (${NOT_CONVERTED_CATEGORIES.join("|")}).`);
    }
    if (category !== "product") {
      if (raw?.productDetail != null) throw new Error("productDetail só se aplica à categoria product.");
      return { category, note: raw?.note ? String(raw.note).slice(0, 500) : undefined };
    }
    const productReason = String(raw?.productDetail?.reason || "");
    if (!(PRODUCT_REASONS as readonly string[]).includes(productReason)) {
      throw new Error(`Categoria product exige productDetail.reason (${PRODUCT_REASONS.join("|")}).`);
    }
    const d = raw.productDetail;
    return {
      category,
      note: raw?.note ? String(raw.note).slice(0, 500) : undefined,
      productDetail: {
        reason: productReason,
        size: d.size ? String(d.size).slice(0, 40) : undefined,
        color: d.color ? String(d.color).slice(0, 40) : undefined,
        categoryLabel: d.categoryLabel ? String(d.categoryLabel).slice(0, 80) : undefined,
      },
    };
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
      outcome: row.outcome || null,
      outcomeReason: row.outcome_reason_json ? safeParse(row.outcome_reason_json) : null,
      reconciliationState: row.reconciliation_state || null,
      declaredValue: row.declared_value != null ? Number(row.declared_value) : null,
      declaredPieces: row.declared_pieces != null ? Number(row.declared_pieces) : null,
      notes: row.notes || null,
    };
  }
}

function safeParse(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export default RetailFloorAttendanceService;
