/**
 * PlatformBaselineService — PRD 7 / ADR-164 F6 (§30-§35, §56): baseline + anomalia.
 *
 * Motor DETERMINÍSTICO que COMEÇA a acumular o baseline a partir do que o processo já
 * observa de si (F2-F5), via `OperationalHealthService`. Persiste só AGREGADO (§11):
 * um snapshot por métrica em `platform_health_snapshots`, com seasonality bucket
 * (dia-da-semana/hora SP, §33). Deriva baseline (média/p50/p95/desvio) e candidatos a
 * ANOMALIA por desvio sustentado — SEM LLM (§56/§57).
 *
 * GUARDRAILS: §59/§103 — sem histórico suficiente NÃO inventa: declara
 * `insufficient_history`. §35 — epistemologia fact/correlation/hypothesis/confidence
 * (aqui: anomalia é HIPÓTESE com confiança, não veredito). RN-PRC-3 — só agregado, nunca
 * raw. RN-PRC-4 — GLOBAL (Admin Master), sem organization_id. Determinístico (`now`/`at`
 * injetáveis).
 */
import db from "./db.js";
import { randomUUID } from "crypto";
import { OperationalHealthService } from "./OperationalHealthService.js";

const SP_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3 (SP) — bucket de sazonalidade determinístico
const MIN_SAMPLES = 8;                    // abaixo disso → insufficient_history (§59)

function bucketOf(atMs: number): { dow: number; hour: number } {
  const sp = new Date(atMs - SP_OFFSET_MS);
  return { dow: sp.getUTCDay(), hour: sp.getUTCHours() };
}
function pct(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  return sortedAsc[Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1))];
}
function stdev(xs: number[], mean: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (xs.length - 1));
}

// Métricas capturadas do snapshot operacional (extração pura, só numéricas agregadas).
function extractMetrics(op: any): Record<string, number | null> {
  return {
    "app.p95": op?.operational?.application?.available ? op.operational.application.p95Ms : null,
    "app.error_rate": op?.operational?.application?.available ? op.operational.application.errorRatePct : null,
    "app.rps": op?.operational?.application?.available ? op.operational.application.rps : null,
    "proc.rss": op?.operational?.runtime?.rssBytes ?? null,
    "proc.eventloop_lag": op?.operational?.runtime?.eventLoopLagMs ?? null,
    "host.load1m": op?.operational?.runtime?.load1m ?? null,
    "host.mem_used_pct": op?.operational?.runtime?.hostMemUsedPct ?? null,
    "queue.pending": op?.operational?.dependencies?.queue?.pending ?? null,
    "db.probe_ms": op?.operational?.dependencies?.database?.probeLatencyMs ?? null,
  };
}

export class PlatformBaselineService {
  /** Captura um snapshot agregado (uma linha por métrica não-nula). Retorna nº gravado. */
  static capture(opts: { at?: number; op?: any } = {}): { captured: number; at: string } {
    const at = opts.at ?? Date.now();
    const op = opts.op ?? OperationalHealthService.snapshot({ now: at });
    const { dow, hour } = bucketOf(at);
    const atIso = new Date(at).toISOString();
    const metrics = extractMetrics(op);
    let captured = 0;
    const ins = db.prepare(`INSERT INTO platform_health_snapshots (id, captured_at, metric, value, dow, hour) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const [metric, value] of Object.entries(metrics)) {
      if (value == null || !Number.isFinite(value)) continue;   // sem valor → não grava (RN-PRC-6)
      ins.run(randomUUID(), atIso, metric, value, dow, hour); captured++;
    }
    return { captured, at: atIso };
  }

  /**
   * Baseline de uma métrica numa janela (default 30d). `seasonal` restringe ao mesmo
   * bucket (dow/hour) de `now` (§33). Sem amostra suficiente → available:false (§59).
   */
  static baseline(metric: string, opts: { now?: number; days?: number; seasonal?: boolean } = {}): any {
    const now = opts.now ?? Date.now();
    const days = Math.max(1, Math.min(365, opts.days ?? 30));
    const since = new Date(now - days * 86400000).toISOString();
    let sql = `SELECT value FROM platform_health_snapshots WHERE metric = ? AND captured_at >= ?`;
    const params: any[] = [metric, since];
    if (opts.seasonal) { const b = bucketOf(now); sql += ` AND dow = ? AND hour = ?`; params.push(b.dow, b.hour); }
    const vals = (db.prepare(sql).all(...params) as any[]).map((r) => Number(r.value)).filter(Number.isFinite);
    if (vals.length < MIN_SAMPLES) {
      return { metric, available: false, reason: "insufficient_history", sampleSize: vals.length, minSamples: MIN_SAMPLES, seasonal: !!opts.seasonal };
    }
    const sorted = vals.slice().sort((a, b) => a - b);
    const mean = vals.reduce((s, x) => s + x, 0) / vals.length;
    const r2 = (n: number) => Math.round(n * 1000) / 1000;
    return {
      metric, available: true, sampleSize: vals.length, seasonal: !!opts.seasonal,
      mean: r2(mean), p50: r2(pct(sorted, 0.5)), p95: r2(pct(sorted, 0.95)),
      stdev: r2(stdev(vals, mean)), min: r2(sorted[0]), max: r2(sorted[sorted.length - 1]),
    };
  }

  /**
   * Candidatos a anomalia: compara o valor MAIS RECENTE de cada métrica com o baseline.
   * z = (valor - média)/desvio; anomalia se |z| >= 3 (alta) ou >= 2 (média). HIPÓTESE com
   * confiança (§35), nunca veredito. Sem histórico → o metric é omitido (não inventa).
   */
  static anomalies(opts: { now?: number; days?: number; metrics?: string[]; z?: number } = {}): any {
    const now = opts.now ?? Date.now();
    const metrics = opts.metrics ?? ["app.p95", "app.error_rate", "proc.rss", "proc.eventloop_lag", "host.load1m", "queue.pending", "db.probe_ms"];
    const zHigh = opts.z ?? 3, zMed = 2;
    const found: any[] = [];
    for (const metric of metrics) {
      const base = this.baseline(metric, { now, days: opts.days });
      if (!base.available || base.stdev === 0) continue;                 // sem baseline/variância → não opina
      const latest = db.prepare(`SELECT value FROM platform_health_snapshots WHERE metric = ? ORDER BY captured_at DESC LIMIT 1`).get(metric) as any;
      if (!latest) continue;
      const z = (Number(latest.value) - base.mean) / base.stdev;
      const az = Math.abs(z);
      if (az < zMed) continue;
      found.push({
        metric, latest: Number(latest.value), baselineMean: base.mean, baselineStdev: base.stdev,
        z: Math.round(z * 100) / 100, direction: z > 0 ? "above" : "below",
        severity: az >= zHigh ? "high" : "medium",
        basis: "correlation", confidence: az >= zHigh ? "alta" : "média",   // HIPÓTESE (§35), não causa
      });
    }
    return { generatedAt: new Date(now).toISOString(), sampleWindowDays: opts.days ?? 30, anomalies: found };
  }

  /** Retenção: mantém só os últimos `days` dias de snapshot (§19 — não infla o banco). */
  static prune(days: number = 90): number {
    const r = db.prepare(`DELETE FROM platform_health_snapshots WHERE captured_at < datetime('now', ?)`).run(`-${Math.max(1, days)} days`);
    return r.changes;
  }
}

export default PlatformBaselineService;
