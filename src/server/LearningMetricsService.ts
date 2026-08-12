/**
 * LearningMetricsService — PRD 9 / ADR-166 F13 (§9, RN-004, RN-EL-5).
 *
 * KPIs do aprendizado ENTERPRISE, todos DERIVADOS por query (nunca contador
 * mutável): quantos padrões existem, quantos têm PROVA ASSEGURADA, qual a
 * distribuição de estados de aprendizado, a procedência dos desfechos (manual ×
 * assured) e o decay/drift (dormência, refutações sugeridas). Read-only, isolado
 * por `organization_id`.
 *
 * Honesto (RN-EL-5): percentuais são `null` quando não há denominador (sem padrões
 * validados → coberturaAssegurada null, não 0%). "não medimos" ≠ "medimos zero".
 */
import db from "./db.js";
import { PatternMemoryService } from "./PatternMemoryService.js";

function pct(n: number, d: number): number | null {
  if (!d || d <= 0) return null;
  return Math.round((n / d) * 1000) / 10; // 1 casa
}

export class LearningMetricsService {
  static metrics(orgId: string): any {
    if (!orgId) return { patterns: 0 };

    // ── inventário de padrões por status ──
    const byStatus = db.prepare(
      `SELECT status, COUNT(*) c FROM business_patterns WHERE organization_id = ? GROUP BY status`
    ).all(orgId) as any[];
    const statusCounts: Record<string, number> = { candidate: 0, validated: 0, dormant: 0, refuted: 0 };
    for (const r of byStatus) statusCounts[r.status] = Number(r.c) || 0;
    const totalPatterns = Object.values(statusCounts).reduce((a, b) => a + b, 0);

    // ── procedência dos desfechos (F1 ledger): manual × assured ──
    const bySource = db.prepare(
      `SELECT source, COUNT(*) c FROM business_pattern_outcomes WHERE organization_id = ? GROUP BY source`
    ).all(orgId) as any[];
    const outcomeCounts: Record<string, number> = { manual: 0, assured: 0 };
    for (const r of bySource) outcomeCounts[r.source] = Number(r.c) || 0;
    const totalOutcomes = outcomeCounts.manual + outcomeCounts.assured;

    // ── estados de aprendizado + cobertura assegurada (deriva do LearningEpisode) ──
    // Percorre os VALIDATED (os que valem como padrão de fato) e classifica pelo
    // recorte assegurado (F2/F3). Cobertura = quantos têm prova assegurada.
    const validated = db.prepare(
      `SELECT DISTINCT domain, pattern_type FROM business_patterns WHERE organization_id = ? AND status = 'validated'`
    ).all(orgId) as any[];
    const learningStates: Record<string, number> = { unproven: 0, reinforced: 0, weakened: 0, contested: 0 };
    let withAssured = 0, suggestedRefutations = 0, effSum = 0, effN = 0;
    for (const v of validated) {
      const a = PatternMemoryService.assuredStats(orgId, v.domain, v.pattern_type);
      if (a.assuredActed === 0) { learningStates.unproven++; continue; }
      withAssured++;
      if (a.assuredEffectiveness != null) { effSum += a.assuredEffectiveness; effN++; }
      const eff = a.assuredEffectiveness ?? 0;
      if (eff >= 0.66) learningStates.reinforced++;
      else if (eff <= 0.34) learningStates.weakened++;
      else learningStates.contested++;
      if (a.assuredActed >= 2 && a.backfired > a.worked) suggestedRefutations++;
    }
    const validatedTypes = validated.length;

    return {
      patterns: totalPatterns,
      byStatus: statusCounts,
      outcomes: { total: totalOutcomes, ...outcomeCounts, assuredSharePct: pct(outcomeCounts.assured, totalOutcomes) },
      learning: {
        validatedTypes,
        withAssuredEvidence: withAssured,
        // Coração do PRD 9: quanto do aprendizado tem PROVA (assured) vs só recorrência.
        assuredCoveragePct: pct(withAssured, validatedTypes),
        states: learningStates,
        avgAssuredEffectiveness: effN > 0 ? Math.round((effSum / effN) * 100) / 100 : null,
        suggestedRefutations,
      },
      drift: {
        // decay/drift: dormência é o sinal de padrões que pararam de reaparecer.
        dormant: statusCounts.dormant,
        dormantPct: pct(statusCounts.dormant, totalPatterns),
        contested: learningStates.contested,
      },
      note: "KPIs DERIVADOS por query (RN-004); percentuais null sem denominador (RN-EL-5, não inventa 0%).",
    };
  }
}

export default LearningMetricsService;
