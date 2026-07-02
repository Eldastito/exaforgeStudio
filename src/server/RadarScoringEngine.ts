import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logRadarEvent } from "./radarAudit.js";

// Motor de score determinístico ÚNICO do Radar — extraído de RadarService
// para que o fluxo autenticado (RadarService, Fase 1) e o fluxo público
// (RadarPublicService, Fase 2) usem exatamente a mesma fórmula, sem duas
// cópias que podem divergir com o tempo.
//
// Regra não-negociável do PRD (§3): o score é 100% determinístico, versionado
// e auditável — nenhuma IA generativa decide maturidade, prioridade ou risco.
//
// IMPORTANTE: este módulo NÃO faz nenhuma checagem de propriedade/autorização
// — quem chama (`RadarService` para sessões de tenant, `RadarPublicService`
// para sessões públicas por token) já validou que tem direito de recalcular
// esta sessão específica antes de invocar `calculateAndPersist`.

export type Pillar =
  | "estrategia" | "receita" | "processos" | "dados" | "pessoas" | "governanca" | "metricas";

// Pesos dos 7 pilares (somam 100) — PRD §6.
export const PILLAR_WEIGHTS: Record<Pillar, number> = {
  estrategia: 10,
  receita: 20,
  processos: 20,
  dados: 15,
  pessoas: 15,
  governanca: 10,
  metricas: 10,
};

// Versão do motor de cálculo. Incrementar sempre que a fórmula de score ou de
// priorização mudar, para que relatórios antigos continuem explicáveis (PRD §7.1).
export const SCORING_VERSION = 1;

export function maturityLevel(score: number): string {
  if (score < 25) return "inerte";
  if (score < 45) return "experimental";
  if (score < 65) return "organizando";
  if (score < 80) return "integrada";
  return "inteligente";
}

const clamp = (n: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, n));

