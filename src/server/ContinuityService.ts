import db from "./db.js";
import { randomUUID } from "node:crypto";

/**
 * ZappFlow Continuity Layer — Cloud (ADR-082, Fase 1).
 *
 * Duas peças da fundação de resiliência:
 *  1) EVENT LOG por organização (`domain_events`) com `seq` monotônico — a
 *     fonte do DELTA SYNC. Na reconexão, o cliente pede "eventos após meu
 *     último seq" e reconcilia, em vez de depender do Socket.IO (que passa a
 *     ser só notificador) ou de um refresh manual.
 *  2) IDEMPOTÊNCIA de comandos (`client_commands`): o outbox do navegador
 *     reenvia com o mesmo `commandId`; o servidor processa UMA vez e devolve o
 *     resultado guardado — sem duplicar mensagem/pedido/reserva.
 *
 * Gravar eventos é opt-in por env (CONTINUITY_EVENTS_ENABLED) para rollout
 * seguro (ADR-082 D10). Leitura (delta/cursor) e idempotência sempre ativas.
 */
export function eventsEnabled(): boolean {
  const v = String(process.env.CONTINUITY_EVENTS_ENABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

export class ContinuityService {
  /**
   * Anexa um evento de domínio com o próximo `seq` da organização (atômico —
   * better-sqlite3 é síncrono/single-thread; a transação garante o incremento
   * sem corrida). No-op quando a flag está desligada. Best-effort: nunca
   * derruba o caller.
   */
  static append(orgId: string, e: { aggregateType: string; aggregateId?: string | null; eventType: string; payload?: any }): { seq: number } | null {
    if (!eventsEnabled() || !orgId) return null;
    try {
      const tx = db.transaction(() => {
        const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM domain_events WHERE organization_id = ?").get(orgId) as any;
        const seq = Number(row?.m || 0) + 1;
        db.prepare(`INSERT INTO domain_events (id, organization_id, seq, aggregate_type, aggregate_id, event_type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(randomUUID(), orgId, seq, e.aggregateType, e.aggregateId || null, e.eventType, JSON.stringify(e.payload || {}));
        return seq;
      });
      return { seq: tx() };
    } catch (err) {
      console.error("[Continuity] Falha ao anexar evento", e.eventType, err);
      return null;
    }
  }

  /** Cursor atual (maior seq) da organização — o cliente guarda isso ao sincronizar. */
  static cursor(orgId: string): number {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM domain_events WHERE organization_id = ?").get(orgId) as any;
    return Number(row?.m || 0);
  }

  /** DELTA SYNC: eventos com seq > afterSeq (ordenados), até `limit`. */
  static since(orgId: string, afterSeq: number, limit = 200): { events: any[]; cursor: number; hasMore: boolean } {
    const after = Math.max(0, parseInt(String(afterSeq), 10) || 0);
    const lim = Math.min(1000, Math.max(1, parseInt(String(limit), 10) || 200));
    const rows = db.prepare(`SELECT seq, aggregate_type, aggregate_id, event_type, payload_json, created_at FROM domain_events WHERE organization_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(orgId, after, lim + 1) as any[];
    const hasMore = rows.length > lim;
    const events = rows.slice(0, lim).map(r => ({
      seq: r.seq, aggregateType: r.aggregate_type, aggregateId: r.aggregate_id,
      eventType: r.event_type, payload: safeParse(r.payload_json), createdAt: r.created_at,
    }));
    const cursor = events.length ? events[events.length - 1].seq : after;
    return { events, cursor, hasMore };
  }

  // ── Idempotência de comandos ──────────────────────────────────────────────
  /** Se o comando já foi processado, devolve o resultado guardado; senão null. */
  static lookupCommand(orgId: string, commandId: string): any | null {
    if (!commandId) return null;
    const row = db.prepare("SELECT status, result_json FROM client_commands WHERE organization_id = ? AND command_id = ?").get(orgId, commandId) as any;
    if (!row) return null;
    return { status: row.status, result: safeParse(row.result_json) };
  }

  /** Registra um comando processado (idempotência). Ignora se já existir. */
  static recordCommand(orgId: string, commandId: string, meta: { deviceId?: string; userId?: string; operationType?: string; status?: string; result?: any }): void {
    if (!commandId) return;
    try {
      db.prepare(`INSERT OR IGNORE INTO client_commands (organization_id, command_id, device_id, user_id, operation_type, status, result_json, processed_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .run(orgId, commandId, meta.deviceId || null, meta.userId || null, meta.operationType || null, meta.status || "processed", JSON.stringify(meta.result ?? null));
    } catch (e) { console.error("[Continuity] Falha ao registrar comando", commandId, e); }
  }

  /**
   * Executa `fn` com idempotência: se `commandId` já foi processado, devolve o
   * resultado guardado sem reexecutar; senão roda, registra e devolve.
   */
  static async runIdempotent<T>(orgId: string, commandId: string | null | undefined, meta: { deviceId?: string; userId?: string; operationType?: string }, fn: () => Promise<T>): Promise<{ result: T; deduped: boolean }> {
    const cid = String(commandId || "").trim();
    if (cid) {
      const prev = this.lookupCommand(orgId, cid);
      if (prev) return { result: prev.result as T, deduped: true };
    }
    const result = await fn();
    if (cid) this.recordCommand(orgId, cid, { ...meta, status: "processed", result });
    return { result, deduped: false };
  }
}

function safeParse(s: any): any { try { return JSON.parse(s || "null"); } catch { return null; } }
