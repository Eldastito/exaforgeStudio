import { randomUUID, randomBytes, createHash } from "node:crypto";
import db from "./db.js";
import { logRadarEvent } from "./radarAudit.js";
import { calculateAndPersist } from "./RadarScoringEngine.js";
import { ProspectService } from "./ProspectService.js";

// ZappFlow Radar — Fase 2 (diagnóstico rápido público, landing sem login).
//
// Diferença central em relação a RadarService: aqui a sessão NÃO pertence a
// nenhuma organização ainda (`radar_sessions.organization_id IS NULL` — a
// mesma exceção documentada desde a Fase 1/ADR-009). Autorização não é "sua
// organização é dona desta sessão" — é "você tem o token certo, e ele não
// expirou". Por isso todo método aqui resolve a sessão por TOKEN, nunca por
// orgId, e o cálculo de score é delegado ao MESMO motor determinístico do
// fluxo autenticado (RadarScoringEngine.calculateAndPersist) — nunca uma
// segunda fórmula que poderia divergir.
//
// Retenção (PRD §15.5): sessão pública inacabada expira em 30 dias — depois
// disso o token simplesmente para de resolver (a limpeza física das linhas
// expiradas é um job futuro; o comportamento observável — "link não funciona
// mais" — já está garantido pela checagem de expires_at).

