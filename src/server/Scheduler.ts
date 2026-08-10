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
import { SchoolDigestService } from "./SchoolDigestService.js";
import { TeacherDigestService } from "./TeacherDigestService.js";
import { ClinicReminderService } from "./ClinicReminderService.js";
import { ClinicRetentionService } from "./ClinicRetentionService.js";
import { ClinicFollowUpNoticeService } from "./ClinicFollowUpNoticeService.js";
import { ClinicMonthlyReportDeliveryService } from "./ClinicMonthlyReportDeliveryService.js";
import { ClinicRenewalTaskService } from "./ClinicRenewalTaskService.js";
import { PlanFitSignalPublisher } from "./PlanFitSignalPublisher.js";
import { ChurnRiskDetectorService } from "./ChurnRiskDetectorService.js";
import { AiQuotaSignalService } from "./AiQuotaSignalService.js";
import { UpgradeRecommendationService } from "./UpgradeRecommendationService.js";
import { FalaTuService } from "./FalaTuService.js";
import { FalaTuBriefingTaskService } from "./FalaTuBriefingTaskService.js";
import { FalaTuBriefingDigestService } from "./FalaTuBriefingDigestService.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";
import { SchoolCoordinationService } from "./SchoolCoordinationService.js";
import { ModuleService } from "./ModuleService.js";
import { RetailFloorAttendanceService } from "./RetailFloorAttendanceService.js";
import { RetailFloorReconciliationService } from "./RetailFloorReconciliationService.js";
import { RetailFloorSignalPublisher } from "./RetailFloorSignalPublisher.js";
import { RetailFloorDigestService } from "./RetailFloorDigestService.js";
import { ProspectDiscoveryService } from "./ProspectDiscoveryService.js";
import { MaestroService } from "./MaestroService.js";
import { JobQueueService } from "./JobQueueService.js";
import { RadarService } from "./RadarService.js";
import { FashionAvatarService } from "./FashionAvatarService.js";
import { FashionTryOnService } from "./FashionTryOnService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { RetailTaskService } from "./RetailOpsService.js";
import { RetailImpactService } from "./RetailImpactService.js";
import { RetailOpsSignalPublisher } from "./RetailOpsSignalPublisher.js";
import { VerticalIntelligenceReminderService } from "./VerticalIntelligenceReminderService.js";
import { VerticalIntelligenceResearchService } from "./VerticalIntelligenceResearchService.js";
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
    // ADR-154 F8.7 — rede de segurança dos Protocolos: dispara ativações
    // vencidas cujo timer local morreu num restart (claim atômico impede
    // ligação dupla quando timer e passe correm juntos).
    try {
      const { FalaTuProtocolService } = await import('./FalaTuProtocolService.js');
      await FalaTuProtocolService.fireDue();
    } catch (e) { console.error('[Scheduler] disparo de protocolos FalaTu falhou', e); }
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
    // Retail Floor (ADR-150, Fatia 3): auto-encerra atendimento esquecido além
    // de auto_close_minutes. Sensível a minutos → passe rápido.
    try { this.retailFloorAutoClosePass(); } catch (e: any) { console.error('[Scheduler] auto-encerramento Retail Floor falhou', e?.message); }
  }

  /**
   * Retail Floor (ADR-150, Fatia 6) — conciliação declarado × PDV de HOJE e
   * ONTEM (o PDV lança no fim do dia; o sync Alterdata chega no tick horário
   * anterior a este passe). Idempotente e só-promove — re-rodar por hora é
   * barato e pega ERP atrasado. Só orgs com atendimentos conciliáveis.
   */
  static retailFloorReconciliationPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM retail_floor_attendances WHERE reconciliation_state IN ('pending','unmatched')`
      ).all() as any[];
    } catch { return; }
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (const o of orgs) {
      try {
        if (!ModuleService.isEnabled(o.organization_id, "retail_floor")) continue;
        RetailFloorReconciliationService.runAll(o.organization_id, yesterday);
        RetailFloorReconciliationService.runAll(o.organization_id, today);
      } catch (e) { console.error("[RetailFloor] conciliação falhou", o.organization_id, e); }
    }
  }

  /**
   * Retail Floor (ADR-150, Fatia 10) — resumo diário da loja por WhatsApp,
   * opt-in via retail_floor_settings.daily_digest_enabled. O service decide
   * hora/dedupe/destinatários; aqui só resolvemos o canal (mesmo padrão do
   * schoolDigestPass). Best-effort por org.
   */
  static async retailFloorDigestPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT organization_id FROM retail_floor_settings WHERE daily_digest_enabled = 1`).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    const now = new Date();
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        if (!ModuleService.isEnabled(orgId, "retail_floor")) continue;
        const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        if (!channel) continue; // sem canal conectado não há como enviar
        const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
        await RetailFloorDigestService.runDigestPass(orgId, { now, send });
      } catch (e) { console.error("[RetailFloor] passe de resumo falhou", orgId, e); }
    }
  }

  /**
   * Retail Floor (ADR-150, Fatia 8) — publica os sinais do dia (hoje + ontem,
   * o PDV/conciliação chega atrasado) no business_signals. Idempotente pelo
   * dedupe do ledger; só orgs com turno recente e módulo habilitado.
   */
  static retailFloorSignalsPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM retail_floor_shifts WHERE opened_at >= datetime('now', '-2 days')`
      ).all() as any[];
    } catch { return; }
    const today = new Date().toISOString().slice(0, 10);
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    for (const o of orgs) {
      try {
        if (!ModuleService.isEnabled(o.organization_id, "retail_floor")) continue;
        RetailFloorSignalPublisher.sweep(o.organization_id, yesterday);
        RetailFloorSignalPublisher.sweep(o.organization_id, today);
      } catch (e) { console.error("[RetailFloor] sinais falharam", o.organization_id, e); }
    }
  }

  /**
   * Retail Floor (ADR-150, Fatia 3) — fecha com outcome='unknown' o
   * atendimento aberto além do teto da org e devolve o vendedor pra fila.
   * Best-effort por-org; só orgs com o módulo habilitado.
   */
  static retailFloorAutoClosePass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT DISTINCT organization_id FROM retail_floor_attendances WHERE ended_at IS NULL`).all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try {
        if (!ModuleService.isEnabled(o.organization_id, "retail_floor")) continue;
        RetailFloorAttendanceService.autoCloseStale(o.organization_id);
      } catch (e) { console.error("[RetailFloor] auto-encerramento falhou", o.organization_id, e); }
    }
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
        await BusinessTutorService.runCollectPass(orgId, { now, send });
        await BusinessTutorService.runMiddayPass(orgId, { now, send });
        await BusinessTutorService.runEveningPass(orgId, { now, send });
      } catch (e) { console.error("[Tutor] passe da org falhou", orgId, e); }
    }
  }

  /**
   * Módulo Escola (ADR-144, Fatia 1): resumo diário do aluno ao RESPONSÁVEL no
   * WhatsApp. Só orgs com o módulo "escola" habilitado; o serviço decide
   * janela/dedupe/consentimento por relação. Best-effort, 1 loop.
   */
  static async schoolDigestPass() {
    let orgs: any[] = [];
    // Só orgs que JÁ têm responsável consentindo (o sinal real de uso do módulo);
    // o gating fino do módulo fica no isEnabled abaixo.
    try {
      orgs = db.prepare(`SELECT DISTINCT organization_id FROM student_guardians WHERE digest_consent = 1`).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    const now = new Date();
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        if (!ModuleService.isEnabled(orgId, "escola")) continue; // módulo desligado p/ a org
        const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        if (!channel) continue; // sem canal conectado não há como enviar
        const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
        await SchoolDigestService.runDigestPass(orgId, { now, send });
      } catch (e) { console.error("[Escola] passe da org falhou", orgId, e); }
    }
  }

  /**
   * Módulo Escola (ADR-144, Fatia 2): "resumo antes da aula" ao PROFESSOR no
   * WhatsApp. Só orgs com o módulo "escola" habilitado; o serviço decide
   * janela/dedupe/opt-in e só envia a quem tem aulas hoje. Best-effort, 1 loop.
   */
  /**
   * Módulo Clínica (ADR-080 Fase M) — lembrete automático de consulta.
   * Roda a cada tick do loop principal; dispara pra appointments na janela
   * `hoursBefore ± 1h` (default 24h), filtrando por consentimento LGPD
   * `comunicacoes` e canal ativo. Só orgs com o módulo `clinica` habilitado.
   */
  /**
   * Módulo Clínica (ADR-080 Fase U) — retenção LGPD. Roda uma vez por dia
   * (o dispatch é idempotente — arquivo já ausente conta como sucesso).
   * Percorre orgs com módulo `clinica` habilitado.
   */
  static clinicRetentionPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT DISTINCT organization_id FROM clinical_encounters`).all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try {
        if (!ModuleService.isEnabled(o.organization_id, "clinica")) continue;
        ClinicRetentionService.runForOrg(o.organization_id);
      } catch (e) { console.error("[Clínica] retenção falhou", o.organization_id, e); }
    }
  }

  static async clinicReminderPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM appointments
           WHERE status IN ('confirmed','arrived') AND scheduled_start > CURRENT_TIMESTAMP`
      ).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    for (const o of orgs) {
      try {
        if (!ModuleService.isEnabled(o.organization_id, "clinica")) continue;
        await ClinicReminderService.dispatch({ orgId: o.organization_id });
      } catch (e) { console.error("[Clínica] lembrete falhou", o.organization_id, e); }
    }
  }

  /**
   * Módulo Clínica (ADR-080 Fase 26) — notificação automática de retorno.
   * Percorre orgs com encounter `signed` marcado com follow_up_recommended_days.
   * Best-effort por-org; falha de 1 não trava as demais.
   */
  static async clinicFollowUpNoticePass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM clinical_encounters
           WHERE status = 'signed' AND follow_up_recommended_days IS NOT NULL AND follow_up_recommended_days > 0`
      ).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    for (const o of orgs) {
      try {
        if (!ModuleService.isEnabled(o.organization_id, "clinica")) continue;
        await ClinicFollowUpNoticeService.dispatchForOrg(o.organization_id);
      } catch (e) { console.error("[Clínica] aviso de retorno falhou", o.organization_id, e); }
    }
  }

  /**
   * Módulo Clínica (ADR-080 Fase 33) — envio automático do relatório mensal.
   * Percorre orgs com `clinic_monthly_report_enabled=1` e envia o PDF do mês
   * anterior pro destinatário configurado no dia definido. Dedup por
   * (org, month) — o próprio service protege contra re-envio dentro do dia.
   * Best-effort por-org; falha de 1 não trava as demais.
   */
  static async clinicMonthlyReportPass() {
    try {
      await ClinicMonthlyReportDeliveryService.dispatchAll();
    } catch (e) { console.error("[Clínica] passe relatório mensal falhou", e); }
  }

  /**
   * Módulo Clínica (ADR-145 Fase 5 / Fatia 49) — sweep de renovação de ciclo.
   * Publica sinais operacionais em `business_signals` (ADR-136) pra recepção
   * enxergar `renewal_due` / `pending_authorization` / `renewal_alert` sem
   * precisar disparar o POST manual. Idempotente (ClinicRenewalTaskService.run
   * já deduplica por `dedupe_key`), best-effort por-org. Só varre orgs que
   * têm ciclos vivos (active/renewal_due/pending_authorization/on_hold) — não
   * gasta tempo em tenant sem uso.
   */
  static clinicRenewalTaskPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM clinic_treatment_cycles
           WHERE status IN ('active','renewal_due','pending_authorization','on_hold')`
      ).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        if (!ModuleService.isEnabled(orgId, "clinica")) continue;
        ClinicRenewalTaskService.run(orgId);
      } catch (e) { console.error("[Clínica] sweep de renovação falhou", orgId, e); }
    }
  }

  /**
   * FalaTu (ADR-151 Fatia 5) — briefing diário proativo. Publica UM sinal por
   * (usuário, dia) no `business_signals` (ADR-136) com as pendências e a
   * agenda do dia — idempotente por dedupe_key, best-effort por-org. Só varre
   * orgs com uso real do FalaTu (dados nas tabelas falatu_*) E habilitadas
   * (flag `falatu_enabled` — ou a org do operador da plataforma, mesmo bypass
   * do falatuGate). NUNCA cria/edita nada nem envia mensagem: só sinaliza.
   */
  static falatuBriefingPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM (
           SELECT organization_id FROM falatu_inbox_items
           UNION SELECT organization_id FROM falatu_events
           UNION SELECT organization_id FROM falatu_tasks)`
      ).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        if (!FalaTuService.orgEnabled(orgId) && !FalaTuBriefingTaskService.hasMasterAdminUser(orgId)) continue;
        FalaTuBriefingTaskService.run(orgId);
      } catch (e) { console.error("[FalaTu] sweep de briefing falhou", orgId, e); }
    }
  }

  /**
   * ADR-152 F2.3 — sweep de timeouts do Execution Runtime. Fecha como
   * `timed_out` as `action_confirmations` pendentes cujo `deadline_at`
   * venceu (webhook Asaas nunca chegou, resposta do cliente não veio, ...).
   * Best-effort, idempotente. A Fase 3 vai listar isso na aba Operações
   * como exceção "SLA ameaçado / timeout esgotado".
   */
  static confirmationTimeoutPass() {
    try {
      const closed = ConfirmationEngine.sweepTimeouts();
      if (closed > 0) console.info(`[Runtime] ConfirmationEngine.sweepTimeouts fechou ${closed} pendente(s).`);
    } catch (e: any) { console.error("[Runtime] sweepTimeouts falhou", e?.message); }
  }

  /**
   * ADR-152 Fatia 4b.3 — cadência multi-tentativa de cobrança. Delega ao
   * `CollectionCadenceService.tickAll` que percorre orgs opt-in
   * (`collection_cadence_enabled=1`) e envia T2 (firme) / T3 (aviso de
   * negativação) via WhatsApp conforme os thresholds em dias por-org.
   * Best-effort com múltiplas guardas (RN G-4b.3-1..10): idempotência
   * forte via UNIQUE(org, action, attempt), pausa se cliente respondeu
   * (audit log da F4b.2), pausa se receivable já fechou. Import dinâmico
   * pra quebrar ciclo (CollectionCadenceService usa MessageProviderService).
   */
  static async collectionCadencePass() {
    try {
      const { CollectionCadenceService } = await import("./CollectionCadenceService.js");
      const r = await CollectionCadenceService.tickAll();
      if (r.sent > 0 || r.orgsScanned > 0) {
        console.info(`[Runtime F4b.3] cadência de cobrança: ${r.orgsScanned} org(s), ${r.sent} enviada(s), ${r.skipped} skip.`);
      }
    } catch (e: any) { console.error("[Runtime F4b.3] cadência falhou", e?.message); }
    // F2.3 — mede o A/B da copy (variante/decline × recuperação) e publica o
    // KPI vivo em business_signals. Upsert idempotente; barato; best-effort.
    try {
      const { CollectionAbMeasurementService } = await import("./CollectionAbMeasurementService.js");
      CollectionAbMeasurementService.publishAll();
    } catch (e: any) { console.error("[Cobrança F2.3] medição A/B falhou", e?.message); }
    // F1.4 — pós-mortem: se o A/B mostra a calibrada perdendo, grava uma Lição
    // na rubrica do grimoire (e aposenta quando volta a ganhar). Best-effort.
    try {
      const { GrimoirePostmortemService } = await import("./GrimoirePostmortemService.js");
      await GrimoirePostmortemService.runAll();
    } catch (e: any) { console.error("[Grimoire F1.4] pós-mortem falhou", e?.message); }
  }

  /**
   * ADR-152 Fatia 4c — Piloto Recuperação Comercial. Detecta deals
   * parados (tickets no funil sem update recente + sem resposta do
   * contato) e cria PROPOSTAS pro dono aprovar/dispensar. NUNCA envia
   * autonomamente (LGPD-safe — decisão #4 do dono ainda aberta). Só
   * varre orgs opt-in (`sales_recovery_enabled=1`, default 0).
   * Import dinâmico pra quebrar ciclo.
   */
  static async salesRecoveryDetectionPass() {
    try {
      const rows = db.prepare(`
        SELECT organization_id AS orgId, COALESCE(sales_recovery_stalled_days, 10) AS stalledDays
          FROM organization_settings
         WHERE COALESCE(sales_recovery_enabled, 0) = 1
      `).all() as any[];
      if (!rows.length) return;
      const { SalesRecoveryPlaybookService } = await import("./SalesRecoveryPlaybook.js");
      let totalProposed = 0;
      for (const r of rows) {
        try {
          // Seed é idempotente — garante a definição antes do 1º start.
          SalesRecoveryPlaybookService.seed(r.orgId, "runtime");
          const res = await SalesRecoveryPlaybookService.detectAndProposeAll(r.orgId, { stalledDays: Number(r.stalledDays), limit: 50 });
          totalProposed += res.proposed;
        } catch (e) { console.error("[Runtime F4c] detectAndProposeAll falhou pra org", r.orgId, e); }
      }
      if (totalProposed > 0) console.info(`[Runtime F4c] Recuperação Comercial: ${rows.length} org(s), ${totalProposed} proposta(s) criada(s).`);
    } catch (e: any) { console.error("[Runtime F4c] detection pass falhou", e?.message); }
  }

  /**
   * ADR-152 Fatia 4c.4 — atribuição de revenue_recovered real. Varre
   * ticket_stage_logs recentes com `to_stage='ganho'` cujo ticket teve
   * touch de recuperação em janela, calcula ticket_value (orders →
   * quotes → avg) e grava outcome F3.1. Idempotência forte via
   * UNIQUE(org, ticket, stage_change_at). Import dinâmico pra quebrar
   * ciclo.
   */
  static async salesRecoveryAttributionPass() {
    try {
      const { SalesRecoveryAttributionService } = await import("./SalesRecoveryAttributionService.js");
      const r = await SalesRecoveryAttributionService.tickAll();
      if (r.attributed > 0 || r.orgsScanned > 0) {
        console.info(`[Runtime F4c.4] atribuição de revenue: ${r.orgsScanned} org(s), ${r.attributed} atribuída(s), ${r.skipped} skip.`);
      }
    } catch (e: any) { console.error("[Runtime F4c.4] attribution pass falhou", e?.message); }

    // ADR-155 F3.2 — logo APÓS a atribuição (dados frescos), mede o A/B da copy
    // de recuperação (KPI vivo em business_signals) e roda o pós-mortem F1.4
    // sobre a rubrica sales-recovery. Espelha o que a collectionCadencePass faz
    // pra cobrança. Best-effort — nunca derruba o tick.
    try {
      const { SalesRecoveryAbMeasurementService } = await import("./SalesRecoveryAbMeasurementService.js");
      SalesRecoveryAbMeasurementService.publishAll();
    } catch (e: any) { console.error("[Runtime F3.2] medição A/B de recuperação falhou", e?.message); }
    try {
      const { GrimoirePostmortemService } = await import("./GrimoirePostmortemService.js");
      await GrimoirePostmortemService.runAllSalesRecovery();
    } catch (e: any) { console.error("[Runtime F3.2] pós-mortem de recuperação falhou", e?.message); }
  }

  /**
   * ADR-155 F6 — medição do programa de indicação (ADR-069). Deriva por query
   * (códigos/indicados/recompensas) e publica o KPI `referral_program_result`
   * em business_signals (upsert idempotente). Observador puro: não emite cupom
   * nem muda estado do programa. Best-effort.
   */
  static async referralProgramMeasurementPass() {
    try {
      const { ReferralProgramMeasurementService } = await import("./ReferralProgramMeasurementService.js");
      const r = ReferralProgramMeasurementService.publishAll();
      if (r.published > 0) console.info(`[Runtime F6] indicação: ${r.orgs} org(s), ${r.published} KPI(s) publicado(s).`);
    } catch (e: any) { console.error("[Runtime F6] medição do programa de indicação falhou", e?.message); }
  }

  /**
   * ADR-155 — grava o snapshot diário do A/B (control × calibrada) de cobrança e
   * recuperação, alimentando o gráfico temporal da aba Operações. Upsert por
   * org/kind/dia (rodar várias vezes no mesmo dia não duplica). Best-effort.
   */
  static async abTrendSnapshotPass() {
    try {
      const { AbTrendService } = await import("./AbTrendService.js");
      AbTrendService.captureAll();
    } catch (e: any) { console.error("[Runtime] snapshot temporal do A/B falhou", e?.message); }
  }

  /**
   * ADR-152 Fatia 4c.3 — cadência multi-tentativa de recuperação.
   * Varre touches aprovados há N dias SEM reply do cliente e PROPÕE
   * 2ª/3ª msg (via SalesRecoveryPlaybookService.proposeForTicket com
   * attemptNumber). CADA proposta ainda passa por aprovação humana
   * (G-4c.3-1) — modo autonomous continua bloqueado em LGPD signoff.
   * Opt-in duplo: `sales_recovery_enabled=1 AND sales_recovery_
   * followup_enabled=1`.
   */
  static async salesRecoveryFollowupPass() {
    try {
      const { SalesRecoveryFollowupService } = await import("./SalesRecoveryFollowupService.js");
      const r = await SalesRecoveryFollowupService.tickAll();
      if (r.proposed > 0 || r.orgsScanned > 0) {
        console.info(`[Runtime F4c.3] follow-up de recuperação: ${r.orgsScanned} org(s), ${r.proposed} proposta(s), ${r.skipped} skip.`);
      }
    } catch (e: any) { console.error("[Runtime F4c.3] follow-up pass falhou", e?.message); }
  }

  /**
   * ADR-152 Fatia 4b.4 — re-check automático de promessa de pagamento.
   * Delega ao `CollectionPromiseService.tickAll` que percorre orgs opt-in
   * e trata cada promise cuja data prometida chegou:
   *   - receivable pago → mark fulfilled + resolve o sinal reply_promise;
   *   - ainda open → envia follow-up WhatsApp + mark broken + sinal risk.
   * Import dinâmico pra quebrar ciclo com MessageProviderService.
   */
  static async collectionPromiseCheckPass() {
    try {
      const { CollectionPromiseService } = await import("./CollectionPromiseService.js");
      const r = await CollectionPromiseService.tickAll();
      if (r.fulfilled > 0 || r.broken > 0) {
        console.info(`[Runtime F4b.4] re-check promessas: ${r.orgsScanned} org(s), ${r.fulfilled} cumpridas, ${r.broken} quebradas, ${r.skipped} skip.`);
      }
    } catch (e: any) { console.error("[Runtime F4b.4] re-check falhou", e?.message); }
  }

  /**
   * FalaTu (ADR-151 Fatia 6) — ENTREGA do briefing por WhatsApp. Consome os
   * sinais `falatu_daily_briefing` publicados pelo falatuBriefingPass (por
   * isso roda DEPOIS dele no tick) e manda o resumo da manhã pro WhatsApp de
   * quem optou. Só orgs com o opt-in de canal `falatu_briefing_wa_enabled` e
   * com sinais abertos (não varre tenant sem uso). Canal resolvido como no
   * teacherAgendaPass; best-effort por-org. NUNCA cria/edita nada.
   */
  static async falatuBriefingDigestPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE falatu_briefing_wa_enabled = 1`).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    const now = new Date();
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        if (!channel) continue;
        const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
        await FalaTuBriefingDigestService.runPass(orgId, { now, send });
      } catch (e) { console.error("[FalaTu] entrega de briefing por WhatsApp falhou", orgId, e); }
    }
  }

  /**
   * ADR-154 F8.3 — entrega do briefing por Web Push. Porta INDEPENDENTE do
   * canal WA (dedupe próprio); a "flag" é a existência de subscription ativa,
   * então só varre orgs que têm alguém inscrito. Best-effort por org.
   */
  static async falatuPushDigestPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT DISTINCT organization_id FROM falatu_push_subscriptions WHERE revoked_at IS NULL`).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    const now = new Date();
    const { FalaTuPushService } = await import("./FalaTuPushService.js");
    for (const o of orgs) {
      try { await FalaTuPushService.runDigestPass(o.organization_id, { now }); }
      catch (e) { console.error("[FalaTu] entrega de briefing por push falhou", o.organization_id, e); }
    }
  }

  // PRD 1 Fase 8 (§42-47) — alerta proativo event-driven: pra cada usuário
  // inscrito em push de uma org opt-in, checa a Smart Inbox e avisa AGORA o que
  // é urgente (dedup + quiet hours dentro do service). Fala primeiro.
  static async falatuProactiveAlertPass() {
    let subs: any[] = [];
    try {
      subs = db.prepare(`SELECT DISTINCT s.organization_id AS orgId, s.user_id AS userId
        FROM falatu_push_subscriptions s
        JOIN organization_settings o ON o.organization_id = s.organization_id
        WHERE s.revoked_at IS NULL AND COALESCE(o.falatu_proactive_alerts_enabled,0) = 1`).all() as any[];
    } catch { return; }
    if (!subs.length) return;
    const now = new Date();
    const { FalaTuProactiveService } = await import("./FalaTuProactiveService.js");
    for (const s of subs) {
      try { await FalaTuProactiveService.deliver(s.orgId, { userId: s.userId }, { now }); }
      catch (e) { console.error("[FalaTu] alerta proativo falhou", s.orgId, s.userId, e); }
    }
  }

  /**
   * ADR-154 F8.6 — entrega do briefing por e-mail. Terceira porta, dedupe
   * próprio; só varre orgs com alguém de opt-in ligado. O transporte (Gmail
   * da conexão Google da org) é resolvido dentro do service; org sem conexão
   * pula com no_email_channel sem tentar. Best-effort por org.
   */
  static async falatuEmailDigestPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT DISTINCT organization_id FROM falatu_email_optins WHERE enabled = 1`).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    const now = new Date();
    const { FalaTuEmailService } = await import("./FalaTuEmailService.js");
    for (const o of orgs) {
      try { await FalaTuEmailService.runDigestPass(o.organization_id, { now }); }
      catch (e) { console.error("[FalaTu] entrega de briefing por e-mail falhou", o.organization_id, e); }
    }
  }

  static async teacherAgendaPass() {
    let orgs: any[] = [];
    // Só orgs que JÁ têm professor com opt-in (o sinal real de uso da Fatia 2).
    try {
      orgs = db.prepare(`SELECT DISTINCT organization_id FROM teacher_profiles WHERE notify_opt_in = 1 AND status = 'active'`).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    const now = new Date();
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        if (!ModuleService.isEnabled(orgId, "escola")) continue; // módulo desligado p/ a org
        const channel = db.prepare(`SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`).get(orgId) as any;
        if (!channel) continue;
        const send = (target: string, message: string) => MessageProviderService.sendMessage(channel.id, target, message);
        await TeacherDigestService.runAgendaPass(orgId, { now, send });
      } catch (e) { console.error("[Escola] passe do professor falhou", orgId, e); }
    }
  }

  /**
   * Módulo Escola (ADR-144, Fatia 4): painel da coordenação. Recomputa os sinais
   * de coordenação (determinísticos, sem envio) para as orgs com o módulo
   * "escola" e alunos cadastrados. Best-effort, 1 loop.
   */
  static schoolCoordinationPass() {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(`SELECT DISTINCT organization_id FROM student_profiles WHERE status = 'active'`).all() as any[];
    } catch { return; }
    if (!orgs.length) return;
    for (const o of orgs) {
      const orgId = o.organization_id;
      try {
        if (!ModuleService.isEnabled(orgId, "escola")) continue; // módulo desligado p/ a org
        SchoolCoordinationService.runSignalsPass(orgId);
      } catch (e) { console.error("[Escola] passe da coordenação falhou", orgId, e); }
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
    // DI-5.4 (ADR-157): pesquisa AUTÔNOMA dos nichos agendados (vencidos pelo
    // intervalo, com consumidores, dentro do orçamento). Roda ANTES do lembrete
    // pra que nichos automatizados já saiam da lista do lembrete (mútua exclusão
    // RN-157-4). Só age em nichos que o admin master registrou.
    await VerticalIntelligenceResearchService.maybeSweep().catch(e => console.error('[Scheduler] pesquisa autônoma de nicho falhou', e));
    // DI-4.5 (ADR-156): lembrete SEMANAL de atualização das pesquisas de nicho
    // vencendo (provider manual — só avisa o admin, nunca roda pesquisa sozinho).
    try { VerticalIntelligenceReminderService.maybeWeeklySweep(); } catch (e) { console.error('[Scheduler] lembrete de inteligência de nicho falhou', e); }
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
    try { this.retailOpsSignalsPass(); } catch (e: any) { console.error('[Scheduler] retailOpsSignalsPass error', e.message); }
    try { AlterdataSyncRunner.alterdataSyncPass(); } catch (e: any) { console.error('[Scheduler] alterdataSyncPass error', e.message); }
    // Depois do sync Alterdata: concilia atendimento declarado × vendas do PDV
    // (ADR-150 Fatia 6). Idempotente e só-promove.
    try { this.retailFloorReconciliationPass(); } catch (e: any) { console.error('[Scheduler] conciliação Retail Floor falhou', e?.message); }
    // E, com a conciliação fresca, publica os sinais do Atendimento de Loja
    // (ADR-150 Fatia 8) — fatos com dedupe por loja/dia no business_signals.
    try { this.retailFloorSignalsPass(); } catch (e: any) { console.error('[Scheduler] sinais Retail Floor falharam', e?.message); }
    // Resumo diário da loja por WhatsApp (ADR-150 Fatia 10, opt-in) — depois
    // dos sinais pro texto citar a evidência do dia (ex.: minutos de fila cheia).
    await this.retailFloorDigestPass().catch(e => console.error('[Scheduler] resumo Retail Floor falhou', e));
    this.trialPass();
    await this.tutorPass().catch(e => console.error('[Scheduler] tutor falhou', e));
    await this.schoolDigestPass().catch(e => console.error('[Scheduler] resumo escolar falhou', e));
    await this.teacherAgendaPass().catch(e => console.error('[Scheduler] agenda do professor falhou', e));
    await this.clinicReminderPass().catch(e => console.error('[Scheduler] lembrete de consulta clínica falhou', e));
    await this.clinicFollowUpNoticePass().catch(e => console.error('[Scheduler] aviso de retorno clínica falhou', e));
    await this.clinicMonthlyReportPass().catch(e => console.error('[Scheduler] relatório mensal clínica falhou', e));
    try { this.clinicRenewalTaskPass(); } catch (e: any) { console.error('[Scheduler] sweep de renovação clínica falhou', e?.message); }
    try { this.falatuBriefingPass(); } catch (e: any) { console.error('[Scheduler] sweep de briefing FalaTu falhou', e?.message); }
    await this.falatuBriefingDigestPass().catch(e => console.error('[Scheduler] entrega de briefing FalaTu por WhatsApp falhou', e));
    await this.falatuPushDigestPass().catch(e => console.error('[Scheduler] entrega de briefing FalaTu por push falhou', e));
    await this.falatuProactiveAlertPass().catch(e => console.error('[Scheduler] alerta proativo FalaTu falhou', e));
    await this.falatuEmailDigestPass().catch(e => console.error('[Scheduler] entrega de briefing FalaTu por e-mail falhou', e));
    try { this.confirmationTimeoutPass(); } catch (e: any) { console.error('[Scheduler] sweep de timeouts de Confirmation falhou', e?.message); }
    // ADR-152 F4b.3 — cadência multi-tentativa de cobrança (T2/T3). Opt-in
    // por org via `collection_cadence_enabled=1`. Fica DEPOIS de
    // confirmationTimeoutPass pra a decisão de T2/T3 usar o estado
    // atualizado das confirmações (uma cobrança que virou timed_out no
    // sweep sai da fila e não recebe follow-up desnecessário).
    await this.collectionCadencePass().catch(e => console.error('[Scheduler] cadência de cobrança F4b.3 falhou', e));
    // ADR-152 F4b.4 — re-check de promessas fica DEPOIS da cadência pra
    // ver o estado atualizado (se o webhook Asaas fechou uma cobrança no
    // meio-tempo, o re-check já marca fulfilled em vez de disparar
    // follow-up desnecessário).
    await this.collectionPromiseCheckPass().catch(e => console.error('[Scheduler] re-check de promessas F4b.4 falhou', e));
    // ADR-152 F4c — detecção + proposta de recuperação comercial. NUNCA
    // envia autonomamente; só publica sinal pra dono aprovar via UI. Fica
    // depois da cadência de cobrança pra respeitar ordem de prioridade
    // do dono (cobrança tem SLA mais duro; recuperação é discovery).
    await this.salesRecoveryDetectionPass().catch(e => console.error('[Scheduler] detecção Recuperação Comercial F4c falhou', e));
    // ADR-152 F4c.3 — follow-up de recuperação (2ª/3ª tentativa proposta
    // pro dono aprovar). Fica DEPOIS da detecção pra usar o estado
    // atualizado de touches (aprovação recente reflete no próximo tick).
    await this.salesRecoveryFollowupPass().catch(e => console.error('[Scheduler] follow-up Recuperação Comercial F4c.3 falhou', e));
    // ADR-152 F4c.4 — atribuição de revenue quando ticket vira ganho.
    // Independente da cadência; escaneia ticket_stage_logs recentes
    // pra atribuir revenue às ações do Runtime. Fica no fim da chain de
    // recuperação pra ver o estado final dos touches/tickets do tick.
    await this.salesRecoveryAttributionPass().catch(e => console.error('[Scheduler] attribution F4c.4 falhou', e));
    // ADR-155 F6 — medição do programa de indicação (KPI vivo em business_signals).
    await this.referralProgramMeasurementPass().catch(e => console.error('[Scheduler] medição do programa de indicação F6 falhou', e));
    // ADR-155 — snapshot diário do A/B (control × calibrada) pro gráfico temporal.
    try { this.abTrendSnapshotPass(); } catch (e: any) { console.error('[Scheduler] snapshot temporal do A/B falhou', e?.message); }
    try { this.clinicRetentionPass(); } catch (e: any) { console.error('[Scheduler] retenção LGPD clínica falhou', e?.message); }
    try { this.schoolCoordinationPass(); } catch (e: any) { console.error('[Scheduler] coordenação escolar falhou', e?.message); }
    // ADR-153 F7.1 — detector de plan-fit (near_limit_*). Publica sinais em
    // `business_signals` domain='plan' quando org está ≥80% de qualquer limite.
    // Best-effort: erro numa org não trava as outras. Dedupe mensal por métrica.
    try { this.planFitPass(); } catch (e: any) { console.error('[Scheduler] plan-fit detector F7.1 falhou', e?.message); }
    try { this.churnRiskPass(); } catch (e: any) { console.error('[Scheduler] churn-risk detector F4.1 falhou', e?.message); }
    // ADR-159 F5 — progressive autonomy (propõe elevação por evidência; nunca aplica).
    await this.progressiveAutonomyPass().catch(e => console.error('[Scheduler] progressive autonomy F5 falhou', e));
    // ADR-159 F6 — detector de anomalia (rajada de execuções falhas → business_signals).
    await this.anomalyDetectorPass().catch(e => console.error('[Scheduler] anomaly detector F6 falhou', e));
    // ADR-158 F4 — auto-disparo sinal→processo. DEPOIS dos detectores (churn/
    // cobrança) pra rotear os sinais recém-publicados neste tick. Opt-in duplo.
    await this.signalAutoTriggerPass().catch(e => console.error('[Scheduler] auto-disparo sinal→processo F4 falhou', e));
    try { this.aiQuotaPass(); } catch (e: any) { console.error('[Scheduler] ai-quota sinais F1.3 falhou', e?.message); }
    // ADR-153 F7.7 — expira cooldowns vencidos (dismissed → expired) no ledger
    // de upgrade_recommendations. Cleanup lazy até então; agora automático.
    // Depende do planFitPass ter rodado antes: se um novo sinal viu que o
    // cooldown expirou, publisher já pode re-publicar; este pass só limpa a
    // linha antiga pra não confundir dashboards/rotas.
    try { this.planFitCooldownExpirePass(); } catch (e: any) { console.error('[Scheduler] expiração de cooldown F7.7 falhou', e?.message); }
    await this.billingDunningPass().catch(e => console.error('[Scheduler] régua de inadimplência falhou', e));
  }

  /**
   * ADR-153 F7.1 — varredura de recomendação de plano. Best-effort: erro numa
   * org não trava as outras. Idempotente por (org, dedupe_key). Roda no slow
   * pass junto com clinica/escola.
   */
  static planFitPass() {
    try {
      const r = PlanFitSignalPublisher.runAll();
      if (r.totalPublished > 0 || r.totalResolved > 0) {
        console.log(`[Scheduler] plan-fit: ${r.orgsSeen} orgs varridas, ${r.totalPublished} sinais publicados, ${r.totalResolved} resolvidos.`);
      }
    } catch (e) {
      console.error('[Scheduler] plan-fit falhou', e);
    }
  }

  /**
   * ADR-155 F4.1 — detector de risco de churn do cliente. Pra cada org opt-in
   * (`churn_detector_enabled=1`), pontua os contatos (fatura vencida + silêncio
   * + ticket frio) e publica `churn_risk_high` em business_signals (sweep resolve
   * quem saiu do risco). Advisory: sugere retenção, humano decide (RN-014).
   */
  static churnRiskPass() {
    try {
      const r = ChurnRiskDetectorService.runAll();
      if (r.published > 0 || r.resolved > 0) {
        console.log(`[Scheduler] churn-risk: ${r.orgs} orgs, ${r.published} sinais publicados, ${r.resolved} resolvidos.`);
      }
    } catch (e) {
      console.error('[Scheduler] churn-risk falhou', e);
    }
  }

  /**
   * ADR-159 F5 (D5) — progressive autonomy. Pra cada org opt-in
   * (`progressive_autonomy_enabled=1`) varre o histórico e PROPÕE (nunca aplica)
   * elevar a autonomia quando a evidência é forte. Só publica sinal pro dono
   * confirmar. Best-effort. Import dinâmico pra quebrar ciclo.
   */
  static async progressiveAutonomyPass() {
    try {
      const { ProgressiveAutonomyService } = await import("./ProgressiveAutonomyService.js");
      const r = ProgressiveAutonomyService.runAll();
      if (r.proposed > 0) console.info(`[Autonomy F5] progressive autonomy: ${r.orgs} org(s), ${r.proposed} proposta(s) de elevação.`);
    } catch (e: any) { console.error("[Autonomy F5] progressiveAutonomyPass falhou", e?.message); }
  }

  /**
   * ADR-159 F6 (D6) — detector de anomalia. Pra cada org opt-in
   * (`anomaly_detector_enabled=1`) varre execuções governadas falhas por janela e
   * publica/resolve `security/anomalous_behavior` em business_signals. Advisory.
   * Best-effort. Import dinâmico pra quebrar ciclo.
   */
  static async anomalyDetectorPass() {
    try {
      const { SecurityAnomalyDetectorService } = await import("./SecurityAnomalyDetectorService.js");
      const r = SecurityAnomalyDetectorService.runAll();
      if (r.published > 0 || r.resolved > 0) console.info(`[Security F6] anomalia: ${r.orgs} org(s), ${r.published} publicada(s), ${r.resolved} resolvida(s).`);
    } catch (e: any) { console.error("[Security F6] anomalyDetectorPass falhou", e?.message); }
  }

  /**
   * ADR-158 F4 (D6) — auto-disparo genérico sinal→process_instance. Pra cada org
   * opt-in DUPLO (`signal_auto_trigger_enabled=1` + `execution_runtime_enabled=1`)
   * roteia os sinais ABERTOS e MAPEADOS pra iniciar o processo correspondente
   * (fecha o elo hoje manual). Fica DEPOIS dos detectores (churn/cobrança) pra
   * rotear os sinais recém-publicados no mesmo tick. Auto-INICIAR não é efeito
   * externo (instância nasce em `detected`); qualquer ação externa segue
   * governada pelo CommandExecutor. Best-effort: erro numa org não trava as
   * outras. Import dinâmico pra quebrar ciclo.
   */
  static async signalAutoTriggerPass() {
    try {
      const rows = db.prepare(`
        SELECT organization_id AS orgId FROM organization_settings
         WHERE COALESCE(signal_auto_trigger_enabled,0) = 1 AND COALESCE(execution_runtime_enabled,0) = 1
      `).all() as any[];
      if (!rows.length) return;
      const { SignalProcessRouterService } = await import("./SignalProcessRouterService.js");
      let totalTriggered = 0;
      for (const r of rows) {
        try {
          const res = SignalProcessRouterService.routeOrg(r.orgId, { actor: "scheduler" });
          totalTriggered += res.triggered.length;
        } catch (e) { console.error("[Runtime F4] auto-trigger falhou pra org", r.orgId, e); }
      }
      if (totalTriggered > 0) console.info(`[Runtime F4] auto-disparo sinal→processo: ${rows.length} org(s), ${totalTriggered} processo(s) iniciado(s).`);
    } catch (e: any) { console.error("[Runtime F4] signalAutoTriggerPass falhou", e?.message); }
  }

  /**
   * ADR-154 F1.3 — publica sinais de cota de IA (80% attention / 100% critical)
   * pra orgs com `ai_monthly_limit_cents` definido. Best-effort e idempotente
   * (dedupe_key mensal por org). Só notifica — o gate real está em
   * PlanService.aiAllowed.
   */
  static aiQuotaPass() {
    try {
      const r = AiQuotaSignalService.runAll();
      if (r.warnings > 0 || r.exceeded > 0 || r.resolved > 0) {
        console.log(`[Scheduler] ai-quota: ${r.seen} orgs varridas, ${r.warnings} warning, ${r.exceeded} exceeded, ${r.resolved} resolvidos.`);
      }
    } catch (e) {
      console.error('[Scheduler] ai-quota falhou', e);
    }
  }

  /**
   * ADR-153 F7.7 — sweep de expiração de cooldowns vencidos no ledger
   * `upgrade_recommendations`. Cross-tenant (sem `orgId`) — uma única UPDATE
   * transiciona todas as linhas `dismissed` com `cooldown_until <= now` pra
   * `expired`. Antes desta fatia o sweep era lazy (só rodava se alguém
   * chamasse `expireOldCooldowns()` explicitamente); agora hora em hora.
   *
   * Por que hora em hora, mesmo com cooldowns de 30/90/180 dias?
   * - Operação é O(N linhas dismissed com timeout passado) — barato mesmo
   *   em escala (index no cooldown_until permite short-circuit).
   * - `AdminUpgradeRecommendationsPanel` (F7.6) filtra por status; se admin
   *   olhar uma cooldown que já venceu mas ainda está `dismissed`, vê estado
   *   desatualizado. Sweep hora em hora garante latência ≤ 1h.
   * - `hasActiveCooldown` no publisher já usa `cooldown_until > now` (não
   *   depende do sweep pra correctness) — este pass é UX + housekeeping.
   *
   * Idempotente. Silencioso quando nada mudou (evita spam de log).
   */
  static planFitCooldownExpirePass() {
    try {
      const changed = UpgradeRecommendationService.expireOldCooldowns();
      if (changed > 0) {
        console.log(`[Scheduler] plan-fit cooldown-expire: ${changed} recomendaç${changed === 1 ? 'ão' : 'ões'} passaram pra expired.`);
      }
    } catch (e) {
      console.error('[Scheduler] plan-fit cooldown-expire falhou', e);
    }
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
   * Analisa as operações de varejo (loja virtual/reservas/vendas) e publica os
   * sinais para o Pareto/Diretor IA — automático, para as orgs com a loja online
   * ligada. É a IA vigiando a operação sem o gestor precisar clicar.
   */
  static retailOpsSignalsPass() {
    let orgs: any[] = [];
    try { orgs = db.prepare(`SELECT organization_id FROM organization_settings WHERE COALESCE(online_store_reserve,0)=1`).all() as any[]; } catch { return; }
    for (const o of orgs) {
      try { RetailOpsSignalPublisher.run(o.organization_id); } catch (e) { console.error('[Retail] ops signals falhou', o.organization_id, e); }
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