// Motor de score determinístico (PRD §7.1/§7.4). Recalculável a qualquer
// momento (ex.: depois de novas respostas) sem depender de LLM. `orgId` da
// sessão pode ser NULL (sessão pública pré-conversão, Fase 2).
export function calculateAndPersist(sessionId: string, actorUserId?: string): void {
  const session = db.prepare(`SELECT * FROM radar_sessions WHERE id = ?`).get(sessionId) as any;
  if (!session) throw new Error("Sessão não encontrada.");
  const orgId: string | null = session.organization_id;

  const rows = db.prepare(
    `SELECT a.score_raw, a.confidence_multiplier, q.pillar, q.weight
     FROM radar_answers a JOIN radar_questions q ON q.id = a.question_id
     WHERE a.session_id = ? AND a.score_raw IS NOT NULL`
  ).all(sessionId) as any[];

  const pillars = Object.keys(PILLAR_WEIGHTS) as Pillar[];
  const agg: Record<string, { weighted: number; weightSum: number; count: number }> = {};
  for (const p of pillars) agg[p] = { weighted: 0, weightSum: 0, count: 0 };
  let confidenceTotal = 0;
  let confidenceCount = 0;

  for (const r of rows) {
    const a = agg[r.pillar as Pillar];
    if (!a) continue; // pilar fora do catálogo padrão (defensivo)
    const weight = r.weight || 1;
    a.weighted += r.score_raw * weight;
    a.weightSum += weight;
    a.count += 1;
    confidenceTotal += r.confidence_multiplier;
    confidenceCount += 1;
  }

  const confidenceScore = confidenceCount > 0 ? Math.round((confidenceTotal / confidenceCount) * 100) / 100 : null;
  const pillarScores: { pillar: Pillar; score: number | null; evidenceCount: number }[] = [];
  let maturityWeighted = 0;
  let maturityWeightSum = 0;
  for (const pillar of pillars) {
    const a = agg[pillar];
    const score = a.weightSum > 0 ? Math.round(((a.weighted / a.weightSum / 4) * 100) * 10) / 10 : null;
    pillarScores.push({ pillar, score, evidenceCount: a.count });
    if (score != null) {
      maturityWeighted += score * PILLAR_WEIGHTS[pillar];
      maturityWeightSum += PILLAR_WEIGHTS[pillar];
    }
  }
  // Pilares ainda sem resposta são excluídos e os pesos renormalizados — um
  // pilar não respondido NUNCA é tratado como "0" (isso inflaria o gap
  // artificialmente antes do questionário estar completo).
  const overallScore = maturityWeightSum > 0 ? Math.round((maturityWeighted / maturityWeightSum) * 10) / 10 : null;
  const level = overallScore != null ? maturityLevel(overallScore) : null;

  const upsertPillar = db.prepare(
    `INSERT INTO radar_pillar_scores (id, session_id, organization_id, pillar, score, confidence_score, evidence_count, calculation_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id, pillar) DO UPDATE SET
       score = excluded.score, confidence_score = excluded.confidence_score,
       evidence_count = excluded.evidence_count, calculation_json = excluded.calculation_json,
       updated_at = CURRENT_TIMESTAMP`
  );
  for (const p of pillarScores) {
    upsertPillar.run(
      randomUUID(), sessionId, orgId, p.pillar, p.score, confidenceScore, p.evidenceCount,
      JSON.stringify({ weight: PILLAR_WEIGHTS[p.pillar], scoringVersion: SCORING_VERSION })
    );
  }

  db.prepare(
    `UPDATE radar_sessions SET overall_maturity_score = ?, confidence_score = ?, maturity_level = ?, scoring_version = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(overallScore, confidenceScore, level, SCORING_VERSION, sessionId);

  logRadarEvent(orgId, actorUserId, "radar_score_calculated", { sessionId, overallScore, confidenceScore, level });

  generateRecommendations(sessionId, orgId, actorUserId, pillarScores, confidenceScore);
}

// Motor de priorização determinístico (PRD §9.3), adaptado à Fase 1: como
// radar_processes (matriz impacto/esforço declarada pelo consultor) só chega
// na Fase 3, os componentes de impacto/prontidão vêm dos SCORES DE PILAR desta
// sessão — heurística explícita e documentada, não uma "opinião" da IA.
function generateRecommendations(
  sessionId: string,
  orgId: string | null,
  actorUserId: string | undefined,
  pillarScores: { pillar: Pillar; score: number | null }[],
  sessionConfidence: number | null
) {
  const scoreOf = (p: Pillar) => pillarScores.find((x) => x.pillar === p)?.score ?? 50; // 50 = neutro se pilar ainda sem resposta
  const confidence = sessionConfidence ?? 0.6;
  const governanceScore = scoreOf("governanca");

  const easeByComplexity: Record<string, number> = { low: 85, medium: 60, high: 35 };
  const riskBaseByProfile: Record<string, number> = { low: 5, medium: 15, high: 30 };

  const catalog = db.prepare(`SELECT * FROM radar_use_case_catalog WHERE is_active = 1`).all() as any[];

  db.prepare(`DELETE FROM radar_recommendations WHERE session_id = ?`).run(sessionId);
  const insert = db.prepare(
    `INSERT INTO radar_recommendations (
      id, session_id, organization_id, use_case_id, priority_score, priority_band,
      impact_score, effort_score, risk_score, readiness_score, confidence_score,
      rationale_json, prerequisites_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const useCase of catalog) {
    let meta: any = {};
    try { meta = useCase.metrics_json ? JSON.parse(useCase.metrics_json) : {}; } catch { meta = {}; }
    const primaryPillar: Pillar = PILLAR_WEIGHTS[meta.primaryPillar as Pillar] ? meta.primaryPillar : "processos";

    const businessImpact = 100 - scoreOf(primaryPillar); // quanto pior o pilar, maior a oportunidade de ganho
    const dataReadiness = scoreOf("dados");
    const processStandardization = scoreOf("processos");
    const teamReadiness = scoreOf("pessoas");
    const implementationEase = easeByComplexity[useCase.complexity] ?? 60;
    const strategicAlignment = scoreOf("estrategia");
    const riskBase = riskBaseByProfile[useCase.risk_profile] ?? 15;
    // Governança madura reduz a penalidade de risco em até 50%; governança
    // fraca (score baixo) mantém a penalidade quase integral.
    const riskPenalty = Math.round(riskBase * (1 - governanceScore / 200) * 10) / 10;

    const priorityScore = Math.round((
      businessImpact * 0.35 +
      dataReadiness * 0.15 +
      processStandardization * 0.15 +
      teamReadiness * 0.10 +
      implementationEase * 0.15 +
      strategicAlignment * 0.10 -
      riskPenalty
    ) * 10) / 10;

    // Gate de "prioridade alta" simplificado (PRD §9.3): a Fase 1 ainda não
    // rastreia pré-requisitos/bloqueio de segurança por caso de uso (Fase 3),
    // então o gate aqui verifica só score >= 70 E confiança da sessão >= 0,70
    // (equivalente a "confiança não-baixa" da tabela do §7.4).
    let band: "alta" | "media" | "baixa" = "baixa";
    if (priorityScore >= 70 && confidence >= 0.7) band = "alta";
    else if (priorityScore >= 45) band = "media";

    insert.run(
      randomUUID(), sessionId, orgId, useCase.id, priorityScore, band,
      Math.round(businessImpact), Math.round(100 - implementationEase), Math.round(riskPenalty), Math.round(dataReadiness),
      confidence,
      JSON.stringify({
        primaryPillar, businessImpact, dataReadiness, processStandardization,
        teamReadiness, implementationEase, strategicAlignment, riskPenalty,
        scoringVersion: SCORING_VERSION,
      }),
      useCase.prerequisites_json || null
    );
  }
  logRadarEvent(orgId, actorUserId, "radar_recommendation_generated", { sessionId, count: catalog.length });
}
