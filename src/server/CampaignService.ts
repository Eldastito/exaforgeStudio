import db from "./db.js";
import { v4 as uuidv4 } from "uuid";
import { MessageProviderService } from "./MessageProviderService.js";

/**
 * Motor de campanhas (mensagem ativa / outbound).
 *
 * SALVAGUARDAS ANTI-BAN (importantes no WhatsApp):
 *  - Intervalo aleatório entre envios (CAMPAIGN_MIN_DELAY_MS..MAX) para não
 *    parecer robô/spam.
 *  - Respeita opt-out (marketing_opt_out) — nunca envia para quem recusou.
 *  - Personaliza {nome} para reduzir aparência de mensagem em massa.
 *  - Um envio por vez por organização (sem rajadas paralelas).
 */
export class CampaignService {
  private static running = new Set<string>(); // orgs com campanha em execução

  /** Resolve os contatos de um segmento (reaproveita o CRM da Fase 1). */
  static resolveSegment(orgId: string, segment: any): any[] {
    let sql = `SELECT id, name, identifier FROM contacts WHERE organization_id = ? AND COALESCE(marketing_opt_out,0) = 0`;
    const params: any[] = [orgId];
    if (segment?.temperature) { sql += ` AND lead_temperature = ?`; params.push(segment.temperature); }
    if (segment?.tag) { sql += ` AND tags LIKE ?`; params.push(`%${segment.tag}%`); }
    if (segment?.minLeadScore) {
      sql += ` AND COALESCE(lead_score,0) >= ?`;
      params.push(Math.max(0, Math.min(100, parseInt(String(segment.minLeadScore), 10) || 0)));
    }
    if (segment?.inactiveDays) {
      sql += ` AND purchase_count > 0 AND (last_purchase_at IS NULL OR last_purchase_at < datetime('now', ?))`;
      params.push(`-${parseInt(String(segment.inactiveDays), 10) || 0} days`);
    }
    if (segment?.topBuyers) {
      sql += ` AND purchase_count > 0 ORDER BY total_spent DESC LIMIT ?`;
      params.push(parseInt(String(segment.topBuyers), 10) || 10);
    } else {
      sql += ` ORDER BY total_spent DESC`;
    }
    // Precisa de identifier válido para enviar.
    return (db.prepare(sql).all(...params) as any[]).filter(c => c.identifier);
  }

