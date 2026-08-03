import db from "./db.js";

/**
 * RuntimeExceptionsService — Exception Center do Execution Runtime
 * (ADR-152 Fatia 3.1, PRD §11.12).
 *
 * DERIVA exceções por queries SQL sobre estado — NUNCA cria tabela própria.
 * Fontes:
 *   (a) `process_instances.status IN (escalated, failed)` — o playbook
 *       parou por decisão do próprio Runtime;
 *   (b) `decision_actions.status='approved' AND deadline_at < now` — SLA
 *       estourou (a Fase 3.2 apresenta como "SLA em risco");
 *   (c) `background_jobs.status='failed'` — dead-letter da JobQueue
 *       (F2.1). Erro é categorizado por `error_class`:
 *         - `permission` → "credencial ausente" (humano cadastra);
 *         - `external_unavailable` → "integração indisponível";
 *         - `non_retryable` → "dado inválido / conflito";
 *         - default → "erro operacional" (retryable esgotou tentativas).
 *   (d) `action_confirmations.status='timed_out'` — o webhook nunca
 *       chegou; ação continua `approved` esperando ação humana.
 *
 * Cada exceção retorna:
 *   { category, source, id, subject, since, evidence, recommendedAction }
 *
 * Categorias (PRD §11.12):
 *   integration_failed | credential_missing | risk_high | data_missing |
 *   decision_needed | approval_needed | sla_at_risk | conflict |
 *   irreversible_action | sensitive_customer
 *
 * A Fase 3.2 (aba Operações) consome list() + count(). Isolado por org.
 * Deterministic; sem I/O externo. Chamado só via GET /api/runtime/operations/*.
 */

export type ExceptionCategory =
  | "integration_failed"
  | "credential_missing"
  | "risk_high"
  | "data_missing"
  | "decision_needed"
  | "approval_needed"
  | "sla_at_risk"
  | "conflict"
  | "irreversible_action"
  | "sensitive_customer";

export type ExceptionSource =
  | "process_escalated"
  | "process_failed"
  | "action_overdue"
  | "job_dead_letter"
  | "confirmation_timeout";

export interface RuntimeException {
  category: ExceptionCategory;
  source: ExceptionSource;
  id: string;                        // id do artefato de origem (process_instance | action | job | confirmation)
  subject: string;                   // texto humano-legível curto
  since: string | null;              // quando aconteceu
  evidence: any;                     // JSON com contexto
  recommendedAction: string;         // "aprove", "cadastre credencial", ...
  processInstanceId?: string | null;
  actionId?: string | null;
}

export interface OperationsOverview {
  running: { processes: number; awaitingApproval: number; awaitingConfirmation: number };
  completedToday: { processes: number; actions: number; outcomes: { count: number; realized: number; timeSavedMinutes: number; revenueRecovered: number; costAvoided: number; lossPrevented: number } };
  exceptionsCount: number;
  slaBreached: number;
}

export class RuntimeExceptionsService {
  /**
   * Lista todas as exceções vivas da org, categorizadas. Ordem: mais
   * urgentes primeiro (`credential_missing`, `sla_at_risk`,
   * `integration_failed`), depois cronológico (mais antigas primeiro).
   */
  static list(orgId: string, opts: { limit?: number } = {}): RuntimeException[] {
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 500);
    const out: RuntimeException[] = [];

    // (a) processos escalados/falhos
    for (const row of db.prepare(
      `SELECT id, process_type, subject_type, subject_id, status, current_step, updated_at, failed_at, started_at
       FROM process_instances
       WHERE organization_id = ? AND status IN ('escalated','failed')
       ORDER BY COALESCE(failed_at, updated_at) DESC LIMIT ?`
    ).all(orgId, limit) as any[]) {
      out.push({
        category: row.status === "escalated" ? "decision_needed" : "conflict",
        source: row.status === "escalated" ? "process_escalated" : "process_failed",
        id: row.id,
        subject: `${row.process_type}${row.subject_id ? ` · ${row.subject_type}:${row.subject_id}` : ""}`,
        since: row.failed_at || row.updated_at || row.started_at,
        evidence: { processType: row.process_type, currentStep: row.current_step, status: row.status },
        recommendedAction: row.status === "escalated" ? "Decisão humana necessária — abra o processo e resolva." : "Playbook falhou — investigue a linha do tempo do processo.",
        processInstanceId: row.id,
      });
    }

