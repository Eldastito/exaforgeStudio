/**
 * RadarHealthService — PRD 2 F12.1 (§94-98, CA16): a SAÚDE do Radar pra o admin.
 *
 * Fecha o "está o Radar operando bem?" que a F11 (calibração por detector) abriu,
 * agora com a leitura OPERACIONAL agregada que produção exige (§94-98):
 *   - VOLUME: sinais por status/severidade/domínio na janela (pulso do Radar);
 *   - FRESHNESS (§96): há quanto tempo cada detector emitiu pela última vez —
 *     detector que PAROU de emitir (stale) é tão suspeito quanto um que dispara
 *     demais (pode ter quebrado silenciosamente; CA16 diz que detector isolado
 *     não derruba o resto, então a falha é silenciosa por design → precisa ser
 *     OBSERVÁVEL aqui);
 *   - STORM (§53, CA15): detector cuspindo volume anômalo na janela curta vs a
 *     própria média — sintoma de laço/ruído (anti-storm é a mitigação; isto é o
 *     DIAGNÓSTICO);
 *   - CALIBRAÇÃO: reusa `SignalCalibrationService.detectorMetrics` (F11) — não
 *     duplica (false-positive/dismissal rate por detector);
 *   - STATUS geral do Radar: ok | watch | degraded, derivado dos sinais acima.
 *
 * Tudo DERIVADO POR QUERY (RN-004) sobre `business_signals` — sem tabela nova
 * (CA1), sem contador mutável. Isolado por org. É leitura de observabilidade:
 * não publica sinal, não executa nada.
 */
import db from "./db.js";
import { SignalCalibrationService, DetectorCalibration } from "./SignalCalibrationService.js";

export interface DetectorHealth {
  detector: string;
  emittedWindow: number;        // emitidos na janela de saúde (curta)
  lastDetectedAt: string | null;
  ageHours: number | null;      // horas desde o último sinal (null se nunca)
  stale: boolean;               // sem emitir há mais que o limite de frescor
  stormRisk: boolean;           // volume recente muito acima da média do detector
  calibration: DetectorCalibration["calibration"] | "unknown";
  falsePositiveRate: number;
  dismissalRate: number;
  status: "ok" | "watch" | "degraded";
}

const round = (n: number, d = 2) => { const f = Math.pow(10, d); return Math.round((Number(n) || 0) * f) / f; };

