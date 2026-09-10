import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { RecognitionNotesService } from "./RecognitionNotesService.js";

/**
 * Pesquisa de satisfação (CSAT 1-5) enviada após a venda. Mede a experiência,
 * identifica detratores (nota 1-3) e, quando a nota é baixa, a IA pede desculpas
 * e registra — sem o cliente precisar de outro canal.
 */
export class SatisfactionService {
  /** Nota <= 3 é detrator; 4 neutro; 5 promotor. */
  static isDetractor(score: number): boolean {
    return score >= 1 && score <= 3;
  }

  /** Pesquisa em aberto (enviada e ainda não respondida) mais recente do contato. */
  static pendingForContact(orgId: string, contactId: string, withinHours = 72): any | null {
    try {
      return db.prepare(`
        SELECT * FROM satisfaction_surveys
        WHERE organization_id = ? AND contact_id = ? AND status = 'sent'
          AND sent_at >= datetime('now', ?)
        ORDER BY sent_at DESC LIMIT 1
      `).get(orgId, contactId, `-${withinHours} hours`) as any || null;
    } catch (e) { return null; }
  }

  /**
   * Extrai uma nota 1-5 de uma resposta curta do cliente. Aceita "5", "nota 4",
   * "5!", etc. Retorna null se a mensagem não parece ser uma nota.
   */
  static parseScore(text: string): number | null {
    const t = (text || "").trim();
    // Só considera quando a mensagem é essencialmente um número (evita confundir
    // com quantidades/datas no meio de uma frase longa).
    if (t.length > 12) return null;
    const m = t.match(/\b([1-5])\b/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return n >= 1 && n <= 5 ? n : null;
  }

  /** Registra a nota e fecha a pesquisa. */
  static record(orgId: string, surveyId: string, score: number, comment?: string): void {
    try {
      db.prepare(`UPDATE satisfaction_surveys SET status = 'answered', score = ?, comment = COALESCE(?, comment), answered_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`)
        .run(score, comment || null, surveyId, orgId);
      // Nota máxima → dispara sugestão de reconhecimento pro dono (Hunter, ADR-049).
      // Não interfere no fluxo se falhar — é enriquecimento, não caminho crítico.
      if (score === 5) {
        try {
          const row = db.prepare(`SELECT contact_id, order_id FROM satisfaction_surveys WHERE id = ? AND organization_id = ?`)
            .get(surveyId, orgId) as any;
          if (row?.contact_id) {
            RecognitionNotesService.detect({
              organizationId: orgId,
              targetType: "customer",
              targetId: row.contact_id,
              triggerType: "csat_high",
              context: { surveyId, orderId: row.order_id || null, score, comment: comment || null },
            });
          }
        } catch (e) { console.error("[Recognition] hook csat_high falhou", e); }
      }
    } catch (e) { console.error("[CSAT] Falha ao registrar nota", e); }
  }

  /**
   * Cria a pesquisa (status 'sent') — uma por pedido OU por atendimento. O
   * salão/clínica opera em `appointments`, não em `orders`; `appointmentId`
   * permite medir CSAT do serviço realizado (a dedup por atendimento vive no
   * caller `dueAppointments`). Origem (order/appointment) não afeta a captura
   * do score no webhook, que resolve por contato.
   */
  static create(orgId: string, params: { contactId: string; ticketId?: string; orderId?: string; appointmentId?: string }): string | null {
    try {
      const id = uuidv4();
      db.prepare(`INSERT INTO satisfaction_surveys (id, organization_id, ticket_id, contact_id, order_id, appointment_id) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(id, orgId, params.ticketId || null, params.contactId, params.orderId || null, params.appointmentId || null);
      return id;
    } catch (e) { console.error("[CSAT] Falha ao criar pesquisa", e); return null; }
  }

  /**
   * Atendimentos REALIZADOS elegíveis a CSAT: `status='completed'`, com um
   * instante de conclusão conhecido (checkout_at, senão scheduled_end) já
   * ultrapassado há `hoursAfter` horas, e SEM pesquisa criada ainda (dedup por
   * appointment_id). Nunca inventa: se não há como saber quando terminou
   * (ambos nulos), o atendimento não entra (RN-004/RN-151). Read-only.
   */
  static dueAppointments(orgId: string, hoursAfter = 24, now: Date = new Date()): any[] {
    const h = Math.max(0, Math.floor(hoursAfter));
    const cutoff = new Date(now.getTime() - h * 3600 * 1000).toISOString();
    try {
      return db.prepare(`
        SELECT a.id, a.contact_id, a.ticket_id,
               COALESCE(a.checkout_at, a.scheduled_end) AS ended_at,
               c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel
        FROM appointments a
        JOIN contacts c ON c.id = a.contact_id AND c.organization_id = a.organization_id
        WHERE a.organization_id = ?
          AND a.status = 'completed'
          AND COALESCE(a.checkout_at, a.scheduled_end) IS NOT NULL
          AND datetime(COALESCE(a.checkout_at, a.scheduled_end)) <= datetime(?)
          AND NOT EXISTS (SELECT 1 FROM satisfaction_surveys s WHERE s.organization_id = a.organization_id AND s.appointment_id = a.id)
        ORDER BY ended_at ASC
        LIMIT 300
      `).all(orgId, cutoff) as any[];
    } catch (e) { console.error("[CSAT] Falha ao listar atendimentos elegíveis", e); return []; }
  }

  /** Resposta automática ao receber a nota (agradece; pede desculpas se detrator). */
  static replyFor(score: number, firstName: string): string {
    const nm = firstName ? `, ${firstName}` : "";
    if (this.isDetractor(score)) {
      return `Poxa${nm}, sinto muito que a experiência não tenha sido boa. 🙏 Pode me contar rapidinho o que aconteceu? Quero entender e resolver pra você.`;
    }
    if (score === 4) return `Obrigado pela avaliação${nm}! 😊 Que bom te atender — qualquer coisa, é só chamar.`;
    return `Que alegria${nm}! 🌟 Muito obrigado pela nota máxima — fico à disposição sempre que precisar!`;
  }

  /** Marca que a pesquisa pediu detalhes ao detrator. */
  static markFollowUpAsked(orgId: string, surveyId: string): void {
    try {
      db.prepare(`UPDATE satisfaction_surveys SET follow_up_status = 'asked' WHERE id = ? AND organization_id = ?`).run(surveyId, orgId);
    } catch (e) { console.error('[CSAT] Falha ao marcar follow-up', e); }
  }

  /** Pesquisa aguardando comentário estruturado (detrator que recebeu follow-up). */
  static pendingFollowUp(orgId: string, contactId: string): any | null {
    try {
      return db.prepare(`
        SELECT * FROM satisfaction_surveys
        WHERE organization_id = ? AND contact_id = ? AND status = 'answered'
          AND follow_up_status = 'asked'
          AND answered_at >= datetime('now', '-72 hours')
        ORDER BY answered_at DESC LIMIT 1
      `).get(orgId, contactId) as any || null;
    } catch { return null; }
  }

  /** Captura o comentário estruturado do detrator. */
  static captureComment(orgId: string, surveyId: string, comment: string): void {
    try {
      db.prepare(`UPDATE satisfaction_surveys SET comment = ?, follow_up_status = 'captured' WHERE id = ? AND organization_id = ?`)
        .run(comment, surveyId, orgId);
    } catch (e) { console.error('[CSAT] Falha ao capturar comentário', e); }
  }

  /** Timeline de detratores com comentários para analytics. */
  static detractorTimeline(orgId: string, days = 90): any[] {
    try {
      return db.prepare(`
        SELECT s.id, s.score, s.comment, s.follow_up_status, s.answered_at,
               c.name AS contact_name, c.identifier AS contact_identifier
        FROM satisfaction_surveys s
        JOIN contacts c ON c.id = s.contact_id AND c.organization_id = s.organization_id
        WHERE s.organization_id = ? AND s.status = 'answered' AND s.score <= 3
          AND s.answered_at >= datetime('now', ?)
        ORDER BY s.answered_at DESC
      `).all(orgId, `-${days} days`) as any[];
    } catch { return []; }
  }
}
