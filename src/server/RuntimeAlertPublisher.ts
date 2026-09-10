/**
 * RuntimeAlertPublisher (ADR-152 §17) — torna as exceções do Runtime PROATIVAS.
 *
 * Antes: `RuntimeExceptionsService` só existia por PULL (lido num GET). Nada
 * empurrava as exceções pra a superfície de atenção; um processo escalado/falho,
 * uma ação com SLA estourado, um job na dead-letter ou uma confirmação vencida
 * ficavam invisíveis até alguém abrir a tela de Operações.
 *
 * Esta fatia publica cada exceção como `business_signal` DEDUPLICADO (domain
 * `runtime`), reusando o MESMO ledger de sinais (ADR-136) — sem tabela de alerta
 * paralela (convenção nº 12). Além das exceções já detectadas, acrescenta duas
 * detecções PROATIVAS que faltavam (§17):
 *   - SLA EM RISCO (antes de estourar): ação aprovada com `deadline_at` dentro da
 *     janela de aviso (ainda não vencida) — avisa ANTES, não depois.
 *   - PROCESSO SEM EVOLUÇÃO: instância `executing`/`waiting_external_response`
 *     parada há mais que o limiar (travada).
 *
 * SELF-HEALING: sinais `runtime` deste publisher cujo problema sumiu são
 * RESOLVIDOS (resolveByDedupe) — o alerta não fica pendurado depois de resolvido.
 * Idempotente (dedupe por artefato), read-only sobre o Runtime (não muda FSM),
 * isolado por org.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { RuntimeExceptionsService, ExceptionCategory } from "./RuntimeExceptionsService.js";

const SOURCE = "RuntimeAlertPublisher";

// Categoria → severidade do ledger (info|attention|risk|critical).
const SEVERITY_BY_CATEGORY: Record<ExceptionCategory, string> = {
  integration_failed: "risk",
  credential_missing: "attention",
  risk_high: "critical",
  data_missing: "attention",
  decision_needed: "attention",
  approval_needed: "attention",
  sla_at_risk: "risk",
  conflict: "risk",
  irreversible_action: "critical",
  sensitive_customer: "risk",
};

export interface RuntimeAlertRunResult {
  published: number;   // sinais publicados/atualizados nesta passada
  resolved: number;    // sinais antigos auto-resolvidos (self-heal)
}

export class RuntimeAlertPublisher {
  /**
   * Publica os sinais de runtime da org e auto-resolve os que sumiram.
   * @param opts.stuckMinutes  limiar de "sem evolução" (default 120).
   * @param opts.slaWarnMinutes janela de aviso ANTES do deadline (default 60).
   * @param opts.now           instante base (testes determinísticos).
   */
  static run(orgId: string, opts: { stuckMinutes?: number; slaWarnMinutes?: number; now?: Date } = {}): RuntimeAlertRunResult {
    const now = opts.now || new Date();
    const stuckMinutes = opts.stuckMinutes ?? 120;
    const slaWarnMinutes = opts.slaWarnMinutes ?? 60;

    const live = new Set<string>(); // dedupe keys ativos nesta passada
    let published = 0;

    const emit = (dedupeKey: string, signalType: string, severity: string, subject: string, evidence: any, ids: { processInstanceId?: string | null; actionId?: string | null }) => {
      live.add(dedupeKey);
      BusinessSignalService.publish(orgId, {
        domain: "runtime", signalType, severity, basis: "fact", confidence: 1,
        dedupeKey, sourceService: SOURCE,
        sourceEntityType: ids.processInstanceId ? "process_instance" : ids.actionId ? "decision_action" : "runtime",
        sourceEntityId: ids.processInstanceId || ids.actionId || null,
        evidence: { subject, ...evidence },
      } as any);
      published++;
    };

    // ── 1. Exceções já detectadas (reusa o read model existente) ──
    for (const ex of RuntimeExceptionsService.list(orgId, { limit: 500 })) {
      const severity = SEVERITY_BY_CATEGORY[ex.category] || "attention";
      emit(`runtime:${ex.source}:${ex.id}`, ex.source, severity, ex.subject,
        { category: ex.category, recommendedAction: ex.recommendedAction, since: ex.since, ...ex.evidence },
        { processInstanceId: ex.processInstanceId, actionId: ex.actionId });
    }

    // ── 2. SLA EM RISCO (antes de estourar): ação aprovada com deadline na janela ──
    // `RuntimeExceptionsService` já cobre o deadline VENCIDO; aqui é o AVISO prévio.
    try {
      const warnRows = db.prepare(
        `SELECT id, domain, action_type, title, deadline_at
           FROM decision_actions
          WHERE organization_id = ? AND status = 'approved'
            AND deadline_at IS NOT NULL
            AND datetime(deadline_at) > datetime(?)
            AND datetime(deadline_at) <= datetime(?, '+' || ? || ' minutes')
          ORDER BY deadline_at ASC LIMIT 200`
      ).all(orgId, now.toISOString(), now.toISOString(), slaWarnMinutes) as any[];
      for (const r of warnRows) {
        emit(`runtime:sla_warning:${r.id}`, "sla_at_risk", "attention", r.title || `Ação ${r.action_type}`,
          { domain: r.domain, actionType: r.action_type, deadline: r.deadline_at, recommendedAction: "SLA perto de estourar — priorize esta ação." },
          { actionId: r.id });
      }
    } catch { /* colunas ausentes → ignora (0-regressão) */ }

    // ── 3. PROCESSO SEM EVOLUÇÃO: executing/waiting parado há > limiar ──
    try {
      const stuckRows = db.prepare(
        `SELECT id, process_type, subject_type, subject_id, status, current_step, updated_at
           FROM process_instances
          WHERE organization_id = ? AND status IN ('executing','waiting_external_response')
            AND updated_at IS NOT NULL
            AND datetime(updated_at) <= datetime(?, '-' || ? || ' minutes')
          ORDER BY updated_at ASC LIMIT 200`
      ).all(orgId, now.toISOString(), stuckMinutes) as any[];
      for (const r of stuckRows) {
        emit(`runtime:stuck:${r.id}`, "process_stalled", "attention", `${r.process_type} sem evolução`,
          { status: r.status, currentStep: r.current_step, since: r.updated_at, recommendedAction: "Processo parado — verifique o passo atual / dependência externa." },
          { processInstanceId: r.id });
      }
    } catch { /* colunas ausentes → ignora */ }

    // ── 4. SELF-HEAL: resolve sinais runtime deste publisher que sumiram ──
    let resolved = 0;
    try {
      const open = db.prepare(
        `SELECT dedupe_key FROM business_signals
          WHERE organization_id = ? AND domain = 'runtime' AND source_service = ? AND status = 'open'`
      ).all(orgId, SOURCE) as any[];
      for (const s of open) {
        if (s.dedupe_key && !live.has(s.dedupe_key)) {
          if (BusinessSignalService.resolveByDedupe(orgId, s.dedupe_key).ok) resolved++;
        }
      }
    } catch { /* best-effort */ }

    return { published, resolved };
  }
}

export default RuntimeAlertPublisher;
