// ZappFlow Edge — Outbox LOCAL do nó (ADR-082, Fase 4b).
//
// Toda ação crítica feita no nó offline vira um comando durável aqui. Quando a
// nuvem está acessível, o outbox empurra o LOTE para o protocolo de sync (Fase
// 4a: POST /api/edge/push), que deduplica por command_id. O reenvio NUNCA
// duplica (idempotência ponta a ponta). O ciclo lease/backoff é o mesmo do
// MessageDeliveryService do core: pré-reivindica (attempt+1, next_attempt_at
// para frente) ANTES de chamar a rede — se o processo cair no meio, a linha
// continua 'queued' mas só é reprocessada após o backoff.
import { randomUUID } from "node:crypto";
import db from "./db.js";

// Backoff em segundos (configurável p/ testes não esperarem). Igual ao core.
const BACKOFF_SECONDS = (process.env.EDGE_OUTBOX_BACKOFF_SECONDS || "30,120,600,1800,7200,21600")
  .split(",")
  .map((s) => Math.max(1, parseInt(s.trim(), 10) || 1));
const MAX_ATTEMPTS = Math.max(1, Number(process.env.EDGE_OUTBOX_MAX_ATTEMPTS || 8));

export type EdgeCommand = { commandId: string; operationType: string; payload?: any };

/** Resultado que a nuvem devolve por comando (Fase 4a). */
type PushResponse = { results: { commandId: string; status: "accepted" | "deduped" | "rejected" }[] };
/** O transporte que leva o lote à nuvem (HTTP em produção, in-process nos testes). */
export type PushBatch = (commands: EdgeCommand[]) => Promise<PushResponse>;

type OutboxRow = {
  id: string; command_id: string; operation_type: string; payload_json: string | null;
  attempt_count: number; max_attempts: number;
};

export class EdgeOutbox {
  /** Enfileira um comando local (idempotente por command_id — reenfileirar não duplica). */
  static enqueue(input: EdgeCommand): { id: string; deduped: boolean } {
    const existing = db.prepare(`SELECT id FROM edge_outbox WHERE command_id = ?`).get(input.commandId) as any;
    if (existing) return { id: existing.id, deduped: true };
    const id = randomUUID();
    db.prepare(
      `INSERT INTO edge_outbox (id, command_id, operation_type, payload_json, status, max_attempts, next_attempt_at)
       VALUES (?, ?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)`
    ).run(id, input.commandId, input.operationType, JSON.stringify(input.payload ?? null), MAX_ATTEMPTS);
    return { id, deduped: false };
  }

  static pending(): number {
    return (db.prepare(`SELECT COUNT(*) AS c FROM edge_outbox WHERE status = 'queued'`).get() as any).c;
  }

  /**
   * Drena os comandos vencidos (queued + next_attempt_at <= agora) num único
   * lote. Retorna um resumo. `push` faz o POST à nuvem; uma exceção sua = rede
   * caiu → tudo continua na fila (já reagendado pelo pré-claim).
   */
  static async drain(push: PushBatch, limit = 100): Promise<{ sent: number; failed: number; retried: number }> {
    const summary = { sent: 0, failed: 0, retried: 0 };
    const due = db.prepare(
      `SELECT id, command_id, operation_type, payload_json, attempt_count, max_attempts
         FROM edge_outbox WHERE status = 'queued' AND next_attempt_at <= CURRENT_TIMESTAMP
         ORDER BY created_at ASC LIMIT ?`
    ).all(limit) as OutboxRow[];
    if (!due.length) return summary;

    // PRÉ-CLAIM (lease): conta a tentativa e empurra next_attempt_at ANTES do envio.
    for (const d of due) {
      const attempt = d.attempt_count + 1;
      const delaySec = BACKOFF_SECONDS[Math.min(attempt - 1, BACKOFF_SECONDS.length - 1)];
      db.prepare(`UPDATE edge_outbox SET attempt_count = ?, next_attempt_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(attempt, `+${delaySec} seconds`, d.id);
    }

    const commands: EdgeCommand[] = due.map((d) => ({
      commandId: d.command_id, operationType: d.operation_type, payload: safeParse(d.payload_json),
    }));

    let res: PushResponse;
    try {
      res = await push(commands);
    } catch (e: any) {
      // Rede indisponível: o lote inteiro fica na fila (já reagendado). Só marca
      // 'failed' quem estourou o teto de tentativas (não adianta insistir).
      const errMsg = String(e?.message || e).slice(0, 500);
      for (const d of due) {
        if (d.attempt_count + 1 >= (d.max_attempts || MAX_ATTEMPTS)) {
          db.prepare(`UPDATE edge_outbox SET status = 'failed', last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(errMsg, d.id);
          summary.failed++;
        } else {
          db.prepare(`UPDATE edge_outbox SET last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(errMsg, d.id);
          summary.retried++;
        }
      }
      return summary;
    }

    const byId = new Map(res.results.map((r) => [r.commandId, r.status] as const));
    for (const d of due) {
      const status = byId.get(d.command_id);
      if (status === "accepted" || status === "deduped") {
        // A nuvem tem o comando de forma durável → entregue.
        db.prepare(`UPDATE edge_outbox SET status = 'sent', last_error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(d.id);
        summary.sent++;
      } else if (status === "rejected") {
        // Comando inválido (ex.: sem id) — não adianta reenviar.
        db.prepare(`UPDATE edge_outbox SET status = 'failed', last_error = 'rejected_by_cloud', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(d.id);
        summary.failed++;
      } else {
        // Sem resposta para este comando: fica na fila (já reagendado).
        summary.retried++;
      }
    }
    return summary;
  }
}

function safeParse(s: any): any { try { return JSON.parse(s ?? "null"); } catch { return null; } }
