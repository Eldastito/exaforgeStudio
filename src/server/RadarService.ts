import { randomUUID, randomBytes, createHash } from "node:crypto";
import db from "./db.js";
import { logRadarEvent } from "./radarAudit.js";
import { PILLAR_WEIGHTS, SCORING_VERSION, Pillar, calculateAndPersist } from "./RadarScoringEngine.js";
import { generateNarrative } from "./RadarNarrativeService.js";
import { ReportPdfService } from "./ReportPdfService.js";
import { TaskService } from "./TaskService.js";
import { NotificationService } from "./NotificationService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";

const PILLAR_LABEL: Record<string, string> = {
  estrategia: "Estratégia e liderança",
  receita: "Receita e atendimento",
  processos: "Processos operacionais",
  dados: "Dados e integração",
  pessoas: "Pessoas e capacitação",
  governanca: "Governança e segurança",
  metricas: "Métricas e ROI",
};

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
    // Faltava até aqui — sem isso, reabrir uma sessão em andamento sempre
    // parecia "nada respondido ainda" pra quem chama (RadarView.tsx calcula a
    // primeira pergunta sem resposta a partir deste array), reiniciando o
    // questionário do zero mesmo com respostas já salvas.
    const answers = db.prepare(`SELECT * FROM radar_answers WHERE session_id = ?`).all(id);
    const evidence = db.prepare(`SELECT * FROM radar_evidence WHERE session_id = ?`).all(id);
    return { ...session, pillarScores, recommendations, answers, evidence };
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

  // Respondentes (Fase 3, ADR-014) + convite por link próprio (ADR-018):
  // registro de QUEM mais está ajudando a responder uma sessão além de quem
  // a criou. `radar_respondents` já existia desde a Fase 1 (radar_answers já
  // aceita respondent_id), mas nada expunha essa tabela até a ADR-014, que
  // cobria só cadastro/listagem. O convite (token opaco, mesmo padrão de
  // `radar_sessions.public_token_hash`/RadarPublicService) mora aqui;
  // respondê-lo mora em RadarRespondentService.ts (rota pública sem login).
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
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    db.prepare(
      `INSERT INTO radar_respondents (id, session_id, organization_id, name, email, role_title, area, status, invite_token_hash, invite_token_expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'invited', ?, datetime('now', '+30 days'))`
    ).run(id, sessionId, orgId, payload.name.trim(), payload.email || null, payload.roleTitle || null, payload.area || null, tokenHash);
    logEvent(orgId, actorUserId, "radar_respondent_added", sessionId, { respondentId: id });

    const respondent = db.prepare(`SELECT * FROM radar_respondents WHERE id = ?`).get(id);
    // rawToken só existe em texto plano aqui, na resposta desta chamada — o
    // banco guarda só o hash. Quem chama é responsável por mostrar o link
    // pro usuário UMA vez (RadarView.tsx copia pra área de transferência).
    return { respondent, inviteToken: rawToken, inviteUrl: `/radar-ia/respond/${rawToken}` };
  }

  static revokeRespondent(orgId: string, sessionId: string, actorUserId: string | undefined, respondentId: string) {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    const result = db.prepare(`UPDATE radar_respondents SET status = 'revoked' WHERE id = ? AND session_id = ?`).run(respondentId, sessionId);
    if (result.changes === 0) throw new Error("Respondente não encontrado.");
    logEvent(orgId, actorUserId, "radar_respondent_revoked", sessionId, { respondentId });
    return this.listRespondents(orgId, sessionId);
  }

  // Evidência anexada a uma resposta (reservado desde a Fase 1 — ver
  // saveAnswer acima). Sobe a confiança daquela resposta específica para 0,90
  // (nunca para baixo — evidência só reforça, uma resposta com comentário +
  // evidência continua em 0,90, não regride para 0,75) e recalcula a sessão
  // na hora, porque o score/confiança já podem estar visíveis (sessão
  // concluída) quando a evidência é anexada depois.
  static addEvidence(orgId: string, sessionId: string, actorUserId: string | undefined, payload: {
    questionId: string; respondentId?: string | null; fileUrl: string; fileName?: string; mimeType?: string;
  }) {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    if (!payload.fileUrl) throw new Error("Arquivo de evidência é obrigatório.");

    const answer = payload.respondentId
      ? db.prepare(`SELECT id, confidence_multiplier FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id = ?`)
          .get(sessionId, payload.questionId, payload.respondentId) as any
      : db.prepare(`SELECT id, confidence_multiplier FROM radar_answers WHERE session_id = ? AND question_id = ? AND respondent_id IS NULL`)
          .get(sessionId, payload.questionId) as any;
    if (!answer) throw new Error("Responda a pergunta antes de anexar evidência.");

    const id = randomUUID();
    db.prepare(
      `INSERT INTO radar_evidence (id, session_id, organization_id, answer_id, file_url, file_name, mime_type, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, sessionId, orgId, answer.id, payload.fileUrl, payload.fileName || null, payload.mimeType || null, actorUserId || null);

    const boosted = Math.max(answer.confidence_multiplier ?? 0, 0.9);
    db.prepare(`UPDATE radar_answers SET confidence_multiplier = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(boosted, answer.id);

    logEvent(orgId, actorUserId, "radar_evidence_added", sessionId, { evidenceId: id, questionId: payload.questionId });
    calculateAndPersist(sessionId, actorUserId); // atualiza confiança/score já visíveis, se a sessão já tiver sido concluída
    return this.getSession(orgId, sessionId);
  }

  static listEvidence(orgId: string, sessionId: string) {
    const session = db.prepare(`SELECT id FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId);
    if (!session) throw new Error("Sessão não encontrada.");
    return db.prepare(`SELECT * FROM radar_evidence WHERE session_id = ? ORDER BY created_at`).all(sessionId);
  }

  // Relatório em PDF (Fase 4, ADR-016) — SOB DEMANDA (não gerado
  // automaticamente ao concluir/aprovar): quem decide se quer gastar a
  // chamada de IA e o tempo de geração é o usuário, clicando "Gerar
  // relatório". A narrativa em texto é best-effort — se a IA não estiver
  // configurada ou a chamada falhar, o PDF sai igual, só sem essa seção
  // (RadarNarrativeService.generateNarrative nunca lança).
  static async generateReport(orgId: string, sessionId: string, actorUserId?: string) {
    const session = this.getSession(orgId, sessionId) as any;
    if (!session) throw new Error("Sessão não encontrada.");
    if (session.overall_maturity_score == null) {
      throw new Error("Conclua o diagnóstico antes de gerar o relatório.");
    }

    const pillarScores = (session.pillarScores || []).map((p: any) => ({ pillar: p.pillar, label: PILLAR_LABEL[p.pillar] || p.pillar, score: p.score }));
    const topRecommendation = (session.recommendations || [])[0] || null;

    const narrative = await generateNarrative({
      companyName: session.company_name,
      overallScore: session.overall_maturity_score,
      maturityLevel: session.maturity_level,
      confidenceScore: session.confidence_score,
      pillarScores: pillarScores.map((p: any) => ({ pillar: p.pillar, score: p.score })),
      topRecommendation: topRecommendation ? { use_case_name: topRecommendation.use_case_name, priority_band: topRecommendation.priority_band } : null,
    });

    const pdf = await ReportPdfService.generateRadarReport(orgId, {
      companyName: session.company_name,
      overallScore: session.overall_maturity_score,
      maturityLevel: session.maturity_level,
      confidenceScore: session.confidence_score,
      pillarScores,
      recommendations: (session.recommendations || []).map((r: any) => ({ use_case_name: r.use_case_name, priority_band: r.priority_band })),
      narrative,
    });
    if (!pdf) throw new Error("Não foi possível gerar o PDF. Tente novamente.");

    logEvent(orgId, actorUserId, "radar_report_generated", sessionId, { hasNarrative: !!narrative });
    return { url: pdf.url, hasNarrative: !!narrative };
  }

  // Ponte com Tarefas (Fase 5, ADR-016) — SOB DEMANDA (botão, não automático
  // ao aprovar): mesma regra do produto de nunca deixar a IA/o sistema agir
  // sozinho sem controle humano. Idempotente: recomendações que já viraram
  // tarefa (ref_label já usado) são puladas, não duplicadas.
  static createTasksFromRecommendations(orgId: string, sessionId: string, actorUserId?: string) {
    const session = db.prepare(`SELECT id, company_name FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId) as any;
    if (!session) throw new Error("Sessão não encontrada.");

    const highPriority = db.prepare(`
      SELECT r.*, c.name AS use_case_name FROM radar_recommendations r
      JOIN radar_use_case_catalog c ON c.id = r.use_case_id
      WHERE r.session_id = ? AND r.priority_band = 'alta'
    `).all(sessionId) as any[];

    let created = 0, skipped = 0;
    const createdTasks: any[] = [];
    for (const rec of highPriority) {
      const refLabel = `radar:${sessionId}:${rec.id}`;
      const existing = db.prepare(`SELECT id FROM tasks WHERE organization_id = ? AND ref_label = ?`).get(orgId, refLabel);
      if (existing) { skipped++; continue; }

      const task = TaskService.create(orgId, {
        title: `[Radar] ${rec.use_case_name}`,
        description: `Recomendação de prioridade alta do diagnóstico "${session.company_name || sessionId}" (score de prioridade ${rec.priority_score}).`,
        priority: "alta",
        source: "radar",
        refLabel,
      }, actorUserId);
      createdTasks.push(task);
      created++;
    }

    logEvent(orgId, actorUserId, "radar_tasks_created", sessionId, { created, skipped });
    return { created, skipped, tasks: createdTasks };
  }

  // Lembrete de reavaliação (Fase 5, ADR-016) — passe agendado (Scheduler.tick).
  // Sessão concluída há 90+ dias gera UMA notificação in-app (nunca WhatsApp/
  // e-mail automático — ver ADR-016 para o porquê disso ficar fora desta
  // rodada). dedupeKey com janela de ~1 ano evita repetir a mesma notificação
  // a cada hora que o Scheduler roda.
  static reassessmentReminderPass() {
    const stale = db.prepare(`
      SELECT id, organization_id, company_name FROM radar_sessions
      WHERE organization_id IS NOT NULL AND status IN ('awaiting_review', 'approved', 'completed')
        AND completed_at IS NOT NULL AND completed_at <= datetime('now', '-90 days')
    `).all() as any[];
    for (const s of stale) {
      NotificationService.push({
        organizationId: s.organization_id,
        title: "Hora de reavaliar seu diagnóstico de IA",
        message: `O diagnóstico "${s.company_name || "sem nome"}" foi concluído há mais de 90 dias. Que tal um novo Radar para acompanhar sua evolução?`,
        type: "info",
        dedupeKey: `radar_reassess_${s.id}`,
        dedupeWindowMin: 60 * 24 * 365,
      });
    }
    return { checked: stale.length };
  }

  // Envio do relatório pelo canal da PRÓPRIA organização (não da ZappFlow —
  // ver ADR-017 para o porquê disso não ser o mesmo caso da landing pública).
  // Sempre (re)gera o PDF na hora do envio, para nunca mandar um link de um
  // relatório desatualizado (ex.: gerado antes de anexar uma evidência nova).
  // Link em vez de anexo binário nos dois canais: WhatsApp Cloud API já
  // funciona só com link (MessageProviderService.sendDocument); e-mail com
  // anexo binário de verdade exigiria mexer na codificação de
  // GoogleOAuthService.gmailSend (hoje só testada para texto/.ics) — link é
  // suficiente e mais simples, sem tocar em código que já funciona pra outra
  // coisa.
  static async sendReport(orgId: string, sessionId: string, actorUserId: string | undefined, channel: "whatsapp" | "email") {
    const session = db.prepare(`SELECT * FROM radar_sessions WHERE id = ? AND organization_id = ?`).get(sessionId, orgId) as any;
    if (!session) throw new Error("Sessão não encontrada.");

    // Valida ANTES de gastar a geração do PDF (que já chama a IA para a
    // narrativa) — não faz sentido gerar um relatório que sabemos de
    // antemão que não vai ter para onde ir.
    let activeChannel: any = null;
    if (channel === "whatsapp") {
      if (!session.contact_phone) throw new Error("Esta sessão não tem telefone de contato registrado.");
      activeChannel = db.prepare(
        `SELECT id FROM channels WHERE organization_id = ? AND status NOT IN ('disabled','disconnected') ORDER BY created_at LIMIT 1`
      ).get(orgId) as any;
      if (!activeChannel) throw new Error("Nenhum canal de WhatsApp conectado nesta organização.");
    } else {
      if (!session.contact_email) throw new Error("Esta sessão não tem e-mail de contato registrado.");
      if (!GoogleOAuthService.getConnection(orgId)) throw new Error("Conta Google não conectada.");
    }

    const { url } = await this.generateReport(orgId, sessionId, actorUserId);
    if (!/^https?:\/\//.test(url)) {
      throw new Error("Configure APP_URL (ou um storage S3) para poder enviar o relatório — o link gerado precisa ser público.");
    }

    if (channel === "whatsapp") {
      await MessageProviderService.sendDocument(
        activeChannel.id, session.contact_phone, url, "diagnostico-radar.pdf",
        `Aqui está o relatório do diagnóstico Radar de Execução IA de ${session.company_name || "sua empresa"}.`
      );
    } else {
      const result = await GoogleOAuthService.gmailSend(
        orgId, session.contact_email,
        "Seu relatório do Radar de Execução IA",
        `Olá! Segue o link do relatório do diagnóstico "${session.company_name || ""}": ${url}`
      );
      if ((result as any)?.error) throw new Error((result as any).error);
    }

    logEvent(orgId, actorUserId, "radar_report_sent", sessionId, { channel });
    return { sent: true, channel };
  }
}
