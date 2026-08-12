/**
 * DependencyHealthService — PRD 7 / ADR-164 F4 (§16-21): saúde das dependências.
 *
 * COMPÕE (não recria) a saúde de banco, fila e providers num snapshot único pro Admin
 * Master — Camada 4 (§12) do PRD. Reusa o que já existe: `JobQueueService.health()`
 * (fila in-process), `SkillOsProviderHealthService` (health de IA) e um probe LEVE de
 * banco (latência de `SELECT 1` + tamanho do arquivo + WAL). Distingue latência do
 * PROVIDER da latência do HOST (§20/§21).
 *
 * GUARDRAILS:
 *  - RN-PRC-6 (§95/§96): sub-probe que não lê responde `available:false` — NUNCA "saúde".
 *    Provider ainda não instrumentado (WhatsApp/Asaas/e-mail/storage) é declarado
 *    `not_instrumented`, não "healthy".
 *  - RN-PRC-3 (§11): só LÊ/deriva — nada de raw no SQLite.
 *  - §46: platform-global (Admin Master), não per-tenant.
 * Determinístico; `now` injetável.
 */
import fs from "fs";
import db from "./db.js";
import { JobQueueService } from "./JobQueueService.js";
import { SkillOsProviderHealthService } from "./SkillOsProviderHealthService.js";

export type HealthState = "healthy" | "watch" | "degraded" | "unavailable";
// Providers de efeito externo ainda SEM instrumentação de health (fase later) — honesto.
const NOT_INSTRUMENTED = ["whatsapp", "asaas", "email", "storage"];

function worst(states: HealthState[]): HealthState {
  const order: HealthState[] = ["healthy", "watch", "degraded", "unavailable"];
  return states.reduce((acc, s) => (order.indexOf(s) > order.indexOf(acc) ? s : acc), "healthy");
}

export class DependencyHealthService {
  /** Snapshot composto: fila + banco + providers, cada um com estado humano. */
  static snapshot(opts: { now?: number; windowMinutes?: number } = {}): {
    overall: HealthState;
    queue: any; database: any; providers: any;
    generatedAt: string;
  } {
    const now = opts.now ?? Date.now();
    const queue = this.queueHealth(now);
    const database = this.databaseHealth(now);
    const providers = this.providerHealth(opts.windowMinutes ?? 15);
    const overall = worst([queue.state, database.state, providers.state]);
    return { overall, queue, database, providers, generatedAt: new Date(now).toISOString() };
  }

  /** §18-19 — reusa JobQueueService.health(); deriva idade do backlog + taxa de falha. */
  private static queueHealth(now: number) {
    try {
      const h = JobQueueService.health();
      // `oldestPending` é datetime SQLite ("YYYY-MM-DD HH:MM:SS", UTC) — parse como UTC.
      const parsed = h.oldestPending ? new Date(h.oldestPending.replace(" ", "T") + "Z").getTime() : NaN;
      const backlogAgeMs = Number.isFinite(parsed) ? Math.max(0, now - parsed) : 0;
      const finished = h.completed + h.failed;
      const failureRatePct = finished > 0 ? Math.round((h.failed / finished) * 10000) / 100 : 0;
      let state: HealthState = "healthy";
      if (failureRatePct > 25 || backlogAgeMs > 15 * 60000) state = "degraded";
      else if (failureRatePct > 10 || backlogAgeMs > 5 * 60000) state = "watch";
      return { available: true, state, pending: h.pending, processing: h.processing, failed: h.failed, completed: h.completed, oldestPendingAgeMs: backlogAgeMs, failureRatePct, inProcess: true };
    } catch (e: any) {
      return { available: false, state: "unavailable" as HealthState, reason: String(e?.message || e) };
    }
  }

  /** §16-17 — probe LEVE de banco: latência de SELECT 1 + tamanho do arquivo + WAL. */
  private static databaseHealth(_now: number) {
    try {
      const t0 = process.hrtime.bigint();
      db.prepare("SELECT 1 AS ok").get();
      const probeLatencyMs = Math.round((Number(process.hrtime.bigint() - t0) / 1e6) * 1000) / 1000;
      const walMode = String((db as any).pragma?.("journal_mode", { simple: true }) ?? "unknown");
      let fileSizeBytes: number | null = null;
      try {
        const p = (db as any).name as string;
        const main = fs.existsSync(p) ? fs.statSync(p).size : 0;
        const wal = fs.existsSync(p + "-wal") ? fs.statSync(p + "-wal").size : 0;
        fileSizeBytes = main + wal;
      } catch { fileSizeBytes = null; }
      let state: HealthState = "healthy";
      if (probeLatencyMs > 25) state = "degraded";
      else if (probeLatencyMs > 5) state = "watch";
      return { available: true, state, probeLatencyMs, walMode, fileSizeBytes };
    } catch (e: any) {
      return { available: false, state: "unavailable" as HealthState, reason: String(e?.message || e) };
    }
  }

  /** §20-21 — health de providers: IA real (reusa SkillOsProviderHealth); resto honesto. */
  private static providerHealth(windowMinutes: number) {
    const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString();
    let ai: any[] = [];
    try {
      const rows = db.prepare(
        "SELECT DISTINCT provider FROM ai_usage_log WHERE provider IS NOT NULL AND datetime(created_at) >= datetime(?)"
      ).all(cutoff) as any[];
      ai = rows.map((r: any) => {
        const st = SkillOsProviderHealthService.stats(r.provider, { windowMinutes });
        return { name: r.provider, total: st.total, failureRatePct: Math.round(st.failureRate * 10000) / 100, state: this.mapAiState(st.state) };
      });
    } catch { ai = []; }
    const notInstrumented = NOT_INSTRUMENTED.map((name) => ({ name, state: "not_instrumented" as const }));
    // Estado agregado só considera o que é MEDIDO (IA); não-instrumentado não vira "saúde".
    const aiWorst = ai.length ? worst(ai.map((a) => a.state)) : ("healthy" as HealthState);
    return { state: aiWorst, ai: ai.length ? ai : { available: false, reason: "no_data" }, notInstrumented };
  }

  /** Mapeia o estado do SkillOsProviderHealth pro vocabulário desta camada. */
  private static mapAiState(s: string): HealthState {
    if (s === "open" || s === "degraded") return "degraded";
    if (s === "watch" || s === "half_open") return "watch";
    return "healthy";
  }
}

export default DependencyHealthService;
