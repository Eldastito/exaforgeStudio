/**
 * CapacityForecastService — PRD 7 / ADR-164 F8 (§80-§85, RN-PRC-9): forecast de capacidade.
 *
 * Projeta a TRAJETÓRIA de uma métrica no tempo a partir do histórico AGREGADO que a F6
 * (`platform_health_snapshots`) já acumula, e estima QUANDO ela cruza um alvo inseguro —
 * sempre com CONFIANÇA explícita. Não é um TSDB nem lê raw (RN-PRC-3): consome só o
 * agregado da F6.
 *
 * MÉTODO (determinístico, sem LLM §56):
 *   1. Agrega as amostras por DIA (bucket SP) → média diária. Isso remove o ciclo
 *      intradiário (sazonalidade §33) antes de medir a tendência — senão o pico das 14h
 *      viraria "crescimento".
 *   2. Ajuste linear (mínimos quadrados) da média diária vs. índice do dia → `slopePerDay`.
 *   3. `r2` (qualidade do ajuste) + tamanho de amostra viram a CONFIANÇA (alta/média/baixa).
 *   4. Projeta `horizonDays` à frente e, dado um alvo, estima `daysToTarget` — só quando a
 *      inclinação aponta PARA o alvo (senão `not_approaching`).
 *
 * GUARDRAILS DUROS:
 *   - RN-PRC-9 / §59 / §103 — **nunca inventa**: menos de `MIN_DAYS` dias distintos →
 *     `insufficient_history`. Forecast só é útil depois de dias acumulando em produção.
 *   - RN-PRC-1 — não projeta a partir de pico único: a tendência exige série de vários dias.
 *   - §35 — resultado é HIPÓTESE (`basis:"trend"`) com confiança, nunca veredito.
 *   - RN-PRC-4 / §46 — GLOBAL (Admin Master), sem organization_id.
 *   - Determinístico (`now` injetável).
 */
import db from "./db.js";

const SP_OFFSET_MS = 3 * 60 * 60 * 1000; // UTC-3 (SP) — mesmo bucket da F6
const MIN_DAYS = 5;                        // < isso → insufficient_history (§59)
const DAY_MS = 86400000;

// Alvos de capacidade (limiar CRÍTICO) espelhando os modelos da F7. Forecast projeta
// a métrica-base rumo a esse alvo. Provisórios (refinados por VPS spec/baseline).
const CAPACITY_TARGETS: Record<string, { critical: number; unit: string; label: string }> = {
  "host.mem_used_pct": { critical: 94, unit: "%", label: "Memória do host" },
  "host.load1m": { critical: 2.0, unit: "load", label: "CPU (load 1m)" }, // ~2.0/core em host pequeno
  "db.probe_ms": { critical: 50, unit: "ms", label: "Latência de probe do banco" },
  "queue.pending": { critical: 500, unit: "jobs", label: "Backlog da fila" },
  "app.p95": { critical: 1000, unit: "ms", label: "Latência p95 da aplicação" },
};

function dayBucket(atMs: number): number {
  // índice absoluto do dia (SP) — determinístico, monotônico
  return Math.floor((atMs - SP_OFFSET_MS) / DAY_MS);
}

export class CapacityForecastService {
  /**
   * Forecast de uma métrica. `days` = janela de lookback (default 30). `horizonDays` =
   * quantos dias projetar à frente (default 14). `target` = alvo a cruzar (default: limiar
   * crítico conhecido da métrica, se houver).
   */
  static forecast(metric: string, opts: { now?: number; days?: number; horizonDays?: number; target?: number } = {}): any {
    const now = opts.now ?? Date.now();
    const days = Math.max(MIN_DAYS, Math.min(365, opts.days ?? 30));
    const horizonDays = Math.max(1, Math.min(180, opts.horizonDays ?? 14));
    const since = new Date(now - days * DAY_MS).toISOString();

    const rows = db.prepare(
      `SELECT captured_at, value FROM platform_health_snapshots WHERE metric = ? AND captured_at >= ? ORDER BY captured_at ASC`
    ).all(metric, since) as any[];

    // Agrega por dia (média diária) — remove sazonalidade intradiária antes da tendência.
    const byDay = new Map<number, { sum: number; n: number }>();
    for (const r of rows) {
      const v = Number(r.value);
      if (!Number.isFinite(v)) continue;
      const d = dayBucket(Date.parse(r.captured_at));
      const cur = byDay.get(d) ?? { sum: 0, n: 0 };
      cur.sum += v; cur.n += 1; byDay.set(d, cur);
    }
    const dayKeys = [...byDay.keys()].sort((a, b) => a - b);
    if (dayKeys.length < MIN_DAYS) {
      return { metric, available: false, reason: "insufficient_history", distinctDays: dayKeys.length, minDays: MIN_DAYS, windowDays: days };
    }

    // Ajuste linear sobre (índice-do-dia-desde-o-início, média-diária).
    const d0 = dayKeys[0];
    const xs = dayKeys.map((d) => d - d0);
    const ys = dayKeys.map((d) => { const c = byDay.get(d)!; return c.sum / c.n; });
    const n = xs.length;
    const mx = xs.reduce((s, x) => s + x, 0) / n;
    const my = ys.reduce((s, y) => s + y, 0) / n;
    let sxx = 0, sxy = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2; }

