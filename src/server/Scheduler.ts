import db from "./db.js";
import { CampaignService } from "./CampaignService.js";
import { MessageProviderService } from "./MessageProviderService.js";
import { CadenceService } from "./CadenceService.js";
import { NotificationService } from "./NotificationService.js";
import { SubscriptionService } from "./SubscriptionService.js";
import { PaymentService } from "./PaymentService.js";
import { OrdersService } from "./OrdersService.js";
import { PurchaseRequisitionService } from "./PurchaseRequisitionService.js";
import { QuoteService } from "./QuoteService.js";
import { LgpdService } from "./LgpdService.js";
import { CustomerMemoryService } from "./CustomerMemoryService.js";
import { SatisfactionService } from "./SatisfactionService.js";
import { GoogleOAuthService } from "./GoogleOAuthService.js";
import { InstagramService } from "./InstagramService.js";
import { ProspectDiscoveryService } from "./ProspectDiscoveryService.js";
import { MaestroService } from "./MaestroService.js";
import { JobQueueService } from "./JobQueueService.js";

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
    await this.abandonedCartPass().catch(e => console.error('[Scheduler] carrinho abandonado falhou', e));
    await this.npsPass().catch(e => console.error('[Scheduler] pesquisa de satisfação falhou', e));
    await this.memoryPass().catch(e => console.error('[Scheduler] memória do cliente falhou', e));
    await ProspectDiscoveryService.runDue().catch(e => console.error('[Scheduler] descoberta de prospecção falhou', e));
    this.trialPass();
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
        SELECT organization_id, COALESCE(abandoned_cart_hours,4) AS hours, abandoned_cart_message
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
}
