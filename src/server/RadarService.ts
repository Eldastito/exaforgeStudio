import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logRadarEvent } from "./radarAudit.js";
import { PILLAR_WEIGHTS, SCORING_VERSION, Pillar, calculateAndPersist } from "./RadarScoringEngine.js";

// ZappFlow Radar de Execução IA — Fase 1 (fundação de dados) + Fase 2 (o motor
// de score em si mora em RadarScoringEngine.ts, compartilhado com o fluxo
// público de RadarPublicService — ver esse arquivo para o "porquê").
//
// Regra não-negociável do PRD (§3): o score é 100% determinístico, versionado
// e auditável — nenhuma IA generativa decide maturidade, prioridade ou risco.
// Este módulo é a fonte de verdade do fluxo AUTENTICADO (sessão sempre presa a
// uma organização); a narrativa em IA (Fase 4, ainda não implementada) só pode
// redigir texto a partir do JSON que o motor produz, nunca alterar os números.

export { PILLAR_WEIGHTS, SCORING_VERSION };
export type { Pillar };

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

  // Motor de score determinístico (PRD §7.1/§7.4) — implementação real em
  // RadarScoringEngine.ts (compartilhada com o fluxo público). Aqui só valida
  // que a sessão pertence à organização autenticada antes de delegar.
  static recalculate(orgId: string, sessionId: string, actorUserId?: string): any {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    calculateAndPersist(sessionId, actorUserId);
    return this.getSession(orgId, sessionId);
  }

  // Respondentes (Fase 3, ADR-014): registro de QUEM mais está ajudando a
  // responder uma sessão além de quem a criou — só cadastro/listagem por
  // enquanto. `radar_respondents` já existia desde a Fase 1 (radar_answers já
  // aceita respondent_id), mas nada expunha essa tabela até agora. Convite
  // por link próprio (respondente sem login do ZappFlow) é uma peça maior,
  // deliberadamente fora desta rodada — ver ADR-014.
  static listRespondents(orgId: string, sessionId: string) {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    return db.prepare(`SELECT * FROM radar_respondents WHERE session_id = ? ORDER BY created_at`).all(sessionId);
  }

  static addRespondent(orgId: string, sessionId: string, actorUserId: string | undefined, payload: any) {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    if (!payload.name || !String(payload.name).trim()) throw new Error("Nome do respondente é obrigatório.");

    const id = randomUUID();
    db.prepare(
      `INSERT INTO radar_respondents (id, session_id, organization_id, name, email, role_title, area, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'invited')`
    ).run(id, sessionId, orgId, payload.name.trim(), payload.email || null, payload.roleTitle || null, payload.area || null);
    logEvent(orgId, actorUserId, "radar_respondent_added", sessionId, { respondentId: id });
    return this.listRespondents(orgId, sessionId);
  }
}
