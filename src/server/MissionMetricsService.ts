import db from "./db.js";
import { MissionService } from "./MissionService.js";

/**
 * MissionMetricsService — ADR-189 F20 (Mission OS): KPIs do PILOTO, derivados por query (RN-004).
 *
 * Um piloto que não se mede não é piloto. Todo PRD grande do repo fecha com um serviço de métricas
 * (DecisionMetrics, OutcomeAssuranceMetrics, LearningMetrics) — o Mission OS ganha o seu. É a lente
 * pra responder "o Mission Layer está produzindo resultado?": quantas missões, quantas concluíram,
 * quantas estão em risco, quantas viraram ação governada, de onde vêm (humano/proposto/gerado).
 *
 * DERIVADO por query (RN-004 — nunca contador mutável). HONESTO (RN-MOL): percentual sem denominador
 * é `null`, nunca 0 (não inventa taxa). Read-only, isolado por org. Composição pura — lê `missions` +
 * `decision_actions` (correlation `mission:<id>`, o fio da F5), sem tabela/serviço novo.
 */

const STATUSES = ["draft", "planning", "ready", "running", "at_risk", "waiting_approval", "blocked", "achieved", "failed", "cancelled"] as const;
const IN_FLIGHT = new Set(["draft", "planning", "ready", "running", "at_risk", "waiting_approval", "blocked"]);
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

export interface MissionMetrics {
  enabled: boolean;
  total: number;
  byStatus: Record<string, number>;
  inFlight: number;
  achieved: number;
  failed: number;
  cancelled: number;
  atRisk: number;
  /** Concluídas ÷ desfechos terminais (achieved+failed). null sem nenhum desfecho (não inventa taxa). */
  achievedRatePct: number | null;
  bySource: Record<string, number>;
  byAutonomy: Record<string, number>;
  /** Missões com ≥1 ação GOVERNADA proposta (fio correlation mission:<id>). */
  withGovernedAction: number;
  /** % das missões que já viraram ação governada. null sem missões. */
  governedActionRatePct: number | null;
  /** Confiança média das missões que a declararam. null se nenhuma tem confiança (null ≠ 0). */
  avgConfidence: number | null;
}

export class MissionMetricsService {
  static metrics(orgId: string): MissionMetrics {
    const enabled = MissionService.isEnabled(orgId);

    const rows = db.prepare(`SELECT mission_status AS s, COUNT(*) c FROM missions WHERE organization_id = ? GROUP BY mission_status`).all(orgId) as any[];
    const byStatus: Record<string, number> = {};
    for (const st of STATUSES) byStatus[st] = 0;
    let total = 0, inFlight = 0;
    for (const r of rows) {
      const s = String(r.s || "draft"); const c = Number(r.c) || 0;
      byStatus[s] = (byStatus[s] || 0) + c; total += c;
      if (IN_FLIGHT.has(s)) inFlight += c;
    }
    const achieved = byStatus.achieved || 0;
    const failed = byStatus.failed || 0;
    const cancelled = byStatus.cancelled || 0;
    const atRisk = byStatus.at_risk || 0;

    const bySource: Record<string, number> = {};
    for (const r of db.prepare(`SELECT source AS s, COUNT(*) c FROM missions WHERE organization_id = ? GROUP BY source`).all(orgId) as any[]) {
      bySource[String(r.s || "user")] = Number(r.c) || 0;
    }
    const byAutonomy: Record<string, number> = {};
    for (const r of db.prepare(`SELECT autonomy_level AS a, COUNT(*) c FROM missions WHERE organization_id = ? GROUP BY autonomy_level`).all(orgId) as any[]) {
      byAutonomy[String(r.a || "off")] = Number(r.c) || 0;
    }

    // Missões distintas com ao menos uma ação governada (correlation mission:<id>).
    let withGovernedAction = 0;
    try {
      withGovernedAction = Number((db.prepare(`
        SELECT COUNT(DISTINCT m.id) n FROM missions m
        WHERE m.organization_id = ? AND EXISTS (
          SELECT 1 FROM decision_actions d
          WHERE d.organization_id = m.organization_id AND d.correlation_id = 'mission:' || m.id
        )`).get(orgId) as any).n) || 0;
    } catch { withGovernedAction = 0; }

    // Confiança média só das que a declararam (null ≠ 0).
    let avgConfidence: number | null = null;
    try {
      const r = db.prepare(`SELECT AVG(confidence) a, COUNT(confidence) n FROM missions WHERE organization_id = ? AND confidence IS NOT NULL`).get(orgId) as any;
      if (r && Number(r.n) > 0) avgConfidence = Math.round(Number(r.a) * 100) / 100;
    } catch { avgConfidence = null; }

    return {
      enabled, total, byStatus, inFlight, achieved, failed, cancelled, atRisk,
      achievedRatePct: pct(achieved, achieved + failed),
      bySource, byAutonomy,
      withGovernedAction,
      governedActionRatePct: pct(withGovernedAction, total),
      avgConfidence,
    };
  }
}

export default MissionMetricsService;