const TOKEN_TTL_DAYS = 30;
const CONSENT_VERSION = "v1";

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export class RadarPublicService {
  /** Template público único (o global "Diagnóstico Rápido ZappFlow" semeado no boot). */
  static getDefaultTemplate(): any {
    const template = db.prepare(
      `SELECT * FROM radar_templates WHERE organization_id IS NULL AND session_type = 'quick' AND is_active = 1
       ORDER BY created_at ASC LIMIT 1`
    ).get() as any;
    if (!template) throw new Error("Nenhum template público de diagnóstico rápido disponível.");
    const questions = db.prepare(
      `SELECT * FROM radar_questions WHERE template_id = ? AND is_active = 1 ORDER BY display_order`
    ).all(template.id) as any[];
    return {
      ...template,
      questions: questions.map((q) => ({ ...q, options: q.options_json ? JSON.parse(q.options_json) : null })),
    };
  }

  /**
   * Cria uma sessão pública (sem organização) e devolve o token em TEXTO PLANO
   * — a única vez que ele existe fora do formato hash. O front guarda esse
   * token (URL/localStorage) para continuar/ver o resultado depois.
   */
  static createSession(payload: any): { session: any; token: string } {
    const name = String(payload.contactName || "").trim();
    const companyName = String(payload.companyName || "").trim();
    const email = String(payload.contactEmail || "").trim().toLowerCase();
    if (!name) throw new Error("Nome é obrigatório.");
    if (!companyName) throw new Error("Empresa é obrigatória.");
    if (!email || !isValidEmail(email)) throw new Error("E-mail válido é obrigatório.");

    const template = this.getDefaultTemplate();
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const id = randomUUID();

    db.prepare(
      `INSERT INTO radar_sessions (
        id, organization_id, template_id, session_type, status, source,
        company_name, contact_name, contact_role, contact_email, contact_phone, segment, company_size,
        city, state, primary_goal, scoring_version, public_token_hash, public_token_expires_at,
        started_at
      ) VALUES (?, NULL, ?, 'quick', 'in_progress', 'landing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now', '+${TOKEN_TTL_DAYS} days'), CURRENT_TIMESTAMP)`
    ).run(
      id, template.id, companyName, name, payload.contactRole || null, email, payload.contactPhone || null,
      payload.segment || null, payload.companySize || null, payload.city || null, payload.state || null,
      payload.primaryGoal || null, tokenHash
    );

    logRadarEvent(null, null, "radar_session_created", { sessionId: id, source: "landing" });
    logRadarEvent(null, null, "radar_session_started", { sessionId: id });

    return { session: this.getByToken(rawToken), token: rawToken };
  }

  /**
   * Resolve uma sessão pública pelo token — nunca por ID direto (evita
   * enumeração). Já vem com o template/perguntas embutidos (todo mundo usa o
   * mesmo template público) para o front montar o questionário numa única
   * chamada, sem round-trip extra.
   */
  static getByToken(rawToken: string): any {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    const session = db.prepare(
      `SELECT * FROM radar_sessions WHERE public_token_hash = ? AND organization_id IS NULL
         AND public_token_expires_at > CURRENT_TIMESTAMP`
    ).get(tokenHash) as any;
    if (!session) return null;
    const answers = db.prepare(`SELECT question_id, answer_json, is_not_known FROM radar_answers WHERE session_id = ?`).all(session.id);
    const template = this.getDefaultTemplate();
    return { ...session, answers, template };
  }

  private static requireSession(rawToken: string): any {
    const session = this.getByToken(rawToken);
    if (!session) throw new Error("Link expirado ou inválido. Solicite um novo diagnóstico.");
    return session;
  }

  static updateContact(rawToken: string, patch: any): any {
    const session = this.requireSession(rawToken);
    const fields: string[] = [];
    const values: any[] = [];
    const set = (col: string, val: any) => { fields.push(`${col} = ?`); values.push(val); };
    if (patch.companyName !== undefined) set("company_name", patch.companyName);
    if (patch.contactName !== undefined) set("contact_name", patch.contactName);
    if (patch.contactRole !== undefined) set("contact_role", patch.contactRole);
    if (patch.contactPhone !== undefined) set("contact_phone", patch.contactPhone);
    if (patch.segment !== undefined) set("segment", patch.segment);
    if (patch.companySize !== undefined) set("company_size", patch.companySize);
    if (patch.city !== undefined) set("city", patch.city);
    if (patch.state !== undefined) set("state", patch.state);
    if (patch.primaryGoal !== undefined) set("primary_goal", patch.primaryGoal);
    if (!fields.length) return session;
    fields.push("updated_at = CURRENT_TIMESTAMP");
    values.push(session.id);
    db.prepare(`UPDATE radar_sessions SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return this.getByToken(rawToken);
  }

  static recordConsent(rawToken: string, payload: any): { success: true } {
    const session = this.requireSession(rawToken);
    if (!payload.consentType) throw new Error("consentType é obrigatório.");
    const granted = payload.granted !== false;
    db.prepare(
      `INSERT INTO radar_consent_records (id, session_id, organization_id, consent_type, legal_basis_label, version, granted, revoked_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?)`
    ).run(
      randomUUID(), session.id, payload.consentType, payload.legalBasisLabel || null,
      payload.version || CONSENT_VERSION, granted ? 1 : 0, granted ? null : new Date().toISOString()
    );
    if (granted && payload.consentType === "diagnostico") {
      db.prepare(`UPDATE radar_sessions SET consent_version = ?, consent_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(payload.version || CONSENT_VERSION, session.id);
    }
    logRadarEvent(null, null, granted ? "radar_consent_granted" : "radar_consent_revoked", { sessionId: session.id, consentType: payload.consentType });
    return { success: true };
  }

  static saveAnswer(rawToken: string, payload: any): { success: true } {
    const session = this.requireSession(rawToken);
    if (!["draft", "in_progress"].includes(session.status)) {
      throw new Error("Este diagnóstico já foi concluído.");
    }
    const question = db.prepare(`SELECT * FROM radar_questions WHERE id = ? AND template_id = ?`)
      .get(payload.questionId, session.template_id) as any;
    if (!question) throw new Error("Pergunta não pertence a este diagnóstico.");

    const isNotKnown = !!payload.isNotKnown;
    const hasComment = !!(payload.comment && String(payload.comment).trim().length > 0);
    let scoreRaw: number | null = null;
    let confidence = 0.6;

    if (isNotKnown) {
      scoreRaw = 2;
      confidence = 0.5;
    } else if (question.answer_type === "scale") {
      const options = question.options_json ? JSON.parse(question.options_json) : [];
      const opt = options.find((o: any) => o.value === payload.value);
      if (!opt) throw new Error("Opção de resposta inválida para esta pergunta.");
      scoreRaw = Number(opt.score);
      confidence = hasComment ? 0.75 : 0.6;
    }
    const scoreNormalized = scoreRaw != null ? (scoreRaw / 4) * 100 : null;

    const existing = db.prepare(`SELECT id FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id IS NULL`)
      .get(session.id, question.id) as any;

    if (existing) {
      db.prepare(
        `UPDATE radar_answers SET answer_json = ?, score_raw = ?, score_normalized = ?, confidence_multiplier = ?,
         is_not_known = ?, comment = ?, answered_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
      ).run(JSON.stringify(payload.value ?? null), scoreRaw, scoreNormalized, confidence, isNotKnown ? 1 : 0, payload.comment || null, existing.id);
    } else {
      db.prepare(
        `INSERT INTO radar_answers (id, session_id, organization_id, question_id, respondent_id, answer_json, score_raw, score_normalized, confidence_multiplier, is_not_known, comment)
         VALUES (?, ?, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`
      ).run(randomUUID(), session.id, question.id, JSON.stringify(payload.value ?? null), scoreRaw, scoreNormalized, confidence, isNotKnown ? 1 : 0, payload.comment || null);
    }
    logRadarEvent(null, null, "radar_answer_saved", { sessionId: session.id, questionId: question.id });
    return { success: true };
  }

  /**
   * Conclui o diagnóstico: calcula o score (motor compartilhado), marca a
   * sessão como 'completed' (terminal — diferente de 'awaiting_review' do
   * fluxo com consultor, porque aqui não há revisão humana no caminho crítico:
   * é resultado instantâneo de autoatendimento) e, se houver consentimento de
   * contato comercial, tenta converter em lead — ver `maybeCreateLead`.
   */
  static complete(rawToken: string): any {
    const session = this.requireSession(rawToken);
    db.prepare(`UPDATE radar_sessions SET status = 'completed', completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(session.id);
    logRadarEvent(null, null, "radar_session_completed", { sessionId: session.id });
    calculateAndPersist(session.id, undefined);

    const leadResult = this.maybeCreateLead(session.id);

    return this.getResult(rawToken, leadResult);
  }

  /**
   * Cria o lead no pipeline de prospecção (ProspectService) — mas só na
   * organização que a própria ZappFlow configurar como dona do seu funil de
   * vendas (RADAR_LEADS_ORGANIZATION_ID). Sem essa env configurada, os dados
   * do lead continuam 100% capturados em radar_sessions (nada se perde) — só
   * não são empurrados para nenhum CRM automaticamente, porque inventar uma
   * organização de destino seria vazar um lead de marketing para o tenant
   * errado. Exige consentimento explícito de 'contato_comercial'.
   */
  private static maybeCreateLead(sessionId: string): { created: boolean; reason?: string } {
    const targetOrgId = process.env.RADAR_LEADS_ORGANIZATION_ID;
    if (!targetOrgId) return { created: false, reason: "RADAR_LEADS_ORGANIZATION_ID não configurada" };

    const orgExists = db.prepare(`SELECT organization_id FROM organization_settings WHERE organization_id = ?`).get(targetOrgId);
    if (!orgExists) {
      console.error(`[RadarPublicService] RADAR_LEADS_ORGANIZATION_ID='${targetOrgId}' não corresponde a nenhuma organização — lead não criado.`);
      return { created: false, reason: "organização de destino não encontrada" };
    }

    const consent = db.prepare(
      `SELECT granted FROM radar_consent_records WHERE session_id = ? AND consent_type = 'contato_comercial' ORDER BY created_at DESC LIMIT 1`
    ).get(sessionId) as any;
    if (!consent || !consent.granted) return { created: false, reason: "sem consentimento de contato comercial" };

    const session = db.prepare(`SELECT * FROM radar_sessions WHERE id = ?`).get(sessionId) as any;
    if (!session.contact_email && !session.contact_phone) return { created: false, reason: "sem e-mail nem telefone" };

    try {
      const result = ProspectService.importRecords(targetOrgId, {
        sourceRef: `radar_ia_landing:${sessionId}`,
        provider: "radar_ia",
        records: [{
          company: session.company_name,
          contactName: session.contact_name,
          email: session.contact_email,
          phone: session.contact_phone,
          city: session.city,
          state: session.state,
        }],
      });
      logRadarEvent(targetOrgId, null, "radar_lead_created", {
        sessionId, accountsCreated: result.accountsCreated, contactsCreated: result.contactsCreated,
      });
      return { created: true };
    } catch (e: any) {
      console.error("[RadarPublicService] Falha ao criar lead no ProspectService:", e);
      return { created: false, reason: "falha ao criar lead" };
    }
  }

  static getResult(rawToken: string, leadResult?: { created: boolean; reason?: string }): any {
    const session = this.requireSession(rawToken);
    const pillarScores = db.prepare(`SELECT pillar, score, evidence_count FROM radar_pillar_scores WHERE session_id = ?`).all(session.id);
    const recommendations = db.prepare(
      `SELECT r.priority_band, r.priority_score, c.code AS use_case_code, c.name AS use_case_name, c.quick_win_steps_json
       FROM radar_recommendations r JOIN radar_use_case_catalog c ON c.id = r.use_case_id
       WHERE r.session_id = ? ORDER BY r.priority_score DESC LIMIT 3`
    ).all(session.id);
    return {
      session: {
        id: session.id, status: session.status, companyName: session.company_name,
        overallMaturityScore: session.overall_maturity_score, maturityLevel: session.maturity_level,
        confidenceScore: session.confidence_score, completedAt: session.completed_at,
      },
      pillarScores,
      topRecommendations: recommendations,
      lead: leadResult,
    };
  }
}
