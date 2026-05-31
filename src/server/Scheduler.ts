import db from "./db.js";
import { CampaignService } from "./CampaignService.js";
import { MessageProviderService } from "./MessageProviderService.js";

/**
 * Agendador interno (sem dependência externa de cron). Roda em intervalo e
 * executa tarefas automáticas — hoje: REATIVAÇÃO semanal de clientes inativos.
 *
 * Ativação por organização (opt-in): organization_settings.auto_reactivation_enabled.
 * Só dispara no máximo 1x por semana (auto_reactivation_last_run).
 */
export class Scheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static io: any = null;

  static start(io?: any) {
    this.io = io;
    if (this.timer) return;
    // Checa de hora em hora (barato; travas internas evitam repetição).
    const INTERVAL = parseInt(process.env.SCHEDULER_INTERVAL_MS || `${60 * 60 * 1000}`, 10);
    this.timer = setInterval(() => this.tick().catch(e => console.error('[Scheduler] tick falhou', e)), INTERVAL);
    // Primeira checagem logo após o boot (com um pequeno atraso).
    setTimeout(() => this.tick().catch(() => {}), 30_000);
    console.log('[Scheduler] iniciado (reativação automática + lembretes de agendamento).');
  }

  static async tick() {
    await this.reactivationPass().catch(e => console.error('[Scheduler] reativação falhou', e));
    await this.reminderPass().catch(e => console.error('[Scheduler] lembretes falhou', e));
  }

  /** Reativação automática semanal (opt-in por organização). */
  static async reactivationPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, auto_reactivation_days, auto_reactivation_message, auto_reactivation_last_run
        FROM organization_settings
        WHERE COALESCE(auto_reactivation_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        // Trava semanal: só roda se passou ~7 dias do último envio.
        const last = org.auto_reactivation_last_run ? new Date(org.auto_reactivation_last_run).getTime() : 0;
        if (Date.now() - last < 7 * 24 * 60 * 60 * 1000) continue;

        const days = org.auto_reactivation_days || 60;
        const segment = { inactiveDays: days };
        const targets = CampaignService.resolveSegment(org.organization_id, segment);
        // Marca o run mesmo sem alvos, para não ficar tentando todo tick.
        db.prepare(`UPDATE organization_settings SET auto_reactivation_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(org.organization_id);
        if (targets.length === 0) continue;

        const message = org.auto_reactivation_message
          || "Olá {nome}! Sentimos sua falta por aqui 😊 Preparamos novidades que podem te interessar. Posso te mostrar?";
        const created = CampaignService.createCampaign(org.organization_id, {
          name: `Reativação automática (${new Date().toLocaleDateString('pt-BR')})`,
          message, segment, createdBy: 'scheduler',
        });
        await CampaignService.startCampaign(org.organization_id, created.id, this.io);
        console.log(`[Scheduler] Reativação automática disparada para org ${org.organization_id}: ${created.total} contatos.`);
      } catch (e) {
        console.error('[Scheduler] Falha na reativação da org', org.organization_id, e);
      }
    }
  }

  /**
   * Lembretes de agendamento (opt-in por organização). Para cada agendamento
   * que começa dentro da "janela de antecedência" (ex.: nas próximas 24h) e
   * ainda não recebeu lembrete, envia ao cliente pelo WhatsApp e marca
   * reminder_status='sent' (envia uma vez só).
   */
  static async reminderPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, appointment_reminder_hours, appointment_reminder_message
        FROM organization_settings
        WHERE COALESCE(appointment_reminders_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const hours = org.appointment_reminder_hours || 24;
        // Agendamentos ainda no futuro, dentro da janela, sem lembrete enviado.
        const appts = db.prepare(`
          SELECT a.*, c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel
          FROM appointments a
          JOIN contacts c ON c.id = a.contact_id
          WHERE a.organization_id = ?
            AND a.status NOT IN ('cancelled','completed','no_show')
            AND COALESCE(a.reminder_status,'') != 'sent'
            AND a.scheduled_start IS NOT NULL
            AND a.scheduled_start >= datetime('now')
            AND a.scheduled_start <= datetime('now', ?)
        `).all(org.organization_id, `+${hours} hours`) as any[];

        if (!appts.length) continue;

        // Canal de envio (o do contato, ou o primeiro conectado).
        const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(org.organization_id) as any;

        for (const a of appts) {
          try {
            if (!a.contact_number) { db.prepare(`UPDATE appointments SET reminder_status = 'skipped' WHERE id = ?`).run(a.id); continue; }
            const channelId = a.contact_channel || fallbackChannel?.id;
            if (!channelId) continue;

            const when = new Date(a.scheduled_start).toLocaleString('pt-BR', { timeZone: process.env.TZ_DISPLAY || 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
            const first = (a.contact_name || '').trim().split(/\s+/)[0] || '';
            const tpl = org.appointment_reminder_message
              || "Olá {nome}! Passando para lembrar do seu agendamento: *{titulo}* em *{quando}*. Posso confirmar? 🙂";
            const message = tpl
              .replace(/\{nome\}/gi, first)
              .replace(/\{titulo\}/gi, a.title || 'seu agendamento')
              .replace(/\{quando\}/gi, when);

            await MessageProviderService.sendMessage(channelId, a.contact_number, message);
            db.prepare(`UPDATE appointments SET reminder_status = 'sent' WHERE id = ?`).run(a.id);
            console.log(`[Scheduler] Lembrete enviado para ${a.contact_number} (agendamento ${a.id}).`);
          } catch (e) {
            console.error('[Scheduler] Falha ao enviar lembrete do agendamento', a.id, e);
          }
        }
      } catch (e) {
        console.error('[Scheduler] Falha nos lembretes da org', org.organization_id, e);
      }
    }
  }
}
