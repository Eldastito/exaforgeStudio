import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { MessageProviderService } from "./MessageProviderService.js";

/**
 * Follow-up Sequencial (Cadências).
 *
 * Quando um ticket atinge um estágio gatilho (ex: "proposta"), inicia uma
 * cadência: envia mensagens automáticas em intervalos configurados enquanto o
 * contato não responder. Para assim que o contato responde, o ticket muda de
 * estágio, ou todas as etapas são concluídas.
 */
export class CadenceService {
  // ── CRUD ─────────────────────────────────────────────────────────────────

  static list(orgId: string): any[] {
    const cadences = db.prepare(
      'SELECT * FROM cadences WHERE organization_id = ? ORDER BY created_at DESC'
    ).all(orgId) as any[];

    for (const c of cadences) {
      c.steps = db.prepare(
        'SELECT * FROM cadence_steps WHERE cadence_id = ? ORDER BY step_order ASC'
      ).all(c.id);
    }
    return cadences;
  }

  static create(orgId: string, params: {
    name: string;
    triggerStage: string;
    minLeadScore?: number;
    steps: { delayHours: number; message: string }[];
  }): any {
    if (!params.name?.trim()) throw new Error("Nome é obrigatório.");
    if (!params.triggerStage?.trim()) throw new Error("Estágio gatilho é obrigatório.");
    if (!Array.isArray(params.steps) || params.steps.length === 0) throw new Error("Adicione ao menos uma etapa.");

    const id = uuidv4();
    const tx = db.transaction(() => {
      db.prepare(
        'INSERT INTO cadences (id, organization_id, name, trigger_stage, active, min_lead_score) VALUES (?, ?, ?, ?, 1, ?)'
      ).run(id, orgId, params.name.trim(), params.triggerStage.trim(), this.clampScore(params.minLeadScore));

      const insStep = db.prepare(
        'INSERT INTO cadence_steps (id, cadence_id, organization_id, step_order, delay_hours, message) VALUES (?, ?, ?, ?, ?, ?)'
      );
      params.steps.forEach((s, i) => {
        insStep.run(uuidv4(), id, orgId, i + 1, Number(s.delayHours) || 1, s.message?.trim() || '');
      });
    });
    tx();
    return this.get(orgId, id);
  }

  static update(orgId: string, id: string, params: {
    name?: string;
    triggerStage?: string;
    active?: boolean;
    minLeadScore?: number;
    steps?: { delayHours: number; message: string }[];
  }): any {
    const existing = db.prepare('SELECT id FROM cadences WHERE id = ? AND organization_id = ?').get(id, orgId);
    if (!existing) throw new Error("Cadência não encontrada.");

    const tx = db.transaction(() => {
      if (params.name !== undefined || params.triggerStage !== undefined || params.active !== undefined || params.minLeadScore !== undefined) {
        const fields: string[] = [];
        const vals: any[] = [];
        if (params.name !== undefined) { fields.push('name = ?'); vals.push(params.name.trim()); }
        if (params.triggerStage !== undefined) { fields.push('trigger_stage = ?'); vals.push(params.triggerStage.trim()); }
        if (params.active !== undefined) { fields.push('active = ?'); vals.push(params.active ? 1 : 0); }
        if (params.minLeadScore !== undefined) { fields.push('min_lead_score = ?'); vals.push(this.clampScore(params.minLeadScore)); }
        db.prepare(`UPDATE cadences SET ${fields.join(', ')} WHERE id = ?`).run(...vals, id);
      }

      if (Array.isArray(params.steps)) {
        db.prepare('DELETE FROM cadence_steps WHERE cadence_id = ?').run(id);
        const insStep = db.prepare(
          'INSERT INTO cadence_steps (id, cadence_id, organization_id, step_order, delay_hours, message) VALUES (?, ?, ?, ?, ?, ?)'
        );
        params.steps.forEach((s, i) => {
          insStep.run(uuidv4(), id, orgId, i + 1, Number(s.delayHours) || 1, s.message?.trim() || '');
        });
      }
    });
    tx();
    return this.get(orgId, id);
  }

  static delete(orgId: string, id: string) {
    db.transaction(() => {
      db.prepare("UPDATE contact_cadences SET status = 'cancelled' WHERE cadence_id = ?").run(id);
      db.prepare('DELETE FROM cadence_steps WHERE cadence_id = ?').run(id);
      db.prepare('DELETE FROM cadences WHERE id = ? AND organization_id = ?').run(id, orgId);
    })();
  }

  static get(orgId: string, id: string): any {
    const c = db.prepare('SELECT * FROM cadences WHERE id = ? AND organization_id = ?').get(id, orgId) as any;
    if (!c) return null;
    c.steps = db.prepare('SELECT * FROM cadence_steps WHERE cadence_id = ? ORDER BY step_order ASC').all(id);
    return c;
  }

  // ── Ciclo de vida de uma cadência ativa ──────────────────────────────────

