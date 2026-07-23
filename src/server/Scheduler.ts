import db from "./db.js";
import { CampaignService } from "./CampaignService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { CadenceService } from "./CadenceService.js";
import { NotificationService } from "./NotificationService.js";
import { SubscriptionService } from "./SubscriptionService.js";
import { PaymentService } from "./PaymentService.js";
import { PlanService } from "./PlanService.js";
import { AsaasService } from "./AsaasService.js";
import { OrdersService } from "./OrdersService.js";
import { PurchaseRequisitionService } from "./PurchaseRequisitionService.js";
import { QuoteService } from "./QuoteService.js";
import { LgpdService } from "./LgpdService.js";
import { CustomerMemoryService } from "./CustomerMemoryService.js";
import { SatisfactionService } from "./SatisfactionService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";
import { GoogleAutomationService } from "./GoogleAutomationService.js";
import { TicketSlaService } from "./TicketSlaService.js";
import { OpportunityRadarService } from "./OpportunityRadarService.js";
import { InstagramService } from "./InstagramService.js";
import { BusinessTutorService } from "./BusinessTutorService.js";
import { ProspectDiscoveryService } from "./ProspectDiscoveryService.js";
import { MaestroService } from "./MaestroService.js";
import { JobQueueService } from "./JobQueueService.js";
import { RadarService } from "./RadarService.js";
import { FashionAvatarService } from "./FashionAvatarService.js";
import { FashionTryOnService } from "./FashionTryOnService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { RetailTaskService } from "./RetailOpsService.js";
import { RetailImpactService } from "./RetailImpactService.js";
import { AlterdataSyncRunner } from "./AlterdataSyncRunner.js";
import { BackupService } from "./BackupService.js";

// Quantos backups de redundância da plataforma manter por org (semanais).
const PLATFORM_BACKUP_KEEP = 8;

/**
 * Agendador interno (sem dependência externa de cron). Roda em intervalo e
 * executa tarefas automáticas — hoje: REATIVAÇÃO semanal de clientes inativos.
 *
 * Ativação por organização (opt-in): organization_settings.auto_reactivation_enabled.
 * Só dispara no máximo 1x por semana (auto_reactivation_last_run).
 */
export class Scheduler {
  private static timer: NodeJS.Timeout | null = null;
  private static fastTimer: NodeJS.Timeout | null = null;
  private static io: any = null;

  static start(io?: any) {
    this.io = io;
    if (this.timer) return;
    // Checa de hora em hora (barato; travas internas evitam repetição).
    const INTERVAL = parseInt(process.env.SCHEDULER_INTERVAL_MS || `${60 * 60 * 1000}`, 10);
    this.timer = setInterval(() => this.tick().catch(e => console.error('[Scheduler] tick falhou', e)), INTERVAL);
    // Primeira checagem logo após o boot (com um pequeno atraso).
    setTimeout(() => this.tick().catch(() => {}), 30_000);
    // Timer rápido (5 min): lembretes de PIX e publicação de posts agendados,
    // ambos sensíveis a minutos.
    const FAST = parseInt(process.env.SCHEDULER_FAST_INTERVAL_MS || `${5 * 60 * 1000}`, 10);
    this.fastTimer = setInterval(() => this.fastPass().catch(e => console.error('[Scheduler] passe rápido falhou', e)), FAST);
    // Atraso da primeira passada rápida — configurável só para teste automatizado
    // (scripts/test-vision-maestro-bridge.ts) não precisar esperar 45s de verdade.
    const FAST_INITIAL_DELAY = parseInt(process.env.SCHEDULER_FAST_INITIAL_DELAY_MS || '45000', 10);
    setTimeout(() => this.fastPass().catch(() => {}), FAST_INITIAL_DELAY);
    console.log('[Scheduler] iniciado (reativação automática + lembretes de agendamento + cadências de follow-up + lembretes de PIX + posts agendados).');
  }

  /** Passe rápido (5 min): tarefas sensíveis a minutos. */
  static async fastPass() {
    await this.pixReminderPass().catch(e => console.error('[Scheduler] lembrete PIX falhou', e));
    await InstagramService.publishScheduledPass().catch(e => console.error('[Scheduler] publicação agendada falhou', e));
    try { MaestroService.reactToVisionEvents(); } catch (e) { console.error('[Scheduler] ponte Vision VMS -> Tarefas falhou', e); }
    // Rede de segurança da fila de jobs (JobQueueService): reprocessa jobs que
    // ficaram travados por reinício do processo — o caminho normal (setImmediate
    // no enqueue) já resolve o caso comum sem esperar este passe.
    try { JobQueueService.sweepStale(); } catch (e) { console.error('[Scheduler] varredura da fila de jobs falhou', e); }
    // SLA de primeira resposta: sensível a minutos (uma meta de 30 min não pode
    // ser vigiada de hora em hora), então mora no passe rápido.
    try { this.ticketSlaPass(); } catch (e: any) { console.error('[Scheduler] SLA de tickets falhou', e.message); }
    // Retail Ops (ADR-083, Fase D): cobrança de fechamento/malote/escala. No
    // passe rápido porque a recobrança é sensível a minutos (retry_minutes).
    await this.retailCobrancaPass().catch(e => console.error('[Scheduler] cobrança Retail Ops falhou', e));
  }