    // (b) ação aprovada com deadline vencido → SLA em risco
    for (const row of db.prepare(
      `SELECT id, domain, action_type, title, deadline_at, expected_impact
       FROM decision_actions
       WHERE organization_id = ? AND status = 'approved'
         AND deadline_at IS NOT NULL AND datetime(deadline_at) <= CURRENT_TIMESTAMP
       ORDER BY deadline_at ASC LIMIT ?`
    ).all(orgId, limit) as any[]) {
      out.push({
        category: "sla_at_risk",
        source: "action_overdue",
        id: row.id,
        subject: `${row.title || row.action_type} (${row.domain})`,
        since: row.deadline_at,
        evidence: { domain: row.domain, actionType: row.action_type, expectedImpact: row.expected_impact, deadline: row.deadline_at },
        recommendedAction: "SLA vencido — conclua manualmente ou reagende.",
        actionId: row.id,
      });
    }

    // (c) job dead-letter (F2.1). Ligamos ao actionId se o payload
    // carrega — mas o vínculo formal Job×Action vem só na F4 (piloto).
    // Nesta fatia usamos o `type` do job pra categorizar.
    for (const row of db.prepare(
      `SELECT id, type, error_class, last_error, completed_at, created_at, payload_json
       FROM background_jobs
       WHERE organization_id = ? AND status = 'failed'
       ORDER BY completed_at DESC LIMIT ?`
    ).all(orgId, limit) as any[]) {
      const cls = String(row.error_class || "").toLowerCase();
      const cat: ExceptionCategory =
        cls === "permission" ? "credential_missing" :
        cls === "external_unavailable" ? "integration_failed" :
        cls === "non_retryable" ? "conflict" :
        "integration_failed";
      let actionId: string | null = null;
      try { const p = row.payload_json ? JSON.parse(row.payload_json) : null; if (p && typeof p.actionId === "string") actionId = p.actionId; } catch { /* noop */ }
      out.push({
        category: cat,
        source: "job_dead_letter",
        id: row.id,
        subject: `Job ${row.type} (${cls || "erro"})`,
        since: row.completed_at || row.created_at,
        evidence: { type: row.type, errorClass: row.error_class, lastError: row.last_error },
        recommendedAction:
          cat === "credential_missing" ? "Cadastre a credencial do provedor e reprocesse (JobQueueService.retry)." :
          cat === "integration_failed" ? "Provedor externo ficou fora do ar — reprocesse quando voltar." :
          "Reveja o payload e reprocesse manualmente.",
        actionId,
      });
    }

    // (d) confirmação com timeout (webhook nunca chegou)
    for (const row of db.prepare(
      `SELECT c.id, c.action_id, c.confirmation_method, c.external_ref, c.deadline_at, c.updated_at,
              a.title, a.domain, a.action_type
       FROM action_confirmations c
       LEFT JOIN decision_actions a ON a.id = c.action_id AND a.organization_id = c.organization_id
       WHERE c.organization_id = ? AND c.status = 'timed_out'
       ORDER BY c.updated_at DESC LIMIT ?`
    ).all(orgId, limit) as any[]) {
      out.push({
        category: "integration_failed",
        source: "confirmation_timeout",
        id: row.id,
        subject: `Confirmação vencida: ${row.title || row.action_id} (${row.confirmation_method})`,
        since: row.updated_at || row.deadline_at,
        evidence: { method: row.confirmation_method, externalRef: row.external_ref, deadline: row.deadline_at, actionTitle: row.title },
        recommendedAction: "O webhook do provedor não chegou — verifique o status manualmente ou reprocesse.",
        actionId: row.action_id,
      });
    }

