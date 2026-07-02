import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logRadarEvent } from "./radarAudit.js";

// ZappFlow Radar de Execução IA — Fase 1 (fundação de dados e motor de score).
//
// Regra não-negociável do PRD (§3): o score é 100% determinístico, versionado
// e auditável — nenhuma IA generativa decide maturidade, prioridade ou risco.
// Este serviço é a ÚNICA fonte de verdade do cálculo; a narrativa em IA (Fase 4,
// ainda não implementada) só pode redigir texto a partir do JSON que este
// serviço produz, nunca alterar os números.
//
// Fase 1 só cria sessões PARA A PRÓPRIA organização autenticada (organization_id
// nunca é nulo aqui) — o fluxo de visitante público sem tenant (radar_sessions
// com organization_id NULL) é da Fase 2 (landing pública), ainda não implementada.

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

function maturityLevel(score: number): string {
  if (score < 25) return "inerte";
  if (score < 45) return "experimental";
  if (score < 65) return "organizando";
  if (score < 80) return "integrada";
  return "inteligente";
}

// Wrapper fino sobre o helper compartilhado (src/server/radarAudit.ts), só para
// não precisar tocar em cada um dos call sites abaixo — mantém a assinatura
// "sessionId como 4º argumento" que já era usada neste arquivo.
function logEvent(
  organizationId: string,
  actorUserId: string | null | undefined,
  eventType: string,
  sessionId: string,
  metadata: Record<string, any> = {}
) {
  logRadarEvent(organizationId, actorUserId, eventType, { sessionId, ...metadata });
}

export class RadarService {
  static listTemplates(orgId: string) {
    return db.prepare(
      `SELECT * FROM radar_templates WHERE is_active = 1 AND (organization_id IS NULL OR organization_id = ?)
       ORDER BY organization_id IS NULL DESC, name`
    ).all(orgId);
  }

  static getTemplateWithQuestions(orgId: string, templateId: string) {
    const template = db.prepare(
      `SELECT * FROM radar_templates WHERE id = ? AND (organization_id IS NULL OR organization_id = ?)`
    ).get(templateId, orgId) as any;
    if (!template) return null;
    const questions = db.prepare(
      `SELECT * FROM radar_questions WHERE template_id = ? AND is_active = 1 ORDER BY display_order`
    ).all(templateId) as any[];
    return {
      ...template,
      questions: questions.map((q) => ({ ...q, options: q.options_json ? JSON.parse(q.options_json) : null })),
    };
  }

  static listUseCaseCatalog() {
    return db.prepare(`SELECT * FROM radar_use_case_catalog WHERE is_active = 1 ORDER BY name`).all();
  }

  static listSessions(orgId: string, status?: string) {
    if (status) {
      return db.prepare(
        `SELECT * FROM radar_sessions WHERE organization_id = ? AND status = ? ORDER BY updated_at DESC`
      ).all(orgId, status);
    }
    return db.prepare(`SELECT * FROM radar_sessions WHERE organization_id = ? ORDER BY updated_at DESC`).all(orgId);
  }

