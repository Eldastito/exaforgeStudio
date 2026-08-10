import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * SecurityAnomalyDetectorService (ADR-159 F6 / D6, parte 2).
 *
 * Detector de comportamento anômalo — DERIVADO por query (RN-004, sem contador
 * mutável) e publicado em `business_signals` (convenção nº 12, SEM tabela de
 * alerta própria). O sinal fino de anomalia aqui é uma RAJADA DE EXECUÇÕES
 * GOVERNADAS FALHAS numa janela: alguém (ou algo) martelando o choke-point —
 * autonomia insuficiente, modo bloqueado, reprocessamento de ação terminal,
 * step-up recusado — em volume acima do normal. Tudo em `action_execution_log`
 * (mode='execute', status='failed'), isolado por org.
 *
 * Advisory (RN-014): sugere investigação; o humano decide. Opt-in por org
 * (`anomaly_detector_enabled`). SWEEP: quando a org volta ao normal (abaixo do
 * limiar na janela), o sinal aberto é resolvido (molde do ChurnRiskDetector).
 */

const DEFAULT_WINDOW_HOURS = 6;
const DEFAULT_THRESHOLD = 10; // execuções falhas na janela pra virar anomalia

export class SecurityAnomalyDetectorService {
  /** Avalia UMA org: publica ou resolve o sinal de anomalia conforme a janela. */
  static evaluate(orgId: string, opts: { windowHours?: number; threshold?: number } = {}): { published: number; resolved: number } {
    const windowHours = Number(opts.windowHours ?? DEFAULT_WINDOW_HOURS);
    const threshold = Number(opts.threshold ?? DEFAULT_THRESHOLD);
    const dedupeKey = `security:failed_exec:${orgId}`;

    const rows = db.prepare(`
      SELECT COALESCE(error_code, 'handler_error') AS code, COUNT(*) AS n
        FROM action_execution_log
       WHERE organization_id = ? AND mode = 'execute' AND status = 'failed'
         AND started_at >= datetime('now', ?)
       GROUP BY code
    `).all(orgId, `-${windowHours} hours`) as any[];
    const total = rows.reduce((s, r) => s + Number(r.n), 0);

    if (total < threshold) {
      // Voltou ao normal → resolve o sinal aberto (no-op se não existe/aberto).
      const r = BusinessSignalService.resolveByDedupe(orgId, dedupeKey);
      return { published: 0, resolved: r.ok ? 1 : 0 };
    }

    const byErrorCode = rows.sort((a, b) => Number(b.n) - Number(a.n)).map((r) => ({ errorCode: r.code, count: Number(r.n) }));
    const severity = total >= threshold * 3 ? "critical" : total >= threshold * 2 ? "risk" : "attention";
    BusinessSignalService.publish(orgId, {
      domain: "security", signalType: "anomalous_behavior", severity,
      basis: "fact", confidence: 1,
      impactAmount: total, impactUnit: "count",
      sourceService: "SecurityAnomalyDetectorService",
      sourceEntityType: "org", sourceEntityId: orgId,
      evidence: {
        kind: "failed_governed_executions", windowHours, threshold, failedCount: total, byErrorCode,
        nota: "Rajada de execuções governadas FALHAS na janela — pode indicar alguém martelando o choke-point (autonomia insuficiente / modo bloqueado / step-up recusado). Advisory: humano investiga (RN-014).",
      },
      dedupeKey,
    });
    return { published: 1, resolved: 0 };
  }

  /** Varre orgs opt-in (`anomaly_detector_enabled=1`). Best-effort. */
  static runAll(): { orgs: number; published: number; resolved: number } {
    const orgs = db.prepare("SELECT organization_id AS orgId FROM organization_settings WHERE COALESCE(anomaly_detector_enabled, 0) = 1").all() as any[];
    let published = 0, resolved = 0;
    for (const o of orgs) {
      try { const r = this.evaluate(String(o.orgId)); published += r.published; resolved += r.resolved; }
      catch (e) { console.error("[Security F6] anomaly detector falhou pra org", o.orgId, e); }
    }
    return { orgs: orgs.length, published, resolved };
  }
}

export default SecurityAnomalyDetectorService;
