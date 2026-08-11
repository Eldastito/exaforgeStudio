/**
 * SignalCalibrationService — PRD 2 F11 (§63-66, CA19): a QUALIDADE do Radar,
 * derivada por query (RN-004, sem contador mutável). Responde "o Radar está bem
 * calibrado?" por DETECTOR (source_service):
 *   - emitidos, descartados (total), descartados COMO FALSO (reason=incorrect),
 *     acionados (acknowledged), auto/resolvidos, expirados;
 *   - falsePositiveRate (§66/CA19), dismissalRate (§63 alerta-fadiga), actedRate;
 *   - flag de calibração: 'poor' quando o detector é majoritariamente ignorado.
 *
 * Sem fonte nova: lê `business_signals` (o ledger canônico) + o `dismiss_reason`
 * que a F11 passou a capturar. Isolado por org.
 */
import db from "./db.js";

export interface DetectorCalibration {
  detector: string;
  emitted: number;
  dismissed: number;
  dismissedFalse: number;       // reason = incorrect (falso-positivo)
  acknowledged: number;         // "acionado" (roteado/reconhecido)
  resolved: number;
  expired: number;
  open: number;
  falsePositiveRate: number;    // dismissedFalse / emitted (CA19)
  dismissalRate: number;        // dismissed / emitted (§63)
  actedRate: number;            // acknowledged / emitted
  calibration: "ok" | "watch" | "poor";
  dismissReasons: Record<string, number>;
}

const rate = (num: number, den: number) => (den > 0 ? Math.round((num / den) * 1000) / 1000 : 0);

export class SignalCalibrationService {
  /**
   * Métricas de qualidade por detector na janela (default 30 dias). `days<=0`
   * = tudo. Calibração: dismissalRate > 0.9 → 'poor' (§63: 90% ignorados = mal
   * calibrado); > 0.6 → 'watch'; senão 'ok'.
   */
  static detectorMetrics(orgId: string, opts: { days?: number } = {}): { generatedAt: string; windowDays: number | null; detectors: DetectorCalibration[]; totals: DetectorCalibration } {
    const days = opts.days === undefined ? 30 : Number(opts.days);
    const where = days > 0 ? `AND detected_at >= datetime('now', ?)` : "";
    const params: any[] = [orgId];
    if (days > 0) params.push(`-${days} days`);

    const rows = db.prepare(
      `SELECT COALESCE(source_service, '?') AS detector,
              COUNT(*) AS emitted,
              SUM(CASE WHEN status='dismissed' THEN 1 ELSE 0 END) AS dismissed,
              SUM(CASE WHEN status='dismissed' AND dismiss_reason='incorrect' THEN 1 ELSE 0 END) AS dismissedFalse,
              SUM(CASE WHEN status='acknowledged' THEN 1 ELSE 0 END) AS acknowledged,
              SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved,
              SUM(CASE WHEN status='expired' THEN 1 ELSE 0 END) AS expired,
              SUM(CASE WHEN status='open' THEN 1 ELSE 0 END) AS open
         FROM business_signals
        WHERE organization_id = ? ${where}
        GROUP BY detector ORDER BY emitted DESC`
    ).all(...params) as any[];

    // Motivos de descarte por detector (§65).
    const reasonRows = db.prepare(
      `SELECT COALESCE(source_service,'?') AS detector, COALESCE(dismiss_reason,'unspecified') AS reason, COUNT(*) AS n
         FROM business_signals WHERE organization_id = ? AND status='dismissed' ${where}
        GROUP BY detector, reason`
    ).all(...params) as any[];
    const reasonsByDetector = new Map<string, Record<string, number>>();
    for (const r of reasonRows) {
      const m = reasonsByDetector.get(r.detector) || {};
      m[r.reason] = Number(r.n);
      reasonsByDetector.set(r.detector, m);
    }

    const build = (r: any): DetectorCalibration => {
      const emitted = Number(r.emitted) || 0;
      const dismissed = Number(r.dismissed) || 0;
      const dismissalRate = rate(dismissed, emitted);
      const calibration = dismissalRate > 0.9 ? "poor" : dismissalRate > 0.6 ? "watch" : "ok";
      return {
        detector: r.detector, emitted, dismissed, dismissedFalse: Number(r.dismissedFalse) || 0,
        acknowledged: Number(r.acknowledged) || 0, resolved: Number(r.resolved) || 0, expired: Number(r.expired) || 0, open: Number(r.open) || 0,
        falsePositiveRate: rate(Number(r.dismissedFalse) || 0, emitted),
        dismissalRate, actedRate: rate(Number(r.acknowledged) || 0, emitted),
        calibration, dismissReasons: reasonsByDetector.get(r.detector) || {},
      };
    };

    const detectors = rows.map(build);
    // Totais agregados (soma dos campos; taxas recomputadas sobre o total).
    const agg = detectors.reduce((a, d) => {
      a.emitted += d.emitted; a.dismissed += d.dismissed; a.dismissedFalse += d.dismissedFalse;
      a.acknowledged += d.acknowledged; a.resolved += d.resolved; a.expired += d.expired; a.open += d.open;
      for (const [k, v] of Object.entries(d.dismissReasons)) a.dismissReasons[k] = (a.dismissReasons[k] || 0) + v;
      return a;
    }, { detector: "ALL", emitted: 0, dismissed: 0, dismissedFalse: 0, acknowledged: 0, resolved: 0, expired: 0, open: 0, falsePositiveRate: 0, dismissalRate: 0, actedRate: 0, calibration: "ok" as const, dismissReasons: {} as Record<string, number> });
    const totals: DetectorCalibration = { ...agg, falsePositiveRate: rate(agg.dismissedFalse, agg.emitted), dismissalRate: rate(agg.dismissed, agg.emitted), actedRate: rate(agg.acknowledged, agg.emitted), calibration: rate(agg.dismissed, agg.emitted) > 0.9 ? "poor" : rate(agg.dismissed, agg.emitted) > 0.6 ? "watch" : "ok" };

    return { generatedAt: new Date().toISOString(), windowDays: days > 0 ? days : null, detectors, totals };
  }
}
