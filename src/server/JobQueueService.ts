import { randomUUID } from "node:crypto";
import db from "./db.js";

// Fila de jobs em segundo plano — generaliza o padrão que já existia ad-hoc só
// para backup (backup_jobs + setImmediate direto em routes/integrations.ts):
// grava um registro 'pending', dispara a execução via setImmediate (não
// bloqueia quem chamou enqueue) e atualiza o registro ao terminar.
//
// NÃO é uma fila distribuída (Redis/BullMQ) — continua sendo um processo só,
// mesma limitação de sempre. O que ela resolve é o sintoma real de hoje:
// trabalho pesado (gerar PDF, chamar IA) rodando dentro do ciclo da própria
// requisição/webhook. Ver docs/adr/ADR-011-hardening-rbac-auditoria-fila-storage.md.
//
// Modelo de entrega: setImmediate cobre o caso comum (processamento quase
// instantâneo). O `sweepStale()` (chamado pelo passe rápido do Scheduler, a
// cada 5 min) é a rede de segurança para o caso raro — processo reiniciou
// entre o enqueue e o setImmediate rodar, ou caiu no meio da execução.

export type JobHandler = (payload: any, job: any) => Promise<any>;

const handlers = new Map<string, JobHandler>();

export class JobQueueService {
  /** Cada serviço que processa um tipo de job se registra aqui (uma vez, no boot). */
  static registerHandler(type: string, handler: JobHandler) {
    handlers.set(type, handler);
  }

  /** Enfileira e dispara o processamento em background — NUNCA bloqueia o caller. */
  static enqueue(type: string, payload: any = {}, opts: { organizationId?: string | null; maxAttempts?: number } = {}): string {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO background_jobs (id, organization_id, type, payload_json, status, max_attempts)
       VALUES (?, ?, ?, ?, 'pending', ?)`
    ).run(id, opts.organizationId || null, type, JSON.stringify(payload ?? {}), opts.maxAttempts ?? 3);

    setImmediate(() => { this.runJob(id).catch((e) => console.error("[JobQueue] runJob falhou", id, e)); });
    return id;
  }

  static async runJob(id: string): Promise<void> {
    const job = db.prepare(`SELECT * FROM background_jobs WHERE id = ?`).get(id) as any;
    if (!job || job.status === "completed") return; // já processado (ou removido)

    const handler = handlers.get(job.type);
    if (!handler) {
      db.prepare(`UPDATE background_jobs SET status='failed', last_error=?, completed_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(`Nenhum handler registrado para o tipo '${job.type}'`, id);
      console.error(`[JobQueue] job ${id}: nenhum handler para tipo '${job.type}'`);
      return;
    }

    const attempts = (job.attempts || 0) + 1;
    db.prepare(`UPDATE background_jobs SET status='processing', started_at=CURRENT_TIMESTAMP, attempts=? WHERE id=?`).run(attempts, id);

    try {
      const payload = job.payload_json ? JSON.parse(job.payload_json) : {};
      const result = await handler(payload, job);
      db.prepare(`UPDATE background_jobs SET status='completed', completed_at=CURRENT_TIMESTAMP, result_json=? WHERE id=?`)
        .run(JSON.stringify(result ?? null), id);
    } catch (e: any) {
      const willRetry = attempts < (job.max_attempts || 3);
      db.prepare(`UPDATE background_jobs SET status=?, last_error=?, completed_at=? WHERE id=?`).run(
        willRetry ? "pending" : "failed",
        String(e?.message || e).slice(0, 500),
        willRetry ? null : new Date().toISOString(),
        id
      );
      console.error(`[JobQueue] job ${id} (${job.type}) falhou na tentativa ${attempts}${willRetry ? " — será reprocessado" : " — desistindo"}:`, e);
    }
  }

  /**
   * Rede de segurança (Scheduler.fastPass, a cada 5 min): reprocessa jobs
   * 'pending' (setImmediate pode não ter disparado — reinício do processo) ou
   * 'processing' travado há mais de `staleMinutes` (o processo caiu no meio).
   */
  static sweepStale(staleMinutes = 10): number {
    let rows: any[] = [];
    try {
      rows = db.prepare(
        `SELECT id FROM background_jobs
         WHERE status = 'pending'
            OR (status = 'processing' AND started_at <= datetime('now', ?))
         LIMIT 100`
      ).all(`-${staleMinutes} minutes`) as any[];
    } catch (e) { return 0; }
    for (const r of rows) {
      this.runJob(r.id).catch((e) => console.error("[JobQueue] sweep runJob falhou", r.id, e));
    }
    return rows.length;
  }

  static get(id: string): any {
    return db.prepare(`SELECT * FROM background_jobs WHERE id = ?`).get(id);
  }

  static listByOrg(orgId: string, status?: string): any[] {
    if (status) return db.prepare(`SELECT * FROM background_jobs WHERE organization_id = ? AND status = ? ORDER BY created_at DESC`).all(orgId, status) as any[];
    return db.prepare(`SELECT * FROM background_jobs WHERE organization_id = ? ORDER BY created_at DESC`).all(orgId) as any[];
  }
}