    // Ordem: severidade primeiro, mais antigas primeiro dentro da mesma
    // categoria (agir no que estourou primeiro).
    const severityRank: Record<ExceptionCategory, number> = {
      credential_missing: 0, sla_at_risk: 1, integration_failed: 2,
      irreversible_action: 3, conflict: 4, sensitive_customer: 5,
      decision_needed: 6, approval_needed: 7, data_missing: 8, risk_high: 9,
    };
    out.sort((a, b) => (severityRank[a.category] - severityRank[b.category]) || String(a.since || "").localeCompare(String(b.since || "")));
    return out.slice(0, limit);
  }

  /** Contadores rápidos por categoria — pra badge da aba. */
  static count(orgId: string): { total: number; byCategory: Record<string, number> } {
    const items = this.list(orgId);
    const byCategory: Record<string, number> = {};
    for (const it of items) byCategory[it.category] = (byCategory[it.category] || 0) + 1;
    return { total: items.length, byCategory };
  }

  /**
   * Overview do painel Operações (Fatia 3.2). Números "em execução",
   * "concluído hoje" (agregando categorias explícitas de F3.1) e "exceções".
   * Determinístico, isolado por org. Datas em UTC — a UI apresenta em SP.
   */
  static overview(orgId: string): OperationsOverview {
    // Em execução
    // `escalated` NÃO conta em "running" — já aparece como exceção
    // `decision_needed` no Exception Center. Idem `failed` (conflict).
    // Isso deixa o painel "Em execução" com o que está REALMENTE andando.
    const runningRow = db.prepare(
      `SELECT
         SUM(CASE WHEN status NOT IN ('completed','failed','cancelled','measured','escalated') THEN 1 ELSE 0 END) AS running,
         SUM(CASE WHEN status = 'awaiting_approval' THEN 1 ELSE 0 END) AS awaiting_approval,
         SUM(CASE WHEN status = 'waiting_external_response' THEN 1 ELSE 0 END) AS waiting_external
       FROM process_instances WHERE organization_id = ?`
    ).get(orgId) as any;

    // Concluído hoje — processos + ações + agregados de outcome
    const todayFilter = "date(measured_at) = date('now')";
    const outcomesToday = db.prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(realized_value),0) realized,
              COALESCE(SUM(time_saved_minutes),0) tsm,
              COALESCE(SUM(revenue_recovered),0) rev,
              COALESCE(SUM(cost_avoided),0) cost,
              COALESCE(SUM(loss_prevented),0) loss
       FROM action_outcomes WHERE organization_id = ? AND ${todayFilter}`
    ).get(orgId) as any;
    const processesToday = (db.prepare(
      `SELECT COUNT(*) c FROM process_instances WHERE organization_id = ? AND status IN ('completed','measured') AND date(completed_at) = date('now')`
    ).get(orgId) as any).c;
    const actionsToday = (db.prepare(
      `SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ? AND status = 'done' AND date(completed_at) = date('now')`
    ).get(orgId) as any).c;

    // Exceções — reusa o list() (mesmas queries).
    const excCount = this.count(orgId);
    const sla = (db.prepare(
      `SELECT COUNT(*) c FROM decision_actions
       WHERE organization_id = ? AND status = 'approved'
         AND deadline_at IS NOT NULL AND datetime(deadline_at) <= CURRENT_TIMESTAMP`
    ).get(orgId) as any).c;

    const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

    return {
      running: {
        processes: Number(runningRow?.running || 0),
        awaitingApproval: Number(runningRow?.awaiting_approval || 0),
        awaitingConfirmation: Number(runningRow?.waiting_external || 0),
      },
      completedToday: {
        processes: Number(processesToday || 0),
        actions: Number(actionsToday || 0),
        outcomes: {
          count: Number(outcomesToday?.c || 0),
          realized: round2(outcomesToday?.realized || 0),
          timeSavedMinutes: Math.trunc(Number(outcomesToday?.tsm || 0)),
          revenueRecovered: round2(outcomesToday?.rev || 0),
          costAvoided: round2(outcomesToday?.cost || 0),
          lossPrevented: round2(outcomesToday?.loss || 0),
        },
      },
      exceptionsCount: excCount.total,
      slaBreached: Number(sla || 0),
    };
  }

  /**
   * Indicadores de observabilidade (PRD §17) — os que dá pra derivar por
   * query. Fase 3.2 renderiza como cards.
   */
  static indicators(orgId: string): Record<string, number> {
    const q = (sql: string, ...params: any[]) => Number((db.prepare(sql).get(orgId, ...params) as any)?.c || 0);
    return {
      processesTotal: q(`SELECT COUNT(*) c FROM process_instances WHERE organization_id = ?`),
      processesRunning: q(`SELECT COUNT(*) c FROM process_instances WHERE organization_id = ? AND status NOT IN ('completed','failed','cancelled','measured')`),
      processesCompleted: q(`SELECT COUNT(*) c FROM process_instances WHERE organization_id = ? AND status IN ('completed','measured')`),
      processesFailed: q(`SELECT COUNT(*) c FROM process_instances WHERE organization_id = ? AND status = 'failed'`),
      processesEscalated: q(`SELECT COUNT(*) c FROM process_instances WHERE organization_id = ? AND status = 'escalated'`),
      actionsAwaitingApproval: q(`SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ? AND status = 'awaiting_approval'`),
      actionsApproved: q(`SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ? AND status = 'approved'`),
      actionsDone: q(`SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ? AND status = 'done'`),
      confirmationsPending: q(`SELECT COUNT(*) c FROM action_confirmations WHERE organization_id = ? AND status = 'pending'`),
      confirmationsTimedOut: q(`SELECT COUNT(*) c FROM action_confirmations WHERE organization_id = ? AND status = 'timed_out'`),
      jobsPending: q(`SELECT COUNT(*) c FROM background_jobs WHERE organization_id = ? AND status = 'pending'`),
      jobsFailed: q(`SELECT COUNT(*) c FROM background_jobs WHERE organization_id = ? AND status = 'failed'`),
    };
  }
}

export default RuntimeExceptionsService;
