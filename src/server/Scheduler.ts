import db from "./db.js";
import { CampaignService } from "./CampaignService.js";

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
    // Checa a cada 6 horas (barato; a trava semanal evita repetição).
    const INTERVAL = parseInt(process.env.SCHEDULER_INTERVAL_MS || `${6 * 60 * 60 * 1000}`, 10);
    this.timer = setInterval(() => this.tick().catch(e => console.error('[Scheduler] tick falhou', e)), INTERVAL);
    // Primeira checagem logo após o boot (com um pequeno atraso).
    setTimeout(() => this.tick().catch(() => {}), 30_000);
    console.log('[Scheduler] iniciado (reativação automática).');
  }

  static async tick() {
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
}
