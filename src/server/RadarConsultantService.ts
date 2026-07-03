import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logRadarEvent } from "./radarAudit.js";

// Painel do consultor (Radar — Fase 3, ADR-014). CROSS-TENANT DE PROPÓSITO:
// dá à própria equipe da ZappFlow (não ao tenant) visão de diagnósticos de
// TODAS as organizações, para dar suporte consultivo/comercial. Isso é uma
// exceção deliberada ao isolamento multi-tenant que o resto do produto
// mantém — só é seguro porque cada método aqui SÓ é alcançável através de
// rotas protegidas por `requireMasterAdmin` (mesmo gate do Admin Master,
// src/server/middleware/auth.ts), montado no `server.ts` no nível do router,
// nunca por checagem dentro do handler. Este serviço nunca deve ganhar um
// método que aceite um token/sessão de usuário comum como autorização —
// quem chama já provou ser master admin antes de chegar aqui.
//
// "approved" já era um status documentado no schema de radar_sessions desde
// a Fase 1 (ver db.ts) mas nunca usado em código — vira aqui o status
// terminal de "consultor revisou". next_action/consultant_user_id (colunas
// que já existiam, também sem uso até agora) viram a nota do consultor.

export class RadarConsultantService {
  static listSessions(filters: { status?: string } = {}) {
    if (filters.status) {
      return db.prepare(`
        SELECT rs.*, os.business_name AS org_business_name
        FROM radar_sessions rs
        JOIN organization_settings os ON os.organization_id = rs.organization_id
        WHERE rs.organization_id IS NOT NULL AND rs.status = ?
        ORDER BY rs.updated_at DESC
      `).all(filters.status);
    }
    return db.prepare(`
      SELECT rs.*, os.business_name AS org_business_name
      FROM radar_sessions rs
      JOIN organization_settings os ON os.organization_id = rs.organization_id
      WHERE rs.organization_id IS NOT NULL
      ORDER BY rs.updated_at DESC
    `).all();
  }

  static getSession(sessionId: string): any {
    const session = db.prepare(`
      SELECT rs.*, os.business_name AS org_business_name
      FROM radar_sessions rs
      JOIN organization_settings os ON os.organization_id = rs.organization_id
      WHERE rs.id = ?
    `).get(sessionId) as any;
    if (!session) return null;

    const pillarScores = db.prepare(`SELECT * FROM radar_pillar_scores WHERE session_id = ?`).all(sessionId);
    const recommendations = db.prepare(`
      SELECT r.*, c.code AS use_case_code, c.name AS use_case_name
      FROM radar_recommendations r JOIN radar_use_case_catalog c ON c.id = r.use_case_id
      WHERE r.session_id = ? ORDER BY r.priority_score DESC
    `).all(sessionId);
    const respondents = db.prepare(`SELECT * FROM radar_respondents WHERE session_id = ? ORDER BY created_at`).all(sessionId);
    const answers = db.prepare(`
      SELECT a.*, q.title AS question_title, q.pillar AS question_pillar
      FROM radar_answers a JOIN radar_questions q ON q.id = a.question_id
      WHERE a.session_id = ? ORDER BY q.display_order
    `).all(sessionId);

    return { ...session, pillarScores, recommendations, respondents, answers };
  }

  // Nota do consultor + quem revisou por último. Não exige transição de
  // status — pode ser salva a qualquer momento, inclusive antes de aprovar.
  static saveNote(sessionId: string, consultantUserId: string | undefined, note: string) {
    const session = db.prepare(`SELECT organization_id FROM radar_sessions WHERE id = ?`).get(sessionId) as any;
    if (!session) throw new Error("Sessão não encontrada.");
    db.prepare(`UPDATE radar_sessions SET next_action = ?, consultant_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(note || null, consultantUserId || null, sessionId);
    logRadarEvent(session.organization_id, consultantUserId, "radar_consultant_note_saved", { sessionId });
    return this.getSession(sessionId);
  }

  // Só sai de 'awaiting_review' — evita "aprovar" um rascunho que o tenant
  // nem terminou de responder ainda.
  static approve(sessionId: string, consultantUserId: string | undefined) {
    const session = db.prepare(`SELECT organization_id, status FROM radar_sessions WHERE id = ?`).get(sessionId) as any;
    if (!session) throw new Error("Sessão não encontrada.");
    if (session.status !== "awaiting_review") {
      throw new Error("Só é possível aprovar uma sessão que está 'Aguardando revisão'.");
    }
    db.prepare(`UPDATE radar_sessions SET status = 'approved', consultant_user_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(consultantUserId || null, sessionId);
    logRadarEvent(session.organization_id, consultantUserId, "radar_consultant_approved", { sessionId });
    return this.getSession(sessionId);
  }
}