  /**
   * Retail Ops (ADR-083, Fase D) — cobra as pendências VENCIDAS por WhatsApp
   * (fechamento/malote/escala), com retry e escalonamento ao gestor após o teto.
   * Reusa o padrão pixReminderPass (canal de fallback da org). Best-effort.
   */
  static async retailCobrancaPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT organization_id FROM organization_settings
          WHERE COALESCE(retail_daily_closing_enabled,0)=1
             OR COALESCE(retail_malote_enabled,0)=1
             OR COALESCE(retail_scale_reminder_enabled,0)=1`
      ).all() as any[];
    } catch { return; }
    const now = new Date().toISOString().replace("T", " ").slice(0, 19); // 'YYYY-MM-DD HH:MM:SS' (UTC)
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        if (!channel) continue; // sem canal não há como cobrar
        await RetailTaskService.runReminders(orgId, {
          now,
          send: (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message),
          notify: ({ store, task }) => {
            try {
              NotificationService.push({
                organizationId: orgId,
                title: `Pendência de ${task.task_type} sem resposta`,
                message: `A loja ${store.name} não enviou o ${task.task_type} de hoje após várias cobranças. Acompanhe com o responsável.`,
                type: "alert",
                dedupeKey: `retail_escalate:${task.id}`,
                dedupeWindowMin: 720,
              });
            } catch { /* noop */ }
          },
        });
      } catch (e) { console.error("[Retail] cobrança da org falhou", orgId, e); }
    }
  }

  /**
   * Tutor de Gestão no WhatsApp (ADR-131): resumos proativos ao DONO — manhã
   * (Fatia 1) e meio-dia/ponto de equilíbrio (Fatia 2). Só orgs com opt-in; o
   * serviço decide janela/dedupe/número/aplicabilidade. Best-effort, 1 loop.
   */
  static async tutorPass() {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE COALESCE(tutor_wa_enabled,0)=1`).all() as any[]; } catch { return; }
    if (!orgs.length) return;
    const now = new Date();
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        if (!channel) continue; // sem canal conectado não há como enviar
        const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
        await BusinessTutorService.runMorningPass(orgId, { now, send });
        await BusinessTutorService.runMiddayPass(orgId, { now, send });
      } catch (e) { console.error("[Tutor] passe da org falhou", orgId, e); }
    }
  }

  static async tick() {
    await this.reactivationPass().catch(e => console.error('[Scheduler] reativação falhou', e));
    await this.reminderPass().catch(e => console.error('[Scheduler] lembretes falhou', e));
    await CadenceService.processTick(this.io).catch(e => console.error('[Scheduler] cadências falhou', e));
    await this.subscriptionPass().catch(e => console.error('[Scheduler] assinaturas falhou', e));
    await this.orderExpiryPass().catch(e => console.error('[Scheduler] expiração de pedidos falhou', e));
    await PurchaseRequisitionService.pass().catch(e => console.error('[Scheduler] reposição falhou', e));
    await QuoteService.passFollowupAndExpire(this.io).catch(e => console.error('[Scheduler] follow-up de orçamento falhou', e));
    try { LgpdService.retentionPass(); } catch (e) { console.error('[Scheduler] retenção LGPD falhou', e); }
    // Retenção de avatar do Provador Virtual (FAS-1, ADR-035): apaga o ARQUIVO
    // da foto vencida — mesmo espírito do retentionPass, dado mais sensível.
    try { FashionAvatarService.purgeExpired(); } catch (e) { console.error('[Scheduler] retenção de avatar (fashion) falhou', e); }
    // Resultados de try-on vencidos (FAS-3, ADR-037): mesma janela de retenção.
    try { FashionTryOnService.purgeExpired(); } catch (e) { console.error('[Scheduler] retenção de try-on (fashion) falhou', e); }
    await this.abandonedCartPass().catch(e => console.error('[Scheduler] carrinho abandonado falhou', e));
    await this.npsPass().catch(e => console.error('[Scheduler] pesquisa de satisfação falhou', e));
    await this.memoryPass().catch(e => console.error('[Scheduler] memória do cliente falhou', e));
    await ProspectDiscoveryService.runDue().catch(e => console.error('[Scheduler] descoberta de prospecção falhou', e));
    try { RadarService.reassessmentReminderPass(); } catch (e) { console.error('[Scheduler] lembrete de reavaliação do Radar falhou', e); }
    await this.repurchaseReminderPass().catch(e => console.error('[Scheduler] lembrete de recompra falhou', e));
    await this.googleSheetsSyncPass().catch(e => console.error('[Scheduler] sync Google Sheets falhou', e));
    await this.backupPass().catch(e => console.error('[Scheduler] backup automático falhou', e));
    try { this.opportunityRadarPass(); } catch (e: any) { console.error('[Scheduler] radar de oportunidades falhou', e.message); }
    try { this.ricSnapshotPass(); } catch (e: any) { console.error('[Scheduler] ricSnapshotPass error', e.message); }
    try { this.retailImpactSnapshotPass(); } catch (e: any) { console.error('[Scheduler] retailImpactSnapshotPass error', e.message); }
    try { this.retailDailyTasksPass(); } catch (e: any) { console.error('[Scheduler] retailDailyTasksPass error', e.message); }
    try { AlterdataSyncRunner.alterdataSyncPass(); } catch (e: any) { console.error('[Scheduler] alterdataSyncPass error', e.message); }
    this.trialPass();
    await this.tutorPass().catch(e => console.error('[Scheduler] tutor falhou', e));
    await this.billingDunningPass().catch(e => console.error('[Scheduler] régua de inadimplência falhou', e));
  }

  /**
   * Régua de inadimplência ZappFlow → lojista (ADR-091 §8, Bloco B). Percorre as
   * orgs com assinatura ASAAS em cobrança e avança o estágio conforme os dias em
   * relação ao vencimento (current_period_end). Idempotente: só age quando o
   * estágio MUDA (billing_dunning_stage). Mapeia para o nosso modelo de estados:
   *  D-5/D-1 → avisos (past_due só a partir do atraso)
   *  D+1..D+7 → past_due (grace: IA continua respondendo) + avisos escalados
   *  D+10 → suspended (IA para via aiAllowed + somente-leitura via middleware)
   *  D+30 → cancelamento contratual (cancela a assinatura no ASAAS)
   *
   * MONEY-CRITICAL: antes de suspender/cancelar (D+10+), RE-CONSULTA o ASAAS —
   * um webhook perdido NUNCA pode bloquear um lojista que de fato pagou.
   */
  static async billingDunningPass() {
    const orgs = db.prepare(`
      SELECT organization_id, current_period_end, billing_status, billing_dunning_stage
      FROM organization_settings
      WHERE payment_provider = 'asaas' AND external_subscription_id IS NOT NULL
        AND billing_status IN ('active','past_due')
        AND current_period_end IS NOT NULL AND deleted_at IS NULL`).all() as any[];
    const DAY = 86400000;
    for (const o of orgs) {
      try {
        const due = new Date(String(o.current_period_end).slice(0, 10) + "T00:00:00Z").getTime();
        if (isNaN(due)) continue;
        const daysOverdue = Math.floor((Date.now() - due) / DAY); // <0 = antes do vencimento
        const stage = this.dunningStage(daysOverdue);
        if (!stage || stage === o.billing_dunning_stage) continue; // idempotente: só na mudança

        // Antes de qualquer suspensão/cancelamento, confirma no ASAAS que está mesmo em atraso.
        if (daysOverdue >= 10) {
          const paid = await this.asaasSaysPaid(o.organization_id, String(o.current_period_end).slice(0, 10)).catch(() => false);
          if (paid) { PlanService.setBillingStatus(o.organization_id, "active"); this.markDunning(o.organization_id, null); continue; }
        }
        await this.applyDunningStage(o.organization_id, daysOverdue, stage);
        this.markDunning(o.organization_id, stage);
      } catch (e) { console.error("[Scheduler] dunning de uma org falhou", e); }
    }
  }

  /** Rótulo do estágio da régua a partir dos dias de atraso (bandas exclusivas). */
  private static dunningStage(daysOverdue: number): string | null {
    if (daysOverdue >= 30) return "D+30";
    if (daysOverdue >= 10) return "D+10";
    if (daysOverdue >= 7) return "D+7";
    if (daysOverdue >= 5) return "D+5";
    if (daysOverdue >= 3) return "D+3";
    if (daysOverdue >= 1) return "D+1";
    if (daysOverdue >= -1) return "D-1";   // véspera / dia do vencimento
    if (daysOverdue >= -6) return "D-5";   // aviso preventivo
    return null;
  }

  /** Aplica o efeito do estágio (transição de billing + notificação in-app deduplicada). */
  private static async applyDunningStage(orgId: string, daysOverdue: number, stage: string) {
    if (stage === "D+30") {
      try { await AsaasService.cancelSubscription(orgId); } catch (e) { PlanService.setBillingStatus(orgId, "cancelled"); }
      NotificationService.push({ organizationId: orgId, type: "alert", title: "🚫 Assinatura cancelada por falta de pagamento", message: "Sua conta foi cancelada. Seus dados ficam preservados por 30 dias. Regularize em Configurações → Cobrança para reativar.", dedupeKey: "billing:D+30", dedupeWindowMin: 1440 });
      return;
    }
    if (stage === "D+10") {
      PlanService.setBillingStatus(orgId, "suspended");
      NotificationService.push({ organizationId: orgId, type: "alert", title: "⛔ Conta suspensa por falta de pagamento", message: "A IA parou de responder e a conta ficou em modo somente-leitura. Seus dados continuam visíveis. Pague a fatura em Configurações → Cobrança para reativar na hora.", dedupeKey: "billing:D+10", dedupeWindowMin: 1440 });
      return;
    }
    // D+1..D+7: entra em atraso (past_due) mas a IA continua; avisos escalados.
    if (daysOverdue >= 1) PlanService.setBillingStatus(orgId, "past_due");
    const msgs: Record<string, { t: string; m: string }> = {
      "D-5": { t: "🔔 Sua fatura vence em breve", m: "Sua mensalidade do ZappFlow vence em alguns dias. Deixe o pagamento em dia para não interromper o atendimento." },
      "D-1": { t: "🔔 Sua fatura vence amanhã", m: "A mensalidade do ZappFlow vence em 1 dia. Pague em Configurações → Cobrança." },
      "D+1": { t: "⚠️ Fatura em atraso", m: "Sua mensalidade venceu ontem. Regularize em Configurações → Cobrança para manter o acesso." },
      "D+3": { t: "⚠️ Fatura ainda em atraso", m: "Sua mensalidade segue em aberto. Evite a suspensão do atendimento automático regularizando agora." },
      "D+5": { t: "⚠️ Vamos resolver?", m: "Sua fatura está atrasada há 5 dias. Fale com o suporte se precisar de parcelamento ou prorrogação." },
      "D+7": { t: "⏳ Suspensão próxima", m: "Sua conta será suspensa em breve se a fatura não for paga. Regularize em Configurações → Cobrança." },
    };
    const n = msgs[stage];
    if (n) NotificationService.push({ organizationId: orgId, type: "alert", title: n.t, message: n.m, dedupeKey: `billing:${stage}`, dedupeWindowMin: 1440 });
  }

  private static markDunning(orgId: string, stage: string | null) {
    db.prepare(`UPDATE organization_settings SET billing_dunning_stage = ?, billing_dunning_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(stage, orgId);
  }

  /** Confirma no ASAAS se a fatura do ciclo atual foi paga (guarda anti-bloqueio indevido). */
  private static async asaasSaysPaid(orgId: string, periodEnd: string): Promise<boolean> {
    try {
      const invs = await AsaasService.listInvoices(orgId);
      const PAID = ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"];
      // Paga se a fatura do vencimento atual (ou posterior) está confirmada.
      return invs.some(i => PAID.includes(i.status) && String(i.dueDate).slice(0, 10) >= periodEnd);
    } catch { return false; }
  }

  /**
   * Retail Ops (ADR-083, Fase B) — gera as pendências operacionais do dia
   * (fechamento/malote/escala) por loja ativa, para as orgs que ligaram alguma
   * das automações retail_*. Idempotente (UNIQUE por org/loja/dia/tipo), então
   * rodar de hora em hora só cria o que faltar. A COBRANÇA por WhatsApp é a
   * Fase D; aqui só o esqueleto de pendências. Best-effort — nunca derruba tick.
   */
  static retailDailyTasksPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT organization_id FROM organization_settings
          WHERE COALESCE(retail_daily_closing_enabled,0)=1
             OR COALESCE(retail_malote_enabled,0)=1
             OR COALESCE(retail_scale_reminder_enabled,0)=1`
      ).all() as any[];
    } catch { return; } // colunas ainda não migradas
    const date = new Date().toISOString().slice(0, 10);
    for (const o of orgs) {
      try { RetailTaskService.generateDay(o.organization_id, date); } catch (e) { console.error('[Retail] generateDay falhou', o.organization_id, e); }
    }
  }

  /**
   * Radar de Oportunidades Disfarçadas (Tier 2, Carlos Domingos, ADR-046).
   * Roda uma vez por semana por org (dedupe via opportunity_radar_last_run):
   * varre reclamações, cancelamentos, faltas de estoque, "não temos" e demora,
   * e cria/atualiza oportunidades no banco. Best-effort — nunca derruba tick.
   */
  static opportunityRadarPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id
          FROM organization_settings
         WHERE opportunity_radar_last_run IS NULL
            OR opportunity_radar_last_run < datetime('now', '-7 days')
      `).all() as any[];
    } catch (e) { return; }
    for (const o of orgs) {
      try {
        const found = OpportunityRadarService.scan(o.organization_id);
        if (found.length > 0) console.log(`[Scheduler] Radar de Oportunidades (org ${o.organization_id}): ${found.length} oportunidades ativas`);
      } catch (e) { console.error(`[Scheduler] radar oportunidades org ${o.organization_id} falhou`, e); }
    }
  }

  /**
   * Google Sheets live sync (opt-in por org): reescreve a planilha viva de cada
   * organização com google_sync_enabled = 1 — Vendas/Estoque/Resumo sempre no
   * estado atual. Roda a cada tick horário; cada org é best-effort e isolada
   * num try/catch (uma conexão Google expirada não derruba as demais).
   */
  static async googleSheetsSyncPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE COALESCE(google_sync_enabled, 0) = 1`).all() as any[];
    } catch (e) { return; } // coluna ainda não migrada
    for (const o of orgs) {
      try {
        const r = await GoogleAutomationService.syncLiveSheet(o.organization_id);
        if (r.ok) console.log(`[Scheduler] Google Sheets sincronizado (org ${o.organization_id}): ${r.counts?.vendas || 0} vendas, ${r.counts?.estoque || 0} itens`);
      } catch (e) { console.error(`[Scheduler] sync Google Sheets org ${o.organization_id} falhou`, e); }
    }
  }

  /**
   * Backup automático (ADR-097). Roda no tick horário — como o primeiro tick é
   * ~30s após o boot, isto também cobre o "backup no boot se estiver vencido"
   * (mitigação de queda de luz). NÃO usamos SIGTERM: o supervisor (ADR-008)
   * assume que o core morre imediatamente ao receber o sinal.
   *
   * Dois destinos, dois donos (ADR-097):
   *  1) BACKUP DO CLIENTE (opt-in) — destino Drive do dono + espelho, com retenção.
   *  2) REDUNDÂNCIA DA PLATAFORMA — toda org ativa, no mínimo semanal, na NOSSA
   *     infra (S3), independente do opt-in e da conta Google do cliente.
   */
  static async backupPass() {
    // 1) Backup programado do cliente (opt-in).
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, COALESCE(backup_frequency,'daily') AS freq,
               COALESCE(backup_retention,30) AS retention,
               COALESCE(backup_to_drive,1) AS to_drive, backup_auto_last_run
        FROM organization_settings
        WHERE COALESCE(backup_auto_enabled,0) = 1
      `).all() as any[];
    } catch (e) { orgs = []; } // colunas ainda não migradas

    const HOUR = 3600 * 1000, DAY = 24 * HOUR;
    const freqMs: Record<string, number> = { daily: DAY, '2x_week': 3.5 * DAY, weekly: 7 * DAY };
    for (const o of orgs) {
      try {
        const interval = freqMs[o.freq] || DAY;
        const last = o.backup_auto_last_run ? new Date(o.backup_auto_last_run).getTime() : 0;
        // Margem de 1h para não escorregar por causa do horário do tick.
        if (Date.now() - last < interval - HOUR) continue;
        const r = await BackupService.runAndDistribute(o.organization_id, 'auto', { toDrive: !!o.to_drive });
        db.prepare(`UPDATE organization_settings SET backup_auto_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(o.organization_id);
        if (r) {
          await BackupService.applyRetention(o.organization_id, o.retention, 'auto');
          console.log(`[Scheduler] Backup automático (org ${o.organization_id}): ${r.fileName}`);
        }
      } catch (e) { console.error('[Scheduler] backup automático da org falhou', o.organization_id, e); }
    }

    // 2) Redundância da plataforma (operador): TODA org ativa, no mínimo semanal,
    //    na nossa infra (S3). Independe do opt-in do cliente. Sem envio ao Drive.
    let allOrgs: any[] = [];
    try {
      allOrgs = db.prepare(`
        SELECT organization_id, backup_platform_last_run
        FROM organization_settings
        WHERE deleted_at IS NULL
      `).all() as any[];
    } catch (e) { allOrgs = []; }
    const WEEK = 7 * DAY;
    for (const o of allOrgs) {
      try {
        const last = o.backup_platform_last_run ? new Date(o.backup_platform_last_run).getTime() : 0;
        if (Date.now() - last < WEEK - HOUR) continue;
        const r = await BackupService.runAndDistribute(o.organization_id, 'platform', { toDrive: false });
        db.prepare(`UPDATE organization_settings SET backup_platform_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(o.organization_id);
        if (r) await BackupService.applyRetention(o.organization_id, PLATFORM_BACKUP_KEEP, 'platform');
      } catch (e) { console.error('[Scheduler] redundância da plataforma falhou', o.organization_id, e); }
    }
  }

  /**
   * SLA de primeira resposta por prioridade/segmento (opt-in por org): recalcula
   * o prazo de cada ticket aberto, marca estouros e notifica o responsável no 1º
   * estouro sem resposta. Cada org isolada num try/catch.
   */
  static ticketSlaPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE COALESCE(sla_monitor_enabled, 0) = 1`).all() as any[];
    } catch (e) { return; } // colunas ainda não migradas
    for (const o of orgs) {
      try {
        const r = TicketSlaService.evaluateOrg(o.organization_id);
        if (r.notified > 0) console.log(`[Scheduler] SLA (org ${o.organization_id}): ${r.breached} estourado(s), ${r.notified} nova(s) notificação(ões)`);
      } catch (e) { console.error(`[Scheduler] SLA org ${o.organization_id} falhou`, e); }
    }
  }

  /**
   * Memória de relacionamento: quando uma conversa fica ociosa (sem novas
   * mensagens por ~30 min) e tem conteúdo novo desde a última extração, a IA
   * resume e guarda os fatos durÁveis do cliente (pet, família, preferências…)
   * para criar rapport quando ele voltar. Opt-out via ai_memory_enabled = 0.
   * Roda em lote (limite por org) para controlar custo de IA.
   */
  static async memoryPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id FROM organization_settings
        WHERE COALESCE(ai_memory_enabled, 1) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      const orgId = org.organization_id;
      try {
        // Contatos com conversa ociosa (>30 min) e conteúdo novo desde a última memória.
        const rows = db.prepare(`
          SELECT t.contact_id AS contact_id,
                 MAX(m.created_at) AS last_msg,
                 c.memory_updated_at AS mem_at,
                 SUM(CASE WHEN m.sender_type = 'contact' THEN 1 ELSE 0 END) AS contact_msgs
          FROM messages m
          JOIN tickets t ON t.id = m.ticket_id
          JOIN contacts c ON c.id = t.contact_id
          WHERE m.organization_id = ?
          GROUP BY t.contact_id
          HAVING last_msg <= datetime('now', '-30 minutes')
             AND (mem_at IS NULL OR last_msg > mem_at)
             AND contact_msgs > 0
          LIMIT 25
        `).all(orgId) as any[];

        for (const r of rows) {
          try {
            const msgs = db.prepare(`
              SELECT m.sender_type, m.content
              FROM messages m
              JOIN tickets t ON t.id = m.ticket_id
              WHERE t.contact_id = ?
              ORDER BY m.created_at DESC LIMIT 20
            `).all(r.contact_id) as any[];
            const history = msgs.reverse()
              .filter(x => x.content)
              .map(x => ({
                role: x.sender_type === 'contact' ? 'Cliente' : (x.sender_type === 'agent' ? 'Atendente' : 'Assistente'),
                text: x.content,
              }));
            await CustomerMemoryService.extractAndMerge(orgId, r.contact_id, history);
          } catch (e) {
            console.error('[Scheduler] Falha ao extrair memória do contato', r.contact_id, e);
          }
        }
      } catch (e) {
        console.error('[Scheduler] Falha na memória da org', orgId, e);
      }
    }
  }

  /**
   * Expiração de pedidos não pagos (opt-in por organização). Cancela pedidos que
   * ficaram em 'aguardando_pagamento' por mais de N horas — o que LIBERA o estoque
   * reservado (via OrdersService.updateStatus) — e marca o ticket como 'perdido'.
   * Evita estoque preso e dá visibilidade da venda perdida no funil.
   */
  static async orderExpiryPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, COALESCE(order_expiry_hours,48) AS hours
        FROM organization_settings
        WHERE COALESCE(order_expiry_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const hours = Math.max(1, parseInt(String(org.hours || 48), 10) || 48);
        const stale = db.prepare(`
          SELECT id, ticket_id FROM orders
          WHERE organization_id = ?
            AND status = 'aguardando_pagamento'
            AND created_at <= datetime('now', ?)
          LIMIT 500
        `).all(org.organization_id, `-${hours} hours`) as any[];

        for (const o of stale) {
          try {
            OrdersService.updateStatus(org.organization_id, o.id, 'cancelado');
            if (o.ticket_id) {
              const tk = db.prepare("SELECT stage, contact_id FROM tickets WHERE id = ?").get(o.ticket_id) as any;
              // Só rebaixa para 'perdido' se o ticket ainda estava preso na cobrança.
              if (tk && tk.stage === 'aguardando_pagamento') {
                db.prepare("UPDATE tickets SET stage = 'perdido', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(o.ticket_id);
                if (this.io) this.io.to(`org:${org.organization_id}`).emit("ticket_stage_change", { ticketId: o.ticket_id, contactId: tk.contact_id, newStage: 'perdido' });
              }
            }
            console.log(`[Scheduler] Pedido ${o.id} expirado (não pago em ${hours}h): cancelado e estoque liberado.`);
          } catch (e) {
            console.error('[Scheduler] Falha ao expirar pedido', o.id, e);
          }
        }
      } catch (e) {
        console.error('[Scheduler] Falha na expiração de pedidos da org', org.organization_id, e);
      }
    }
  }

  /**
   * Snapshot diário do RIC — persiste IQR + dinheiro + drivers para cada org
   * ativa (roda no máximo 1x/dia; idempotente por (org, data)).
   */
  private static ricSnapshotPass() {
    const today = new Date().toISOString().slice(0, 10);
    if ((this as any)._lastRicSnap === today) return;
    (this as any)._lastRicSnap = today;

    const orgs = db.prepare(
      `SELECT DISTINCT organization_id FROM channels WHERE status NOT IN ('disabled','disconnected')`
    ).all() as any[];
    for (const o of orgs) {
      try { RevenueIntelligenceService.snapshotDaily(o.organization_id); } catch (e) { /* best-effort */ }
    }
  }

  /**
   * Snapshot diário do painel de valor/adoção do Retail Ops (ADR-085), para a
   * série histórica. Roda 1x/dia; idempotente por (org, dia). Só orgs com alguma
   * automação retail ligada.
   */
  private static retailImpactSnapshotPass() {
    const today = new Date().toISOString().slice(0, 10);
    if ((this as any)._lastRetailSnap === today) return;
    (this as any)._lastRetailSnap = today;

    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT organization_id FROM organization_settings
          WHERE COALESCE(retail_daily_closing_enabled,0)=1
             OR COALESCE(retail_quota_enabled,0)=1
             OR COALESCE(retail_commission_enabled,0)=1`
      ).all() as any[];
    } catch { return; } // colunas ainda não migradas
    for (const o of orgs) {
      try { RetailImpactService.snapshotDaily(o.organization_id, today); } catch (e) { /* best-effort */ }
    }
  }

  /** Avisa as orgs em trial quando faltam 3 dias ou menos para acabar. */
  static trialPass() {
    try {
      const orgs = db.prepare(`
        SELECT organization_id, trial_ends_at FROM organization_settings
        WHERE billing_status = 'trialing' AND trial_ends_at IS NOT NULL
          AND deleted_at IS NULL
          AND trial_ends_at >= datetime('now')
          AND trial_ends_at <= datetime('now', '+3 days')
      `).all() as any[];
      for (const o of orgs) {
        const daysLeft = Math.max(0, Math.ceil((new Date(o.trial_ends_at).getTime() - Date.now()) / 86400000));
        NotificationService.trialEnding(o.organization_id, daysLeft);
      }
    } catch (e) { /* noop — tabela/colunas podem não existir ainda */ }
  }

  /** Reativação automática por sequência progressiva (opt-in por organização).
   *  Cada contato passa por até 3 etapas (step 1→2→3), com intervalo semanal
   *  entre cada. Se o contato compra antes de receber todas, é removido da fila. */
  static async reactivationPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, auto_reactivation_days,
               auto_reactivation_message, auto_reactivation_message_2, auto_reactivation_message_3,
               auto_reactivation_last_run
        FROM organization_settings
        WHERE COALESCE(auto_reactivation_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    const DEFAULT_MSG_1 = "Olá {nome}! Sentimos sua falta por aqui 😊 Preparamos novidades que podem te interessar. Posso te mostrar?";
    const DEFAULT_MSG_2 = "Oi {nome}! Ainda temos condições especiais esperando por você. Quer dar uma olhada?";
    const DEFAULT_MSG_3 = "Última chamada, {nome}! 🎁 Preparamos algo exclusivo pra você. Me chama se quiser saber mais!";

    for (const org of orgs) {
      try {
        const last = org.auto_reactivation_last_run ? new Date(org.auto_reactivation_last_run).getTime() : 0;
        if (Date.now() - last < 7 * 24 * 60 * 60 * 1000) continue;

        const days = org.auto_reactivation_days || 60;
        const messages = [
          org.auto_reactivation_message || DEFAULT_MSG_1,
          org.auto_reactivation_message_2 || DEFAULT_MSG_2,
          org.auto_reactivation_message_3 || DEFAULT_MSG_3,
        ];

        const segment = { inactiveDays: days };
        const allTargets = CampaignService.resolveSegment(org.organization_id, segment);
        db.prepare(`UPDATE organization_settings SET auto_reactivation_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(org.organization_id);
        if (allTargets.length === 0) continue;

        const targetIds = new Set(allTargets.map((t: any) => t.id));
        const contactSteps = db.prepare(
          `SELECT id, COALESCE(reactivation_step, 0) AS step FROM contacts WHERE organization_id = ? AND id IN (${Array.from(targetIds).map(() => '?').join(',')})`,
        ).all(org.organization_id, ...targetIds) as any[];

        for (const step of [0, 1, 2]) {
          const contacts = contactSteps.filter((c: any) => c.step === step);
          if (contacts.length === 0) continue;
          if (step >= 3) continue;

          const message = messages[step];
          const stepContactIds = contacts.map((c: any) => c.id);
          if (stepContactIds.length === 0) continue;

          const created = CampaignService.createCampaignForContacts(org.organization_id, {
            name: `Reativação etapa ${step + 1} (${new Date().toLocaleDateString('pt-BR')})`,
            message, contactIds: stepContactIds, createdBy: 'scheduler',
          });
          if (!created.id) continue;
          await CampaignService.startCampaign(org.organization_id, created.id, this.io);

          const updateStmt = db.prepare(`UPDATE contacts SET reactivation_step = ?, reactivation_last_sent_at = CURRENT_TIMESTAMP WHERE id = ?`);
          for (const c of contacts) updateStmt.run(step + 1, c.id);
          console.log(`[Scheduler] Reativação etapa ${step + 1} para org ${org.organization_id}: ${created.total} contatos.`);
        }
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

  /**
   * Assinaturas / cobrança recorrente:
   *  1) gera a fatura do ciclo das assinaturas ativas vencidas;
   *  2) envia a cobrança (PIX) das faturas pendentes ainda não enviadas, pelo
   *     WhatsApp (e e-mail, se houver) — uma vez só;
   *  3) marca como vencidas as faturas pendentes há mais de N dias (atraso).
   */
  static async subscriptionPass() {
    // 1) GERAÇÃO: assinaturas ativas com vencimento no passado.
    let due: any[] = [];
    try {
      due = db.prepare(`
        SELECT id, organization_id FROM subscriptions
        WHERE status = 'active' AND next_charge_at IS NOT NULL AND next_charge_at <= datetime('now')
        LIMIT 1000
      `).all() as any[];
    } catch (e) { return; }
    for (const s of due) {
      try { SubscriptionService.generateInvoice(s.organization_id, s.id); } catch (e) { /* noop */ }
    }

    // 2) ENVIO: faturas pendentes ainda não cobradas (charge_ref nulo).
    let invs: any[] = [];
    try {
      invs = db.prepare(`
        SELECT i.id, i.organization_id, i.subscription_id, i.amount,
               c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel, c.id AS contact_id, c.email AS contact_email
        FROM subscription_invoices i
        JOIN subscriptions s ON s.id = i.subscription_id
        JOIN contacts c ON c.id = i.contact_id
        WHERE i.status = 'pending' AND (i.charge_ref IS NULL OR i.charge_ref = '')
          AND s.status IN ('active','past_due')
        LIMIT 500
      `).all() as any[];
    } catch (e) { invs = []; }

    for (const inv of invs) {
      try {
        const orgId = inv.organization_id;
        const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        const channelId = inv.contact_channel || fallbackChannel?.id;
        const first = (inv.contact_name || '').trim().split(/\s+/)[0] || '';

        // Mensagem de cobrança: PIX (se configurado) ou aviso simples do valor.
        let message = await PaymentService.chargeForSubscription(orgId, {
          invoiceId: inv.id, amount: inv.amount, contactName: inv.contact_name, contactId: inv.contact_id,
        });
        if (!message) {
          message = `Olá${first ? `, ${first}` : ''}! Sua mensalidade de R$ ${Number(inv.amount || 0).toFixed(2)} está disponível para pagamento. Qualquer dúvida, é só chamar. 🙂`;
        } else if (first) {
          message = `Olá, ${first}! ${message}`;
        }

        if (inv.contact_number && channelId) {
          await MessageProviderService.sendMessage(channelId, inv.contact_number, message);
        }
        // E-mail (best-effort) se houver e-mail e Google conectado.
        try {
          if (inv.contact_email && GoogleOAuthService.getConnection(orgId)) {
            await GoogleOAuthService.gmailSend(orgId, inv.contact_email, "Sua mensalidade", message);
          }
        } catch (e) { /* noop */ }

        SubscriptionService.setInvoiceCharged(orgId, inv.id, 'sent');
        console.log(`[Scheduler] Cobrança de assinatura enviada (fatura ${inv.id}).`);
      } catch (e) {
        console.error('[Scheduler] Falha ao cobrar assinatura', inv.id, e);
      }
    }

    // 3) ATRASO: faturas pendentes vencidas há mais de 3 dias.
    try {
      const overdue = db.prepare(`
        SELECT id, organization_id, subscription_id FROM subscription_invoices
        WHERE status = 'pending' AND due_date IS NOT NULL AND due_date <= datetime('now','-3 days')
        LIMIT 500
      `).all() as any[];
      for (const o of overdue) SubscriptionService.markOverdue(o.organization_id, o.id, o.subscription_id);
    } catch (e) { /* noop */ }
  }

  /**
   * Lembrete de PIX não pago (opt-in por organização) — RETENTATIVA PROGRESSIVA.
   * Em vez de cutucar uma vez só, manda até `pix_reminder_max` lembretes em
   * intervalos CRESCENTES (base, 2x, 3x...) enquanto o pedido não for pago.
   * Cobre tanto o PIX dinâmico (payment_charges, com QR) quanto o PIX manual
   * (pedido aguardando_pagamento sem cobrança no gateway — reenvia a chave).
   */
  static async pixReminderPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, pix_reminder_minutes, pix_reminder_message, COALESCE(pix_reminder_max,3) AS max
        FROM organization_settings
        WHERE COALESCE(pix_reminder_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const orgId = org.organization_id;
        const base = Math.min(1440, Math.max(5, parseInt(String(org.pix_reminder_minutes || 30), 10) || 30));
        const max = Math.min(5, Math.max(1, parseInt(String(org.max || 3), 10) || 3));
        const tpl = org.pix_reminder_message
          || "Oi {nome}! Vi que seu pedido ainda está aguardando o pagamento via Pix 😊 Pra facilitar, aqui está o código de novo:";
        const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;

        // O próximo lembrete (nº n, 0-based) só sai quando passou base*(n+1) do
        // último envio (ou da criação). Assim os intervalos vão crescendo.
        const isDue = (count: number, lastAt: string | null, createdAt: string) => {
          const ref = String(lastAt || createdAt).replace(' ', 'T');
          const elapsedMin = (Date.now() - new Date(ref + 'Z').getTime()) / 60000;
          return elapsedMin >= base * (count + 1);
        };

        // (A) PIX DINÂMICO — cobranças no gateway ainda pendentes e não expiradas.
        const charges = db.prepare(`
          SELECT pc.id, pc.qr_code, pc.ticket_url, COALESCE(pc.reminder_count,0) AS reminder_count,
                 pc.last_reminder_at, pc.created_at,
                 c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel
          FROM payment_charges pc
          JOIN orders o ON o.id = pc.order_id
          JOIN contacts c ON c.id = o.contact_id
          WHERE pc.organization_id = ?
            AND pc.status = 'pending'
            AND COALESCE(pc.reminder_count,0) < ?
            AND (pc.expires_at IS NULL OR pc.expires_at >= datetime('now'))
            AND o.status NOT IN ('pago','cancelado')
        `).all(orgId, max) as any[];

        for (const ch of charges) {
          try {
            if (!ch.contact_number) { db.prepare(`UPDATE payment_charges SET reminder_status = 'skipped', reminder_count = ? WHERE id = ?`).run(max, ch.id); continue; }
            if (!isDue(ch.reminder_count, ch.last_reminder_at, ch.created_at)) continue;
            const channelId = ch.contact_channel || fallbackChannel?.id;
            if (!channelId) continue;

            const first = (ch.contact_name || '').trim().split(/\s+/)[0] || '';
            let message = tpl.replace(/\{nome\}/gi, first);
            if (ch.qr_code) message += `\n\n${ch.qr_code}`;
            else if (ch.ticket_url) message += `\n\n${ch.ticket_url}`;
            message += `\n\nAssim que o pagamento cair, seu pedido é confirmado automaticamente. ✅`;

            await MessageProviderService.sendMessage(channelId, ch.contact_number, message);
            db.prepare(`UPDATE payment_charges SET reminder_count = COALESCE(reminder_count,0) + 1, last_reminder_at = CURRENT_TIMESTAMP, reminder_status = 'sent' WHERE id = ?`).run(ch.id);
            console.log(`[Scheduler] Lembrete de PIX (dinâmico) #${ch.reminder_count + 1} para ${ch.contact_number} (cobrança ${ch.id}).`);
          } catch (e) {
            console.error('[Scheduler] Falha no lembrete de PIX dinâmico', ch.id, e);
          }
        }

        // (B) PIX MANUAL — pedidos aguardando pagamento SEM cobrança no gateway.
        // Reenvia a mensagem de chave PIX estática progressivamente.
        const manualMsg = PaymentService.buildChargeMessage(orgId, 0);
        if (manualMsg !== null) {
          const manualOrders = db.prepare(`
            SELECT o.id, COALESCE(o.pix_reminder_count,0) AS reminder_count, o.pix_last_reminder_at, o.created_at, o.total_amount,
                   c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel
            FROM orders o
            JOIN contacts c ON c.id = o.contact_id
            WHERE o.organization_id = ?
              AND o.status = 'aguardando_pagamento'
              AND COALESCE(o.pix_reminder_count,0) < ?
              AND NOT EXISTS (SELECT 1 FROM payment_charges pc WHERE pc.order_id = o.id)
          `).all(orgId, max) as any[];

          for (const o of manualOrders) {
            try {
              if (!o.contact_number) { db.prepare(`UPDATE orders SET pix_reminder_count = ? WHERE id = ?`).run(max, o.id); continue; }
              if (!isDue(o.reminder_count, o.pix_last_reminder_at, o.created_at)) continue;
              const channelId = o.contact_channel || fallbackChannel?.id;
              if (!channelId) continue;

              const first = (o.contact_name || '').trim().split(/\s+/)[0] || '';
              const charge = PaymentService.buildChargeMessage(orgId, Number(o.total_amount || 0));
              if (!charge) continue;
              const message = `${tpl.replace(/\{nome\}/gi, first)}\n\n${charge}`;

              await MessageProviderService.sendMessage(channelId, o.contact_number, message);
              db.prepare(`UPDATE orders SET pix_reminder_count = COALESCE(pix_reminder_count,0) + 1, pix_last_reminder_at = CURRENT_TIMESTAMP WHERE id = ?`).run(o.id);
              console.log(`[Scheduler] Lembrete de PIX (manual) #${o.reminder_count + 1} para ${o.contact_number} (pedido ${o.id}).`);
            } catch (e) {
              console.error('[Scheduler] Falha no lembrete de PIX manual', o.id, e);
            }
          }
        }
      } catch (e) {
        console.error('[Scheduler] Falha nos lembretes de PIX da org', org.organization_id, e);
      }
    }
  }

  /**
   * Pesquisa de satisfação / CSAT (opt-in por organização). N horas após o
   * pagamento, envia UMA pergunta de nota 1-5 ao cliente (a resposta é capturada
   * no webhookProcessor). Cria uma pesquisa por pedido pago.
   */
  static async npsPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, COALESCE(nps_delay_hours,24) AS hours, nps_message
        FROM organization_settings
        WHERE COALESCE(nps_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const orgId = org.organization_id;
        const hours = Math.max(0, parseInt(String(org.hours || 24), 10) || 24);
        const tpl = org.nps_message
          || "Oi {nome}! Tudo certo com seu pedido? 😊 De *1 a 5*, que nota você dá para a sua experiência com a gente? (responda só com o número)";

        // Pedidos pagos há mais de N horas, ainda sem pesquisa criada.
        const orders = db.prepare(`
          SELECT o.id, o.ticket_id, o.contact_id,
                 c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel
          FROM orders o
          JOIN contacts c ON c.id = o.contact_id
          WHERE o.organization_id = ?
            AND o.payment_status = 'paid'
            AND o.paid_at IS NOT NULL
            AND o.paid_at <= datetime('now', ?)
            AND NOT EXISTS (SELECT 1 FROM satisfaction_surveys s WHERE s.order_id = o.id)
          LIMIT 300
        `).all(orgId, `-${hours} hours`) as any[];

        if (!orders.length) continue;
        const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;

        for (const o of orders) {
          try {
            if (!o.contact_number) {
              // Sem número: registra a pesquisa como pulada para não tentar de novo.
              const sid = SatisfactionService.create(orgId, { contactId: o.contact_id, ticketId: o.ticket_id, orderId: o.id });
              if (sid) db.prepare(`UPDATE satisfaction_surveys SET status = 'skipped' WHERE id = ?`).run(sid);
              continue;
            }
            const channelId = o.contact_channel || fallbackChannel?.id;
            if (!channelId) continue;
            const first = (o.contact_name || '').trim().split(/\s+/)[0] || '';
            const message = tpl.replace(/\{nome\}/gi, first);
            await MessageProviderService.sendMessage(channelId, o.contact_number, message);
            SatisfactionService.create(orgId, { contactId: o.contact_id, ticketId: o.ticket_id, orderId: o.id });
            console.log(`[Scheduler] Pesquisa de satisfação enviada para ${o.contact_number} (pedido ${o.id}).`);
          } catch (e) {
            console.error('[Scheduler] Falha ao enviar pesquisa de satisfação', o.id, e);
          }
        }
      } catch (e) {
        console.error('[Scheduler] Falha na pesquisa de satisfação da org', org.organization_id, e);
      }
    }
  }

  /**
   * Carrinho abandonado (opt-in por organização). Re-engaja UMA vez tickets que
   * demonstraram intenção de compra (estágio 'proposta'/'qualificado'), estão
   * abertos, NÃO geraram pedido e ficaram em silêncio por mais de N horas.
   */
  static async abandonedCartPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, COALESCE(abandoned_cart_hours,4) AS hours, abandoned_cart_message,
               COALESCE(abandoned_cart_intent_enabled,0) AS abandoned_cart_intent_enabled,
               COALESCE(abandoned_cart_intent_threshold,60) AS abandoned_cart_intent_threshold
        FROM organization_settings
        WHERE COALESCE(abandoned_cart_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const orgId = org.organization_id;
        const hours = Math.max(1, parseInt(String(org.hours || 4), 10) || 4);
        const tpl = org.abandoned_cart_message
          || "Oi {nome}! Vi que ficamos no meio de uma conversa por aqui 😊 Ainda quer seguir? Posso te ajudar a finalizar agora.";

        const tickets = db.prepare(`
          SELECT t.id, t.contact_id,
                 c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel
          FROM tickets t
          JOIN contacts c ON c.id = t.contact_id
          WHERE t.organization_id = ?
            AND t.status = 'open'
            AND t.stage IN ('proposta','qualificado')
            AND t.abandoned_nudged_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.ticket_id = t.id AND o.status NOT IN ('cancelado'))
            AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) <= datetime('now', ?)
        `).all(orgId, `-${hours} hours`) as any[];

        // Pre-proposal intent: tickets where AI detected purchase probability >= threshold
        // even if the stage hasn't moved to proposta/qualificado yet
        const intentEnabled = !!(org as any).abandoned_cart_intent_enabled;
        const intentThreshold = parseInt(String((org as any).abandoned_cart_intent_threshold || 60), 10) || 60;
        if (intentEnabled) {
          try {
            const intentTickets = db.prepare(`
              SELECT t.id, t.contact_id,
                     c.identifier AS contact_number, c.name AS contact_name, c.channel_id AS contact_channel
              FROM tickets t
              JOIN contacts c ON c.id = t.contact_id
              WHERE t.organization_id = ?
                AND t.status = 'open'
                AND t.stage NOT IN ('proposta','qualificado')
                AND t.abandoned_nudged_at IS NULL
                AND COALESCE(c.ai_purchase_probability, 0) >= ?
                AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.ticket_id = t.id AND o.status NOT IN ('cancelado'))
                AND (SELECT MAX(m.created_at) FROM messages m WHERE m.ticket_id = t.id) <= datetime('now', ?)
            `).all(orgId, intentThreshold, `-${hours} hours`) as any[];
            for (const it of intentTickets) tickets.push(it);
          } catch (e) { /* intent columns may not exist yet */ }
        }

        if (!tickets.length) continue;
        const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;

        for (const t of tickets) {
          try {
            if (!t.contact_number) { db.prepare(`UPDATE tickets SET abandoned_nudged_at = CURRENT_TIMESTAMP WHERE id = ?`).run(t.id); continue; }
            const channelId = t.contact_channel || fallbackChannel?.id;
            if (!channelId) continue;
            const first = (t.contact_name || '').trim().split(/\s+/)[0] || '';
            const message = tpl.replace(/\{nome\}/gi, first);
            await MessageProviderService.sendMessage(channelId, t.contact_number, message);
            db.prepare(`UPDATE tickets SET abandoned_nudged_at = CURRENT_TIMESTAMP WHERE id = ?`).run(t.id);
            console.log(`[Scheduler] Carrinho abandonado: cutucão enviado para ${t.contact_number} (ticket ${t.id}).`);
          } catch (e) {
            console.error('[Scheduler] Falha no cutucão de carrinho abandonado', t.id, e);
          }
        }
      } catch (e) {
        console.error('[Scheduler] Falha no carrinho abandonado da org', org.organization_id, e);
      }
    }
  }

  /**
   * Lembrete de recompra via WhatsApp (opt-in por organização). Identifica
   * clientes que compraram há mais de N dias e ainda não receberam lembrete
   * desde a última compra. Personaliza a mensagem com os produtos comprados.
   * Trava semanal por org para não rodar a cada tick.
   */
  static async repurchaseReminderPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`
        SELECT organization_id, COALESCE(repurchase_reminder_days,30) AS days,
               repurchase_reminder_message, repurchase_reminder_last_run
        FROM organization_settings
        WHERE COALESCE(repurchase_reminder_enabled,0) = 1
      `).all() as any[];
    } catch (e) { return; }

    for (const org of orgs) {
      try {
        const orgId = org.organization_id;
        const days = Math.max(7, parseInt(String(org.days || 30), 10) || 30);

        const last = org.repurchase_reminder_last_run ? new Date(org.repurchase_reminder_last_run).getTime() : 0;
        if (Date.now() - last < 7 * 24 * 60 * 60 * 1000) continue;

        const contacts = db.prepare(`
          SELECT c.id, c.name, c.identifier, c.channel_id, c.last_purchase_at
          FROM contacts c
          WHERE c.organization_id = ?
            AND c.purchase_count > 0
            AND c.last_purchase_at IS NOT NULL
            AND c.last_purchase_at <= datetime('now', ?)
            AND (c.repurchase_reminded_at IS NULL OR c.repurchase_reminded_at < c.last_purchase_at)
            AND COALESCE(c.marketing_opt_out, 0) = 0
            AND c.identifier IS NOT NULL AND c.identifier != ''
          LIMIT 100
        `).all(orgId, `-${days} days`) as any[];

        db.prepare(`UPDATE organization_settings SET repurchase_reminder_last_run = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(orgId);
        if (!contacts.length) continue;

        const fallbackChannel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;

        const tpl = org.repurchase_reminder_message
          || "Oi {nome}! Já faz um tempo desde sua última compra ({produtos}). Temos novidades que combinam com você! Posso te mostrar? 😊";

        for (const c of contacts) {
          try {
            const channelId = c.channel_id || fallbackChannel?.id;
            if (!channelId) { db.prepare(`UPDATE contacts SET repurchase_reminded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id); continue; }

            const items = db.prepare(`
              SELECT DISTINCT oi.name_snapshot
              FROM order_items oi
              JOIN orders o ON o.id = oi.order_id
              WHERE o.organization_id = ? AND o.contact_id = ?
                AND o.status IN ('pago','em_preparo','entregue','concluido')
              ORDER BY o.created_at DESC
              LIMIT 3
            `).all(orgId, c.id) as any[];

            const produtos = items.length > 0
              ? items.map(i => i.name_snapshot).join(', ')
              : 'seus favoritos';

            const first = (c.name || '').trim().split(/\s+/)[0] || '';
            const message = tpl
              .replace(/\{nome\}/gi, first)
              .replace(/\{produtos\}/gi, produtos);

            await MessageProviderService.sendMessage(channelId, c.identifier, message);
            db.prepare(`UPDATE contacts SET repurchase_reminded_at = CURRENT_TIMESTAMP WHERE id = ?`).run(c.id);
            console.log(`[Scheduler] Lembrete de recompra enviado para ${c.identifier} (contato ${c.id}).`);
          } catch (e) {
            console.error('[Scheduler] Falha no lembrete de recompra', c.id, e);
          }
        }
        console.log(`[Scheduler] Lembretes de recompra disparados para org ${orgId}: ${contacts.length} contato(s).`);
      } catch (e) {
        console.error('[Scheduler] Falha no lembrete de recompra da org', org.organization_id, e);
      }
    }
  }
}
