import db from "./db.js";
import { ProviderHealthState } from "./skillosModel.js";

/**
 * SkillOsProviderHealthService — PRD 4 F5 (§26): o CIRCUIT BREAKER, derivado.
 *
 * O estado do provider/modelo (healthy/watch/degraded/open/half_open) é DERIVADO
 * por query das AI Runs (F4, `ai_usage_log.run_status/failure_class`) numa janela —
 * NÃO um contador mutável nem tabela de estado (RN-004; padrão `RuntimeExceptions`/
 * `DetectorBudget`). É a única primitiva de Kernel genuinamente nova da F5.
 *
 * Saúde é sinal de PLATAFORMA (§49): um provider caído está caído pra todos —
 * agrega as AI Runs de todos os tenants (só taxas/contagens, nunca conteúdo). O
 * `orgId` opcional escopa por tenant quando desejado.
 *
 * GUARDRAILS (testados):
 *   - RN-HLT-1 DERIVADO (RN-004): estado sai de query, sem contador/tabela própria.
 *   - RN-HLT-2 CONSERVADOR: amostra insuficiente → healthy (não trip por ruído).
 *   - RN-HLT-3 RECUPERAÇÃO: open + última run OK → half_open (deixa o probe passar).
 */

export interface HealthOpts {
  model?: string;
  windowMinutes?: number;   // default 15
  minSamples?: number;      // default 3
  orgId?: string;           // default: plataforma (todos os tenants)
}

// Limiares (taxa de falha na janela). Configuráveis via opts numa fatia futura.
const OPEN = 0.5;
const DEGRADED = 0.25;
const WATCH = 0.1;

export class SkillOsProviderHealthService {
  /** Estado do circuit breaker do provider (+modelo) na janela. */
  static state(provider: string, opts: HealthOpts = {}): ProviderHealthState {
    const windowMinutes = opts.windowMinutes && opts.windowMinutes > 0 ? opts.windowMinutes : 15;
    const minSamples = opts.minSamples && opts.minSamples > 0 ? opts.minSamples : 3;
    const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString();

    let sql = "SELECT run_status FROM ai_usage_log WHERE provider = ? AND run_id IS NOT NULL AND datetime(created_at) >= datetime(?)";
    const params: any[] = [provider, cutoff];
    if (opts.model) { sql += " AND model = ?"; params.push(opts.model); }
    if (opts.orgId) { sql += " AND organization_id = ?"; params.push(opts.orgId); }
    sql += " ORDER BY rowid ASC";
    const rows = db.prepare(sql).all(...params) as any[];

    let failed = 0, ok = 0, latest: string | null = null;
    for (const r of rows) {
      const s = String(r.run_status || "");
      if (s === "failed" || s === "fallback") { failed++; latest = "fail"; }
      else if (s === "ok" || s === "retried") { ok++; latest = "ok"; }
    }
    const total = failed + ok;
    if (total < minSamples) return "healthy"; // RN-HLT-2
    const rate = failed / total;
    let base: ProviderHealthState = rate >= OPEN ? "open" : rate >= DEGRADED ? "degraded" : rate >= WATCH ? "watch" : "healthy";
    // RN-HLT-3 — está aberto mas a última run passou → recuperando (probe permitido).
    if (base === "open" && latest === "ok") base = "half_open";
    return base;
  }

  /** Taxas/contagens da janela (observabilidade; a redação §30 é da F9). */
  static stats(provider: string, opts: HealthOpts = {}): { total: number; failed: number; ok: number; failureRate: number; state: ProviderHealthState } {
    const windowMinutes = opts.windowMinutes && opts.windowMinutes > 0 ? opts.windowMinutes : 15;
    const cutoff = new Date(Date.now() - windowMinutes * 60000).toISOString();
    let sql = "SELECT run_status, COUNT(*) c FROM ai_usage_log WHERE provider = ? AND run_id IS NOT NULL AND datetime(created_at) >= datetime(?)";
    const params: any[] = [provider, cutoff];
    if (opts.model) { sql += " AND model = ?"; params.push(opts.model); }
    if (opts.orgId) { sql += " AND organization_id = ?"; params.push(opts.orgId); }
    sql += " GROUP BY run_status";
    const rows = db.prepare(sql).all(...params) as any[];
    let failed = 0, ok = 0;
    for (const r of rows) {
      const s = String(r.run_status || ""); const c = Number(r.c) || 0;
      if (s === "failed" || s === "fallback") failed += c;
      else if (s === "ok" || s === "retried") ok += c;
    }
    const total = failed + ok;
    return { total, failed, ok, failureRate: total ? failed / total : 0, state: this.state(provider, opts) };
  }
}

export default SkillOsProviderHealthService;