export class RadarHealthService {
  /**
   * Panorama de saúde do Radar. `windowHours` = janela curta pra volume/storm
   * (default 24h). `staleHours` = sem emitir há mais que isso → stale (default
   * 72h). `calibrationDays` = janela da calibração F11 (default 30d). `now`
   * injetável pra teste.
   */
  static overview(orgId: string, opts: { windowHours?: number; staleHours?: number; calibrationDays?: number; now?: number } = {}): any {
    const windowHours = Number(opts.windowHours) > 0 ? Number(opts.windowHours) : 24;
    const staleHours = Number(opts.staleHours) > 0 ? Number(opts.staleHours) : 72;
    const calibrationDays = opts.calibrationDays === undefined ? 30 : Number(opts.calibrationDays);
    const now = opts.now ?? Date.now();
    const nowIso = new Date(now).toISOString();

    // ── Volume por status / severidade / domínio (todo o histórico da org; o
    // pulso do Radar não é só da janela curta — status agregado importa).
    const byStatus = this.countBy(orgId, "status");
    const bySeverity = this.countBy(orgId, "severity");
    const byDomain = this.countBy(orgId, "domain");
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    // ── Freshness + volume da janela por detector (source_service).
    const winSql = `datetime('now', ?)`; // parametrizado abaixo
    const perDetector = db.prepare(
      `SELECT COALESCE(source_service,'?') AS detector,
              COUNT(*) AS total,
              MAX(detected_at) AS lastDetectedAt,
              SUM(CASE WHEN detected_at >= ${winSql} THEN 1 ELSE 0 END) AS emittedWindow
         FROM business_signals WHERE organization_id = ?
        GROUP BY detector`
    ).all(`-${windowHours} hours`, orgId) as any[];

    // Calibração F11 (não duplica): mapa detector → métricas.
    const calib = SignalCalibrationService.detectorMetrics(orgId, { days: calibrationDays });
    const calibByDetector = new Map<string, DetectorCalibration>(calib.detectors.map((d) => [d.detector, d]));

    const HOUR_MS = 3600 * 1000;
    const detectors: DetectorHealth[] = perDetector.map((r): DetectorHealth => {
      const last = r.lastDetectedAt ? Date.parse(String(r.lastDetectedAt).replace(" ", "T") + (String(r.lastDetectedAt).endsWith("Z") ? "" : "Z")) : NaN;
      const ageHours = Number.isFinite(last) ? Math.max(0, round((now - last) / HOUR_MS, 1)) : null;
      const stale = ageHours != null && ageHours > staleHours;
      const totalDet = Number(r.total) || 0;
      const emittedWindow = Number(r.emittedWindow) || 0;
      // Storm: a janela curta (windowHours) concentra volume MUITO acima do que a
      // taxa média histórica do detector projetaria pra essa mesma janela. Só
      // acusa com massa mínima (evita falso storm em detector novo/raro).
      const cal = calibByDetector.get(r.detector);
      const emittedCalib = cal?.emitted || 0;
      const expectedPerWindow = calibrationDays > 0 ? (emittedCalib / (calibrationDays * 24)) * windowHours : 0;
      const stormRisk = emittedWindow >= 5 && expectedPerWindow > 0 && emittedWindow > expectedPerWindow * 3;

      const calibration: DetectorHealth["calibration"] = cal?.calibration || "unknown";
      const falsePositiveRate = cal?.falsePositiveRate ?? 0;
      const dismissalRate = cal?.dismissalRate ?? 0;
      // Status do detector: degraded se mal calibrado OU storm; watch se stale OU
      // dismissalRate alto; senão ok.
      const status: DetectorHealth["status"] =
        calibration === "poor" || stormRisk ? "degraded" :
        stale || calibration === "watch" ? "watch" : "ok";

      return { detector: r.detector, emittedWindow, lastDetectedAt: r.lastDetectedAt || null, ageHours, stale, stormRisk, calibration, falsePositiveRate, dismissalRate, status };
    }).sort((a, b) => rankStatus(a.status) - rankStatus(b.status) || b.emittedWindow - a.emittedWindow);

    // ── Status geral do Radar.
    const degraded = detectors.filter((d) => d.status === "degraded").length;
    const watch = detectors.filter((d) => d.status === "watch").length;
    const overall: "ok" | "watch" | "degraded" = degraded > 0 ? "degraded" : watch > 0 ? "watch" : "ok";

    return {
      generatedAt: nowIso,
      windowHours, staleHours, calibrationDays: calibrationDays > 0 ? calibrationDays : null,
      overall,
      totals: { total, open: byStatus.open || 0, byStatus, bySeverity, byDomain },
      detectorSummary: { total: detectors.length, ok: detectors.length - degraded - watch, watch, degraded, stale: detectors.filter((d) => d.stale).length, storm: detectors.filter((d) => d.stormRisk).length },
      detectors,
    };
  }

  private static countBy(orgId: string, col: "status" | "severity" | "domain"): Record<string, number> {
    // `col` é allowlist fechada (nunca vem do usuário) — sem risco de injeção.
    const rows = db.prepare(`SELECT ${col} AS k, COUNT(*) AS n FROM business_signals WHERE organization_id = ? GROUP BY ${col}`).all(orgId) as any[];
    const out: Record<string, number> = {};
    for (const r of rows) out[String(r.k ?? "?")] = Number(r.n) || 0;
    return out;
  }
}

function rankStatus(s: string): number { return s === "degraded" ? 0 : s === "watch" ? 1 : 2; }

export default RadarHealthService;
