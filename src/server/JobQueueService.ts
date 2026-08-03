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

// ADR-152 F2.1 — classes de erro do Runtime. Governa retry:
//   retryable            — falha transiente (rede, DB lock). Reprocessa com backoff.
//   external_unavailable — API externa fora do ar. Reprocessa com backoff MAIOR.
//   permission           — 401/403. NÃO retenta; vai pra dead-letter (falta credencial).
//   non_retryable        — 400/422/malformado. NÃO retenta.
// Erros não classificados assumem `retryable` (comportamento atual preservado).
export type JobErrorClass = "retryable" | "external_unavailable" | "permission" | "non_retryable";

const NON_RETRYABLE_CLASSES: Set<JobErrorClass> = new Set(["permission", "non_retryable"]);

export class JobQueueError extends Error {
  constructor(message: string, public readonly errorClass: JobErrorClass) { super(message); this.name = "JobQueueError"; }
}

/**
 * Backoff exponencial com teto e base fixa por tentativa (ADR-152 F2.1). O
 * teto de 30min evita que uma cadeia de falhas mande o job pra daqui a
 * horas. `external_unavailable` dobra pra dar tempo do provedor voltar.
 */
export function computeBackoffSeconds(attempt: number, errorClass: JobErrorClass = "retryable"): number {
  const base = errorClass === "external_unavailable" ? 60 : 30; // seg
  const raw = base * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, 1800); // 30 min máx
}

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
      // ADR-152 F2.1 — classifica erro pra decidir política de retry.
      // JobQueueError.errorClass é honrado; sem classe, assume 'retryable'
      // (compatível com o comportamento antigo). permission/non_retryable
      // NÃO retentam — mesmo abaixo de max_attempts — vão pra dead-letter.
      const errorClass: JobErrorClass = e instanceof JobQueueError ? e.errorClass : "retryable";
      const belowCap = attempts < (job.max_attempts || 3);
      const willRetry = belowCap && !NON_RETRYABLE_CLASSES.has(errorClass);
      const backoff = willRetry ? computeBackoffSeconds(attempts, errorClass) : null;
      const nextAt = backoff != null ? new Date(Date.now() + backoff * 1000).toISOString() : null;
      db.prepare(`UPDATE background_jobs SET status=?, last_error=?, error_class=?, backoff_seconds=?, next_attempt_at=?, completed_at=? WHERE id=?`).run(
        willRetry ? "pending" : "failed",
        String(e?.message || e).slice(0, 500),
        errorClass,
        backoff,
        nextAt,
        willRetry ? null : new Date().toISOString(),
        id
      );
      console.error(`[JobQueue] job ${id} (${job.type}) falhou na tentativa ${attempts} [${errorClass}]${willRetry ? ` — reprocessa em ${backoff}s` : " — dead-letter"}:`, e);
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
      // ADR-152 F2.1 — só reprocessa `pending` cujo `next_attempt_at` já
      // venceu (ou é null, mantendo compat com jobs pré-F2.1). Sem o filtro,
      // o sweep quebrava o backoff exponencial e reprocessava tudo a cada
      // 5min. `processing` travado (crash no meio) segue reprocessando.
      rows = db.prepare(
        `SELECT id FROM background_jobs
         WHERE (status = 'pending' AND (next_attempt_at IS NULL OR datetime(next_attempt_at) <= CURRENT_TIMESTAMP))
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

  static health(): { pending: number; processing: number; completed: number; failed: number; total: number; oldestPending: string | null } {
    const counts = db.prepare(
      `SELECT status, COUNT(*) as c FROM background_jobs GROUP BY status`
    ).all() as any[];
    const m: Record<string, number> = {};
    let total = 0;
    for (const r of counts) { m[r.status] = r.c; total += r.c; }
    const oldest = db.prepare(
      `SELECT created_at FROM background_jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`
    ).get() as any;
    return { pending: m.pending || 0, processing: m.processing || 0, completed: m.completed || 0, failed: m.failed || 0, total, oldestPending: oldest?.created_at || null };
  }

  static cleanupCompleted(olderThanDays: number = 7): number {
    const r = db.prepare(
      `DELETE FROM background_jobs WHERE status = 'completed' AND completed_at < datetime('now', ?)`
    ).run(`-${olderThanDays} days`);
    return r.changes;
  }

  static retry(jobId: string): boolean {
    // Reset também backoff/error_class/next_attempt_at pra o retry manual
    // não ficar preso no janelamento do backoff anterior (ADR-152 F2.1).
    const r = db.prepare(
      `UPDATE background_jobs SET status = 'pending', last_error = NULL, completed_at = NULL, attempts = 0, error_class = NULL, backoff_seconds = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'failed'`
    ).run(jobId);
    if (r.changes > 0) {
      setImmediate(() => { this.runJob(jobId).catch((e) => console.error("[JobQueue] retry runJob falhou", jobId, e)); });
      return true;
    }
    return false;
  }

  /**
   * Dead-letter formal (ADR-152 F2.1) — jobs `failed` (max_attempts esgotado
   * OU classe non-retryable). A Fase 3 vai expor isso na aba "Operações",
   * categorizado como exceção "integração falhou" ou "credencial ausente".
   */
  static deadLetters(orgId?: string, limit = 100): any[] {
    if (orgId) {
      return db.prepare(
        `SELECT id, organization_id, type, attempts, max_attempts, error_class, last_error, created_at, completed_at
         FROM background_jobs WHERE organization_id = ? AND status = 'failed'
         ORDER BY completed_at DESC LIMIT ?`
      ).all(orgId, limit) as any[];
    }
    return db.prepare(
      `SELECT id, organization_id, type, attempts, max_attempts, error_class, last_error, created_at, completed_at
       FROM background_jobs WHERE status = 'failed'
       ORDER BY completed_at DESC LIMIT ?`
    ).all(limit) as any[];
  }

  static listRecent(limit: number = 50): any[] {
    return db.prepare(
      `SELECT id, organization_id, type, status, attempts, max_attempts, last_error, created_at, started_at, completed_at FROM background_jobs ORDER BY created_at DESC LIMIT ?`
    ).all(limit) as any[];
  }
}
