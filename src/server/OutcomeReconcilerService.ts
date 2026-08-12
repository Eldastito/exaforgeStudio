/**
 * OutcomeReconcilerService — PRD 8 / ADR-165 F6 (§13, achado (b), RN-OA-1): Reconciler
 * de medição.
 *
 * A auditoria F0 achou o measurement gap (b): `DecisionActionService.complete:212` engole
 * a falha de `OutcomeMeasurementService.record` num catch VAZIO — a ação fica `done` SEM
 * `action_outcome`, sem log, sem sinal. O loop prometido×entregue fica aberto e ninguém vê.
 *
 * Este Reconciler torna o gap VISÍVEL sem mudar a FSM: varre ações `done` que passaram do
 * prazo de medição e NÃO têm outcome, e publica um `business_signal` (canal canônico de
 * exceção, convenção ADR-136) — que aparece em `attention()`. Quando o outcome finalmente
 * chega (medição atrasada), RESOLVE o sinal (recuperou). NÃO cria tabela de alerta própria.
 *
 * GUARDRAILS (RN-OA):
 *   - RN-OA-3 — não muda a FSM da ação; só publica/resolve sinal (derivado).
 *   - RN-OA-2 — janela de graça (`graceMinutes`): a medição é best-effort/assíncrona, então
 *     só marca ações `done` há tempo suficiente — não acusa gap de algo recém-concluído.
 *   - Idempotente por `dedupeKey` (uma exceção por ação); best-effort (nunca throw pro tick).
 *   - Determinístico (`now` injetável); isolado por `organization_id`.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

const DEFAULT_GRACE_MIN = 15; // ação done há menos que isso ainda pode estar medindo (RN-OA-2)
const DEDUPE_PREFIX = "outcome_assurance:done_without_outcome:";

export class OutcomeReconcilerService {
  /**
   * Reconciliação de uma org: sinaliza done-sem-outcome (após a graça) e resolve os que
   * já foram medidos. Read/observe sobre a FSM (não a altera). Retorna contadores.
   */
  static reconcile(orgId: string, opts: { now?: number; graceMinutes?: number; limit?: number } = {}): { flagged: number; resolved: number } {
    if (!orgId) return { flagged: 0, resolved: 0 };
    const now = opts.now ?? Date.now();
    const graceMin = opts.graceMinutes ?? DEFAULT_GRACE_MIN;
    const cutoffIso = new Date(now - graceMin * 60000).toISOString();
    const limit = Math.min(Math.max(Number(opts.limit) || 200, 1), 1000);

    // Ações done SEM outcome, concluídas antes do cutoff (fora da janela de graça).
    const gaps = db.prepare(
      `SELECT a.id, a.domain, a.action_type, a.title, a.correlation_id, a.completed_at
         FROM decision_actions a
         WHERE a.organization_id = ? AND a.status = 'done'
           AND COALESCE(a.completed_at, a.created_at) <= ?
           AND NOT EXISTS (SELECT 1 FROM action_outcomes o WHERE o.action_id = a.id AND o.organization_id = a.organization_id)
         ORDER BY a.completed_at ASC LIMIT ?`
    ).all(orgId, cutoffIso, limit) as any[];

    let flagged = 0;
    for (const a of gaps) {
      try {
        BusinessSignalService.publish(orgId, {
          domain: "outcome_assurance",
          signalType: "done_without_outcome",
          severity: "attention",
          basis: "fact",                          // é FATO que a ação está done sem outcome
          confidence: 1,
          sourceService: "OutcomeReconcilerService",
          sourceEntityType: "decision_action",
          sourceEntityId: a.id,
          subjectType: "decision_action",
          subjectId: a.id,
          correlationId: a.correlation_id || null,
          evidence: { actionId: a.id, domain: a.domain, actionType: a.action_type, title: a.title, completedAt: a.completed_at, gap: "done_without_outcome" },
          dedupeKey: `${DEDUPE_PREFIX}${a.id}`,
        });
        flagged++;
      } catch { /* best-effort — nunca derruba o caller (convenção 7) */ }
    }

    // Recuperou: ações que agora TÊM outcome mas ainda têm sinal aberto → resolve.
    let resolved = 0;
    const open = db.prepare(
      `SELECT source_entity_id AS actionId, dedupe_key FROM business_signals
        WHERE organization_id = ? AND domain = 'outcome_assurance' AND signal_type = 'done_without_outcome' AND status = 'open'`
    ).all(orgId) as any[];
    for (const s of open) {
      const hasOutcome = db.prepare("SELECT 1 FROM action_outcomes WHERE action_id = ? AND organization_id = ? LIMIT 1").get(s.actionId, orgId);
      if (hasOutcome) {
        try { if (BusinessSignalService.resolveByDedupe(orgId, s.dedupe_key)?.ok) resolved++; } catch { /* best-effort */ }
      }
    }
    return { flagged, resolved };
  }

  /** Orgs com ações done recentes — alvo do pass do Scheduler (evita varrer tudo). */
  static orgsToReconcile(): string[] {
    try {
      return (db.prepare(
        `SELECT DISTINCT organization_id FROM decision_actions WHERE status = 'done' AND COALESCE(completed_at, created_at) >= datetime('now','-7 days')`
      ).all() as any[]).map((r) => r.organization_id);
    } catch { return []; }
  }
}

export default OutcomeReconcilerService;
