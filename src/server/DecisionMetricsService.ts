import db from "./db.js";

/**
 * DecisionMetricsService — métricas do loop fechado (DI-3, aditivo sobre
 * ADR-136/152). Ver docs/decision-intelligence/PLANO-E-FATIAS.md.
 *
 * Fecha o ciclo Decidir → Executar → Monitorar → Aprender medindo, de forma
 * DETERMINÍSTICA (zero-token) e DERIVADA por query (RN-004, sem contador
 * mutável), o que o PRD §36 pede — com destaque para o "valor protegido pelo
 * ZapFlow", argumento comercial de renovação:
 *
 *   - valueProtected: prejuízo evitado + custo evitado (+ receita recuperada),
 *     somados de `action_outcomes` (colunas aditivas da ADR-152 F3.1).
 *   - predictionAccuracy: quão perto o realizado ficou do esperado
 *     (`action_outcomes.expected_value` × `realized_value`).
 *   - riskMaterializationRate: dos riscos previstos (`decision_risks`, DI-2),
 *     quantos materializaram.
 *   - recommendationAcceptance: das recomendações da IA/regra (`decision_actions`
 *     created_by ai|rule), quantas foram aceitas (approved|done) vs rejeitadas.
 *   - evidenceCache.hitRate: acerto do cache do Evidence Layer
 *     (`evidence_cache_events`, DI-3).
 *
 * NÃO recalcula nada dos motores; só agrega o que já foi medido. Isolado por
 * organization_id (convenção nº 1). Janela em dias (default 365 — "últimos 12
 * meses" do PRD §36).
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

export class DecisionMetricsService {
  static summary(orgId: string, opts: { days?: number } = {}): any {
    const days = Math.max(1, Math.min(3650, Number(opts.days) || 365));
    const since = `datetime('now','-${days} days')`;

    // ── Valor protegido / gerado (action_outcomes) ──────────────────────────
    const v = db.prepare(`
      SELECT
        COALESCE(SUM(loss_prevented), 0) AS lossPrevented,
        COALESCE(SUM(cost_avoided), 0) AS costAvoided,
        COALESCE(SUM(revenue_recovered), 0) AS revenueRecovered,
        COALESCE(SUM(time_saved_minutes), 0) AS timeSavedMinutes,
        COUNT(*) AS outcomes
      FROM action_outcomes
      WHERE organization_id = ? AND measured_at >= ${since}
    `).get(orgId) as any;
    const protectedTotal = round2((Number(v.lossPrevented) || 0) + (Number(v.costAvoided) || 0));

    // ── Acurácia de previsão (esperado × realizado) ─────────────────────────
    const acc = db.prepare(`
      SELECT expected_value AS e, realized_value AS r
      FROM action_outcomes
      WHERE organization_id = ? AND measured_at >= ${since}
        AND expected_value IS NOT NULL AND realized_value IS NOT NULL AND expected_value <> 0
    `).all(orgId) as any[];
    let accuracyScore: number | null = null;
    if (acc.length) {
      const sum = acc.reduce((s, o) => s + (1 - Math.min(1, Math.abs((Number(o.e) || 0) - (Number(o.r) || 0)) / Math.abs(Number(o.e) || 1))), 0);
      accuracyScore = round2(clamp01(sum / acc.length));
    }

    // ── Materialização de riscos previstos (decision_risks, DI-2) ────────────
    const risk = db.prepare(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status='predicted' THEN 1 ELSE 0 END) AS predicted,
        SUM(CASE WHEN status='materialized' THEN 1 ELSE 0 END) AS materialized,
        SUM(CASE WHEN status='resolved' THEN 1 ELSE 0 END) AS resolved
      FROM decision_risks
      WHERE organization_id = ? AND predicted_at >= ${since}
    `).get(orgId) as any;
    const riskTotal = Number(risk.total) || 0;
    const materializationRate = riskTotal > 0 ? round2((Number(risk.materialized) || 0) / riskTotal) : null;

    // ── Aceitação de recomendações (decision_actions da IA/regra) ────────────
    const rec = db.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('approved','done') THEN 1 ELSE 0 END) AS accepted,
        SUM(CASE WHEN status='rejected' THEN 1 ELSE 0 END) AS rejected,
        SUM(CASE WHEN status<>'cancelled' THEN 1 ELSE 0 END) AS considered
      FROM decision_actions
      WHERE organization_id = ? AND created_by IN ('ai','rule') AND created_at >= ${since}
    `).get(orgId) as any;
    const decided = (Number(rec.accepted) || 0) + (Number(rec.rejected) || 0);
    const acceptanceRate = decided > 0 ? round2((Number(rec.accepted) || 0) / decided) : null;

    // ── Cache do Evidence Layer (evidence_cache_events, DI-3) ────────────────
    const cache = db.prepare(`
      SELECT SUM(CASE WHEN hit=1 THEN 1 ELSE 0 END) AS hits, SUM(CASE WHEN hit=0 THEN 1 ELSE 0 END) AS misses
      FROM evidence_cache_events WHERE organization_id = ? AND created_at >= ${since}
    `).get(orgId) as any;
    const hits = Number(cache.hits) || 0;
    const misses = Number(cache.misses) || 0;
    const hitRate = hits + misses > 0 ? round2(hits / (hits + misses)) : null;

    return {
      period: { days },
      valueProtected: {
        currency: "BRL",
        lossPrevented: round2(v.lossPrevented),
        costAvoided: round2(v.costAvoided),
        revenueRecovered: round2(v.revenueRecovered),
        protectedTotal,                                  // prejuízo + custo evitado
        generatedTotal: round2(v.revenueRecovered),      // receita recuperada
        timeSavedMinutes: Number(v.timeSavedMinutes) || 0,
        outcomes: Number(v.outcomes) || 0,
      },
      predictionAccuracy: { score: accuracyScore, samples: acc.length },
      riskMaterialization: {
        total: riskTotal,
        predicted: Number(risk.predicted) || 0,
        materialized: Number(risk.materialized) || 0,
        resolved: Number(risk.resolved) || 0,
        rate: materializationRate,
      },
      recommendationAcceptance: {
        accepted: Number(rec.accepted) || 0,
        rejected: Number(rec.rejected) || 0,
        considered: Number(rec.considered) || 0,
        rate: acceptanceRate,
      },
      evidenceCache: { hits, misses, hitRate },
      generatedAt: new Date().toISOString(),
    };
  }
}

export default DecisionMetricsService;