  /** Cria a campanha (status draft) e materializa os destinatários. */
  static createCampaign(orgId: string, params: {
    name: string; message: string; segment: any; channelId?: string; createdBy?: string;
  }): { id: string; total: number } {
    const recipients = this.resolveSegment(orgId, params.segment);
    const id = uuidv4();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO campaigns (id, organization_id, name, message, segment, status, channel_id, total_targets, created_by)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?)
      `).run(id, orgId, params.name, params.message, JSON.stringify(params.segment || {}), params.channelId || null, recipients.length, params.createdBy || null);
      const ins = db.prepare(`INSERT INTO campaign_recipients (id, campaign_id, organization_id, contact_id, identifier) VALUES (?, ?, ?, ?, ?)`);
      for (const r of recipients) ins.run(uuidv4(), id, orgId, r.id, r.identifier);
    });
    tx();
    return { id, total: recipients.length };
  }

  /**
   * Cria a campanha (status draft) para uma LISTA EXPLÍCITA de contatos.
   * Usada pelo loop de recuperação do RIC (ação → campanha de recuperação).
   * Respeita opt-out e exige identifier válido. Não envia nada — fica em draft
   * para o usuário revisar e disparar (guardrail de aprovação humana).
   */
  static createCampaignForContacts(orgId: string, params: {
    name: string; message: string; contactIds: string[]; createdBy?: string;
  }): { id: string | null; total: number } {
    const ids = Array.from(new Set((params.contactIds || []).map(String))).slice(0, 500);
    if (!ids.length) return { id: null, total: 0 };
    const ph = ids.map(() => "?").join(",");
    const recipients = (db.prepare(
      `SELECT id, name, identifier FROM contacts WHERE organization_id = ? AND id IN (${ph}) AND COALESCE(marketing_opt_out,0) = 0`
    ).all(orgId, ...ids) as any[]).filter(c => c.identifier);
    if (!recipients.length) return { id: null, total: 0 };
    const id = uuidv4();
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO campaigns (id, organization_id, name, message, segment, status, channel_id, total_targets, created_by)
        VALUES (?, ?, ?, ?, ?, 'draft', NULL, ?, ?)
      `).run(id, orgId, params.name, params.message, JSON.stringify({ source: "ric" }), recipients.length, params.createdBy || null);
      const ins = db.prepare(`INSERT INTO campaign_recipients (id, campaign_id, organization_id, contact_id, identifier) VALUES (?, ?, ?, ?, ?)`);
      for (const r of recipients) ins.run(uuidv4(), id, orgId, r.id, r.identifier);
    });
    tx();
    return { id, total: recipients.length };
  }

  /** Resolve o canal de envio (o passado, ou o primeiro Evolution/WhatsApp conectado). */
  private static resolveChannel(orgId: string, channelId?: string): any {
    if (channelId) return db.prepare('SELECT * FROM channels WHERE id = ? AND organization_id = ?').get(channelId, orgId);
    return db.prepare(`SELECT * FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId);
  }

  /**
   * Inicia o envio em background (não bloqueia a request). Throttle entre msgs.
   */
  static async startCampaign(orgId: string, campaignId: string, io?: any): Promise<{ started: boolean; reason?: string }> {
    if (this.running.has(orgId)) return { started: false, reason: "Já existe uma campanha em envio para esta organização." };
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND organization_id = ?').get(campaignId, orgId) as any;
    if (!campaign) return { started: false, reason: "Campanha não encontrada." };
    if (campaign.status === 'running') return { started: false, reason: "Campanha já está em execução." };

    const channel = this.resolveChannel(orgId, campaign.channel_id);
    if (!channel) return { started: false, reason: "Nenhum canal conectado para enviar." };

    db.prepare(`UPDATE campaigns SET status = 'running', started_at = CURRENT_TIMESTAMP, channel_id = ? WHERE id = ?`).run(channel.id, campaignId);
    this.running.add(orgId);

    // Dispara o loop sem await (background).
    this.runLoop(orgId, campaignId, channel.id, campaign.message, io).catch(e => {
      console.error('[Campaign] Loop falhou:', e);
      this.running.delete(orgId);
    });
    return { started: true };
  }

  static pauseCampaign(orgId: string, campaignId: string) {
    db.prepare(`UPDATE campaigns SET status = 'paused' WHERE id = ? AND organization_id = ? AND status = 'running'`).run(campaignId, orgId);
  }

  private static delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

  private static personalize(template: string, name?: string): string {
    const first = (name || '').trim().split(/\s+/)[0] || 'tudo bem';
    return template.replace(/\{nome\}/gi, first);
  }

  /** Loop de envio com throttle e checagem de pausa/limite diário. */
  private static async runLoop(orgId: string, campaignId: string, channelId: string, message: string, io?: any) {
    const MIN = parseInt(process.env.CAMPAIGN_MIN_DELAY_MS || '4000', 10);
    const MAX = parseInt(process.env.CAMPAIGN_MAX_DELAY_MS || '9000', 10);
    const DAILY = parseInt(process.env.CAMPAIGN_DAILY_LIMIT || '300', 10);
    let sentToday = 0;

    try {
      while (true) {
        const camp = db.prepare('SELECT status FROM campaigns WHERE id = ?').get(campaignId) as any;
        if (!camp || camp.status !== 'running') break; // pausada/cancelada

        if (DAILY > 0 && sentToday >= DAILY) {
          db.prepare(`UPDATE campaigns SET status = 'paused' WHERE id = ?`).run(campaignId);
          console.log(`[Campaign] Limite diário (${DAILY}) atingido; pausada.`);
          break;
        }

        const rec = db.prepare(`SELECT * FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending' LIMIT 1`).get(campaignId) as any;
        if (!rec) {
          db.prepare(`UPDATE campaigns SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(campaignId);
          break;
        }

        // Respeita opt-out que pode ter mudado depois da criação.
        const contact = db.prepare('SELECT name, marketing_opt_out FROM contacts WHERE id = ?').get(rec.contact_id) as any;
        if (contact?.marketing_opt_out) {
          db.prepare(`UPDATE campaign_recipients SET status = 'skipped', error = 'opt-out' WHERE id = ?`).run(rec.id);
          continue;
        }

        try {
          await MessageProviderService.sendMessage(channelId, rec.identifier, this.personalize(message, contact?.name));
          db.prepare(`UPDATE campaign_recipients SET status = 'sent', sent_at = CURRENT_TIMESTAMP WHERE id = ?`).run(rec.id);
          db.prepare(`UPDATE campaigns SET sent_count = sent_count + 1 WHERE id = ?`).run(campaignId);
          sentToday++;
        } catch (e: any) {
          db.prepare(`UPDATE campaign_recipients SET status = 'failed', error = ? WHERE id = ?`).run(String(e?.message || e).slice(0, 300), rec.id);
          db.prepare(`UPDATE campaigns SET failed_count = failed_count + 1 WHERE id = ?`).run(campaignId);
        }

        if (io) {
          const c = db.prepare('SELECT sent_count, failed_count, total_targets FROM campaigns WHERE id = ?').get(campaignId) as any;
          io.to(`org:${orgId}`).emit('campaign_progress', { campaignId, ...c });
        }

        // Throttle anti-ban: intervalo aleatório entre envios.
        await this.delay(MIN + Math.floor(Math.random() * Math.max(0, MAX - MIN)));
      }
    } finally {
      this.running.delete(orgId);
    }
  }

  static getCampaign(orgId: string, id: string): any {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND organization_id = ?').get(id, orgId) as any;
    if (!c) return null;
    c.recipients = db.prepare(`SELECT status, count(*) as count FROM campaign_recipients WHERE campaign_id = ? GROUP BY status`).all(id);
    return c;
  }

  static listCampaigns(orgId: string): any[] {
    return db.prepare('SELECT * FROM campaigns WHERE organization_id = ? ORDER BY created_at DESC').all(orgId) as any[];
  }
}
