import { createHash } from "node:crypto";
import db from "./db.js";
import { RadarService } from "./RadarService.js";

// Resposta do convite de respondente por link próprio (ADR-018) — sem login
// do ZappFlow. Autorização é "você tem o token certo, e ele não expirou/não
// foi revogado", nunca por organizationId/JWT — mesmo modelo já usado no
// diagnóstico público (RadarPublicService), aqui aplicado a UM respondente de
// UMA sessão que já pertence a um tenant (não a uma sessão anônima nova).
//
// Reaproveita RadarService.saveAnswer (o MESMO motor de gravação/confiança
// usado pelo dono da sessão) passando respondentId — radar_answers já
// suportava respondent_id desde a Fase 1, só nunca tinha um caminho de
// escrita além do usuário autenticado que criou a sessão. O motor de SCORE
// (RadarScoringEngine) não filtra por respondente: respostas de vários
// respondentes para a MESMA pergunta entram juntas na média do pilar — um
// diagnóstico coletivo em vez de um segundo diagnóstico paralelo. Isso é
// intencional para esta rodada (documentado na ADR-018); segmentar a
// contribuição por respondente/seção fica para quando houver sinal real de
// necessidade.

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

export class RadarRespondentService {
  /** Resolve um respondente pelo token — nunca por ID direto (evita enumeração). */
  static getByToken(rawToken: string): any {
    if (!rawToken) return null;
    const tokenHash = hashToken(rawToken);
    const respondent = db.prepare(
      `SELECT * FROM radar_respondents WHERE invite_token_hash = ? AND status != 'revoked'
         AND invite_token_expires_at > CURRENT_TIMESTAMP`
    ).get(tokenHash) as any;
    if (!respondent) return null;

    const session = db.prepare(`SELECT * FROM radar_sessions WHERE id = ?`).get(respondent.session_id) as any;
    if (!session) return null;
    const template = RadarService.getTemplateWithQuestions(session.organization_id, session.template_id);
    if (!template) return null;
    const answers = db.prepare(`SELECT question_id, answer_json, is_not_known FROM radar_answers WHERE session_id = ? AND respondent_id = ?`)
      .all(session.id, respondent.id);

    return {
      respondent: { id: respondent.id, name: respondent.name, roleTitle: respondent.role_title, status: respondent.status },
      session: { id: session.id, organizationId: session.organization_id, companyName: session.company_name, status: session.status },
      template,
      answers,
    };
  }

  private static requireContext(rawToken: string): any {
    const ctx = this.getByToken(rawToken);
    if (!ctx) throw new Error("Convite expirado, revogado ou inválido.");
    return ctx;
  }

  static saveAnswer(rawToken: string, payload: any) {
    const ctx = this.requireContext(rawToken);
    if (ctx.respondent.status === "invited") {
      db.prepare(`UPDATE radar_respondents SET status = 'active' WHERE id = ?`).run(ctx.respondent.id);
    }
    // Delega para o MESMO método que o dono autenticado da sessão usa —
    // única fonte de verdade para a lógica de score/confiança da resposta.
    return RadarService.saveAnswer(ctx.session.organizationId, ctx.session.id, undefined, { ...payload, respondentId: ctx.respondent.id });
  }

  static complete(rawToken: string): any {
    const ctx = this.requireContext(rawToken);
    db.prepare(`UPDATE radar_respondents SET status = 'completed' WHERE id = ?`).run(ctx.respondent.id);
    return this.getByToken(rawToken);
  }
}