    const slopePerDay = sxx === 0 ? 0 : sxy / sxx;
    const intercept = my - slopePerDay * mx;
    // r2: fração da variância explicada. Série plana (syy=0) → estável, não "bem ajustada".
    let ssRes = 0;
    for (let i = 0; i < n; i++) { const fit = intercept + slopePerDay * xs[i]; ssRes += (ys[i] - fit) ** 2; }
    const r2 = syy === 0 ? (slopePerDay === 0 ? 1 : 0) : Math.max(0, 1 - ssRes / syy);

    const xNow = dayBucket(now) - d0;
    const fittedNow = intercept + slopePerDay * xNow;
    const projected = intercept + slopePerDay * (xNow + horizonDays);

    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    const confidence = this.confidenceOf(r2, n, syy);

    // Alvo: explícito, ou limiar crítico conhecido da métrica.
    const target = opts.target ?? CAPACITY_TARGETS[metric]?.critical;
    let targetCrossing: any = { target: target ?? null, approaching: false, reason: "no_target" };
    if (target != null) {
      if (slopePerDay <= 0) {
        targetCrossing = { target, approaching: false, reason: fittedNow >= target ? "already_at_or_above" : "flat_or_declining" };
      } else if (fittedNow >= target) {
        targetCrossing = { target, approaching: false, reason: "already_at_or_above", daysToTarget: 0 };
      } else {
        const daysToTarget = (target - fittedNow) / slopePerDay;
        targetCrossing = {
          target, approaching: true, daysToTarget: r3(daysToTarget),
          crossingAt: new Date(now + daysToTarget * DAY_MS).toISOString(),
          withinHorizon: daysToTarget <= horizonDays,
        };
      }
    }

    return {
      metric, available: true, basis: "trend", confidence,
      distinctDays: n, windowDays: days, horizonDays,
      slopePerDay: r3(slopePerDay), r2: r3(r2),
      current: r3(fittedNow), projected: r3(projected),
      projectedAt: new Date(now + horizonDays * DAY_MS).toISOString(),
      targetCrossing,
      generatedAt: new Date(now).toISOString(),
    };
  }

  /**
   * Confiança do forecast (§35 — nunca "certeza"). Combina qualidade do ajuste (r2) com
   * tamanho de amostra. Série plana com muitos dias = tendência estável de alta confiança
   * ("não vai cruzar"); poucos dias ou ajuste ruim = baixa.
   */
  static confidenceOf(r2: number, days: number, syy: number): "alta" | "média" | "baixa" {
    if (syy === 0 && days >= MIN_DAYS * 2) return "alta"; // estável comprovado
    if (r2 >= 0.5 && days >= 14) return "alta";
    if (r2 >= 0.25 && days >= MIN_DAYS * 2) return "média";
    return "baixa";
  }

  /**
   * Forecast das métricas de capacidade conhecidas rumo ao limiar crítico. Retorna o
   * gargalo mais PRÓXIMO (menor `daysToTarget`) entre as que estão se aproximando — o
   * "primeiro a estourar". Métricas sem histórico são declaradas, não inventadas.
   */
  static forecastCapacity(opts: { now?: number; days?: number; horizonDays?: number } = {}): any {
    const now = opts.now ?? Date.now();
    const forecasts: any[] = [];
    for (const [metric, meta] of Object.entries(CAPACITY_TARGETS)) {
      const f = this.forecast(metric, { now, days: opts.days, horizonDays: opts.horizonDays });
      forecasts.push({ ...f, label: meta.label, unit: meta.unit });
    }
    const approaching = forecasts
      .filter((f) => f.available && f.targetCrossing?.approaching && f.targetCrossing.daysToTarget != null)
      .sort((a, b) => a.targetCrossing.daysToTarget - b.targetCrossing.daysToTarget);
    return {
      generatedAt: new Date(now).toISOString(),
      firstBottleneck: approaching.length ? { metric: approaching[0].metric, label: approaching[0].label, daysToTarget: approaching[0].targetCrossing.daysToTarget, confidence: approaching[0].confidence } : null,
      forecasts,
    };
  }
}

export default CapacityForecastService;