  /**
   * Inicia uma cadência para um ticket/contato quando o ticket entra em um
   * estágio gatilho. Cancela qualquer cadência anterior do mesmo ticket.
   */
  static startForTicket(orgId: string, ticketId: string, contactId: string, stage: string) {
    const cadence = db.prepare(
      "SELECT * FROM cadences WHERE organization_id = ? AND trigger_stage = ? AND active = 1 LIMIT 1"
    ).get(orgId, stage) as any;
    if (!cadence) return;

    const steps = db.prepare(
      'SELECT * FROM cadence_steps WHERE cadence_id = ? ORDER BY step_order ASC'
    ).all(cadence.id) as any[];
    if (steps.length === 0) return;

    const contact = db.prepare('SELECT identifier, name, channel_id, lead_score FROM contacts WHERE id = ?').get(contactId) as any;
    if (!contact?.identifier) return;

    // Gating por Lead Score: pula contatos abaixo do mínimo configurado.
    const minScore = cadence.min_lead_score || 0;
    if (minScore > 0 && (contact.lead_score || 0) < minScore) {
      console.log(`[Cadência] "${cadence.name}" não disparada: score ${contact.lead_score || 0} < ${minScore}.`);
      return;
    }

    db.transaction(() => {
      db.prepare("UPDATE contact_cadences SET status = 'cancelled' WHERE ticket_id = ? AND status = 'active'").run(ticketId);

      const firstStep = steps[0];
      const nextSendAt = new Date(Date.now() + firstStep.delay_hours * 3600_000).toISOString();

      db.prepare(`
        INSERT INTO contact_cadences
          (id, organization_id, cadence_id, ticket_id, contact_id, channel_id, contact_identifier, contact_name, current_step, status, started_at, next_send_at, last_contact_message_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'active', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
      `).run(
        uuidv4(), orgId, cadence.id, ticketId, contactId,
        contact.channel_id, contact.identifier, contact.name || null,
        nextSendAt
      );
    })();

    console.log(`[Cadência] Iniciada "${cadence.name}" para ticket ${ticketId} (próximo envio em ${steps[0].delay_hours}h).`);
  }

  /** Para cadências ativas do ticket (contato respondeu ou estágio mudou). */
  static cancelForTicket(ticketId: string) {
    const r = db.prepare("UPDATE contact_cadences SET status = 'cancelled' WHERE ticket_id = ? AND status = 'active'").run(ticketId);
    if (r.changes > 0) console.log(`[Cadência] Cancelada para ticket ${ticketId} (contato respondeu).`);
  }

  /** Atualiza o timestamp da última mensagem do contato (ponto de partida para o delay). */
  static touchContactMessage(ticketId: string) {
    db.prepare("UPDATE contact_cadences SET last_contact_message_at = CURRENT_TIMESTAMP WHERE ticket_id = ? AND status = 'active'").run(ticketId);
  }

  /** Limita score em [0,100] e converte para inteiro. */
  private static clampScore(s?: number): number {
    const n = Math.round(Number(s ?? 0));
    return Math.max(0, Math.min(100, isNaN(n) ? 0 : n));
  }

  // ── Scheduler ─────────────────────────────────────────────────────────────

  /**
   * Chamado pelo Scheduler de hora em hora.
   * Envia as mensagens de follow-up que estão vencidas (next_send_at <= agora).
   */
  static async processTick(io?: any) {
    let due: any[] = [];
    try {
      due = db.prepare(`
        SELECT cc.*, cs.message, cs.delay_hours, cs.step_order
        FROM contact_cadences cc
        JOIN cadence_steps cs
          ON cs.cadence_id = cc.cadence_id
          AND cs.step_order = cc.current_step + 1
        WHERE cc.status = 'active'
          AND cc.next_send_at <= datetime('now')
      `).all() as any[];
    } catch (e) { return; }

    for (const row of due) {
      try {
        const name = (row.contact_name || '').trim().split(/\s+/)[0] || '';
        const msg = row.message.replace(/\{nome\}/gi, name);

        await MessageProviderService.sendMessage(row.channel_id, row.contact_identifier, msg);

        // Calcula próximo envio (próxima etapa existe?).
        const nextStep = db.prepare(
          'SELECT * FROM cadence_steps WHERE cadence_id = ? AND step_order = ? ORDER BY step_order ASC LIMIT 1'
        ).get(row.cadence_id, row.current_step + 2) as any;

        if (nextStep) {
          const nextSendAt = new Date(Date.now() + nextStep.delay_hours * 3600_000).toISOString();
          db.prepare(`
            UPDATE contact_cadences
            SET current_step = ?, next_send_at = ?
            WHERE id = ?
          `).run(row.current_step + 1, nextSendAt, row.id);
        } else {
          db.prepare("UPDATE contact_cadences SET status = 'completed', current_step = ? WHERE id = ?")
            .run(row.current_step + 1, row.id);
        }

        console.log(`[Cadência] Follow-up enviado para ${row.contact_identifier} (step ${row.current_step + 1}).`);

        if (io) {
          io.to(`org:${row.organization_id}`).emit('cadence_followup_sent', {
            ticketId: row.ticket_id,
            contactIdentifier: row.contact_identifier,
            step: row.current_step + 1,
            message: msg,
          });
        }
      } catch (e) {
        console.error('[Cadência] Falha ao enviar follow-up', row.id, e);
      }
    }
  }
}