  static getSession(orgId: string, id: string): any {
    const session = db.prepare(`SELECT * FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
    if (!session) return null;
    const pillarScores = db.prepare(`SELECT * FROM radar_pillar_scores WHERE session_id = ?`).all(id);
    const recommendations = db.prepare(
      `SELECT r.*, c.code AS use_case_code, c.name AS use_case_name
       FROM radar_recommendations r JOIN radar_use_case_catalog c ON c.id = r.use_case_id
       WHERE r.session_id = ? ORDER BY r.priority_score DESC`
    ).all(id);
    return { ...session, pillarScores, recommendations };
  }

  static createSession(orgId: string, actorUserId: string | undefined, payload: any) {
    const template = db.prepare(
      `SELECT * FROM radar_templates WHERE id = ? AND (organization_id IS NULL OR organization_id = ?) AND is_active = 1`
    ).get(payload.templateId, orgId) as any;
    if (!template) throw new Error("Template de diagnóstico não encontrado.");

    const id = randomUUID();
    db.prepare(
      `INSERT INTO radar_sessions (
        id, organization_id, template_id, session_type, status, source,
        company_name, contact_name, contact_email, contact_phone, segment, company_size,
        city, state, primary_goal, consultant_user_id, owner_user_id, scoring_version,
        started_at, created_by
      ) VALUES (?, ?, ?, ?, 'in_progress', 'tenant', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?)`
    ).run(
      id, orgId, template.id, template.session_type,
      payload.companyName || null, payload.contactName || null, payload.contactEmail || null, payload.contactPhone || null,
      payload.segment || null, payload.companySize || null, payload.city || null, payload.state || null,
      payload.primaryGoal || null, actorUserId || null, actorUserId || null, SCORING_VERSION, actorUserId || null
    );
    logEvent(orgId, actorUserId, "radar_session_created", id, { templateId: template.id });
    logEvent(orgId, actorUserId, "radar_session_started", id, {});
    return this.getSession(orgId, id);
  }

  static updateSession(orgId: string, id: string, patch: any) {
    const existing = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(id, orgId);
    if (!existing) throw new Error("Sessão não encontrada.");

    const fields: string[] = [];
    const values: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); values.push(val); };
    if (patch.companyName !== undefined) set("company_name", patch.companyName);
    if (patch.contactName !== undefined) set("contact_name", patch.contactName);
    if (patch.contactEmail !== undefined) set("contact_email", patch.contactEmail);
    if (patch.contactPhone !== undefined) set("contact_phone", patch.contactPhone);
    if (patch.segment !== undefined) set("segment", patch.segment);
    if (patch.companySize !== undefined) set("company_size", patch.companySize);
    if (patch.city !== undefined) set("city", patch.city);
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.primaryGoal !== undefined) set("primary_goal", patch.primaryGoal);
    if (patch.nextAction !== undefined) set("next_action", patch.nextAction);
    if (!fields.length) return this.getSession(orgId, id);

    fields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(id, orgId);
    db.prepare(`UPDATE radar_sessions SET ${fields.join(", ")} WHERE id = ? AND organization_id = ?`).run(...values);
    return this.getSession(orgId, id);
  }

  static recordConsent(orgId: string, sessionId: string, actorUserId: string | undefined, payload: any) {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    if (!payload.consentType) throw new Error("consentType é obrigatório.");

    const granted = payload.granted !== false;
    db.prepare(
      `INSERT INTO radar_consent_records (id, session_id, organization_id, consent_type, legal_basis_label, version, granted, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(), sessionId, orgId, payload.consentType, payload.legalBasisLabel || null,
      payload.version || "v1", granted ? 1 : 0, granted ? null : new Date().toISOString()
    );
    if (granted) {
      db.prepare(`UPDATE radar_sessions SET consent_version = ?, consent_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`)
        .run(payload.version || "v1", sessionId, orgId);
    }
    logEvent(orgId, actorUserId, granted ? "radar_consent_granted" : "radar_consent_revoked", sessionId, {
      consentType: payload.consentType,
    });
    return { success: true };
  }

  // Grava (ou atualiza) a resposta de UMA pergunta. Idempotente por
  // (session, question, respondent) — reenviar a mesma pergunta atualiza, não duplica.
  static saveAnswer(orgId: string, sessionId: string, actorUserId: string | undefined, payload: any) {
    const session = db.prepare(`SELECT * FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId) as any;
    if (!session) throw new Error("Sessão não encontrada.");
    if (!["draft", "in_progress", "needs_information"].includes(session.status)) {
      throw new Error("Esta sessão não aceita novas respostas no status atual.");
    }
    const question = db.prepare(`SELECT * FROM radar_questions WHERE id = ? AND template_id = ?`)
      .get(payload.questionId, session.template_id) as any;
    if (!question) throw new Error("Pergunta não pertence ao template desta sessão.");

    const isNotKnown = !!payload.isNotKnown;
    const hasComment = !!(payload.comment && String(payload.comment).trim().length > 0);
    let scoreRaw: number | null = null;
    // Grau de confiança (PRD §7.4). Fase 1 ainda não tem upload de evidência
    // (radar_evidence é Fase 4), então só os dois primeiros níveis são atingíveis
    // aqui: 0,60 (declarado sem evidência) e 0,75 (declarado + explicação).
    let confidence = 0.6;

    if (isNotKnown) {
      // "Não sei" nunca vira "0" (PRD §6.3) — usa o ponto médio da escala e
      // confiança abaixo do piso declarado, para o relatório sinalizar validação.
      scoreRaw = 2;
      confidence = 0.5;
    } else if (question.answer_type === "scale") {
      const options = question.options_json ? JSON.parse(question.options_json) : [];
      const opt = options.find((o: any) => o.value === payload.value);
      if (!opt) throw new Error("Opção de resposta inválida para esta pergunta.");
      scoreRaw = Number(opt.score);
      confidence = hasComment ? 0.75 : 0.6;
    }
    // answer_type 'text'/'boolean': fica registrado como contexto, mas ainda não
    // pontua pilar nesta fase (evita inventar uma conversão score arbitrária).
    const scoreNormalized = scoreRaw != null ? (scoreRaw / 4) * 100 : null;

    const existing = payload.respondentId
      ? db.prepare(`SELECT id FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id = ?`)
          .get(sessionId, question.id, payload.respondentId) as any
      : db.prepare(`SELECT id FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id IS NULL`)
          .get(sessionId, question.id) as any;

    if (existing) {
      db.prepare(
        `UPDATE radar_answers SET answer_json = ?, score_raw = ?, score_normalized = ?, confidence_multiplier = ?,
         is_not_known = ?, comment = ?, answered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(JSON.stringify(payload.value ?? null), scoreRaw, scoreNormalized, confidence, isNotKnown ? 1 : 0, payload.comment || null, existing.id);
    } else {
      db.prepare(
        `INSERT INTO radar_answers (
          id, session_id, organization_id, question_id, respondent_id, answer_json,
          score_raw, score_normalized, confidence_multiplier, is_not_known, comment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        randomUUID(), sessionId, orgId, question.id, payload.respondentId || null, JSON.stringify(payload.value ?? null),
        scoreRaw, scoreNormalized, confidence, isNotKnown ? 1 : 0, payload.comment || null
      );
    }
    logEvent(orgId, actorUserId, "radar_answer_saved", sessionId, { questionId: question.id });
    return { success: true };
  }

  static completeSession(orgId: string, sessionId: string, actorUserId?: string) {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    db.prepare(
      `UPDATE radar_sessions SET status = 'awaiting_review', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND organization_id = ?`
    ).run(sessionId, orgId);
    logEvent(orgId, actorUserId, "radar_session_completed", sessionId, {});
    return this.recalculate(orgId, sessionId, actorUserId);
  }

  // Motor de score determinístico (PRD §7.1/§7.4). Recalculável a qualquer
  // momento (ex.: depois de novas respostas) sem depender de LLM.
  static recalculate(orgId: string, sessionId: string, actorUserId?: string): any {
    const session = db.prepare(`SELECT * FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId) as any;
    if (!session) throw new Error("Sessão não encontrada.");

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
       WHERE id = ? AND organization_id = ?`
    ).run(overallScore, confidenceScore, level, SCORING_VERSION, sessionId, orgId);

    logEvent(orgId, actorUserId, "radar_score_calculated", sessionId, { overallScore, confidenceScore, level });

    this.generateRecommendations(orgId, sessionId, actorUserId, pillarScores, confidenceScore);

    return this.getSession(orgId, sessionId);
  }

  // Motor de priorização determinístico (PRD §9.3), adaptado à Fase 1: como
  // radar_processes (matriz impacto/esforço declarada pelo consultor) só chega
  // na Fase 3, os componentes de impacto/prontidão vêm dos SCORES DE PILAR desta
  // sessão — heurística explícita e documentada, não uma "opinião" da IA.
  private static generateRecommendations(
    orgId: string,
    sessionId: string,
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
    logEvent(orgId, actorUserId, "radar_recommendation_generated", sessionId, { count: catalog.length });
  }
}
