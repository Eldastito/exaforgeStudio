/**
 * OutcomeAssuranceService — PRD 8 / ADR-165 F1 (§13, RN-OA-1..3): garantia de ciclo fechado.
 *
 * A tese do PRD 8 é `DONE ≠ RESULTADO`. Um `decision_action` chega a `done` porque a AÇÃO
 * foi disparada — não porque o dinheiro entrou, o problema se resolveu ou alguém mediu.
 * Este serviço DERIVA, sem mudar nada, em que ponto da cadeia cada ação/correlação está:
 *
 *   AÇÃO EXECUTADA → EFEITO CONFIRMADO → OUTCOME DE NEGÓCIO CONFIRMADO → IMPACTO MEDIDO
 *   (execution_log)   (confirmations)     (resolver — F3)                (action_outcomes)
 *
 * COMPÕE as peças que já existem (não recria): `decision_actions`, `action_execution_log`,
 * `action_confirmations`, `action_outcomes`. Isolado por `organization_id`.
 *
 * GUARDRAILS DUROS (RN-OA):
 *   - RN-OA-3 — **read-only**: NÃO escreve, NÃO muda a FSM, NÃO conclui processo. Estado
 *     100% DERIVADO por query (padrão RN-004). É uma leitura, não um novo estado persistido.
 *   - RN-OA-1 — `done` sem outcome confirmado NÃO é "sucesso": é `executed`/`impact_measured`
 *     com o gap `done_without_outcome` explícito, nunca "assured".
 *   - RN-OA-2 — null ≠ zero; ausência de evidência ≠ falha. Outcome não medido é
 *     `unknown`/`pending`, jamais R$ 0 ou fracasso.
 *   - Business Outcome (o "o problema se resolveu?") é responsabilidade do
 *     `BusinessOutcomeResolver` determinístico da F3 — aqui fica honestamente
 *     `resolver_pending`, nunca inferido de "done".
 */
import db from "./db.js";

export type AssuranceState = "unknown" | "planned" | "executed" | "effect_confirmed" | "impact_measured" | "assured";

export class OutcomeAssuranceService {
  /**
   * Deriva o estado de garantia de UMA ação (unidade atômica). Read-only.
   */
  static assessAction(orgId: string, actionId: string): any {
    if (!orgId || !actionId) return { actionId, found: false, assuranceState: "unknown" as AssuranceState };
    const action = db.prepare("SELECT * FROM decision_actions WHERE id = ? AND organization_id = ?").get(actionId, orgId) as any;
    if (!action) return { actionId, found: false, assuranceState: "unknown" as AssuranceState };

    // EXECUTADO — status done, ou execução done no log, ou executed_at carimbado.
    const execDone = db.prepare("SELECT COUNT(*) c FROM action_execution_log WHERE organization_id = ? AND action_id = ? AND status = 'done'").get(orgId, actionId) as any;
    const executed = action.status === "done" || (execDone?.c ?? 0) > 0 || !!action.executed_at;

    // EFEITO CONFIRMADO — action_confirmations (UNIQUE por ação).
    const conf = db.prepare("SELECT status, confirmation_method, confirmed_at FROM action_confirmations WHERE organization_id = ? AND action_id = ?").get(orgId, actionId) as any;
    const confirmationState: string = conf?.status ?? "none";
    const effectConfirmed = confirmationState === "confirmed";

    // IMPACTO MEDIDO — action_outcomes (pode haver mais de um; F5 trata dedupe).
    const outs = db.prepare("SELECT basis, measurement_method, realized_value FROM action_outcomes WHERE organization_id = ? AND action_id = ?").all(orgId, actionId) as any[];
    const impactMeasured = outs.length > 0;
    const anyFact = outs.some((o) => o.basis === "fact");

    // ── estado derivado (a escada; o topo alcançado) ──
    // "assured" exige efeito confirmado E impacto medido — nunca só "done" (RN-OA-1).
    let assuranceState: AssuranceState = "planned";
    if (effectConfirmed && impactMeasured) assuranceState = "assured";
    else if (impactMeasured) assuranceState = "impact_measured";
    else if (effectConfirmed) assuranceState = "effect_confirmed";
    else if (executed) assuranceState = "executed";

    // ── gaps (RN-OA) ──
    const gaps: string[] = [];
    // Achado (b) da auditoria F0: done sem action_outcome (medição engolida silenciosamente).
    if (action.status === "done" && !impactMeasured) gaps.push("done_without_outcome");
    if (confirmationState === "pending") gaps.push("confirmation_pending");
    if (confirmationState === "timed_out") gaps.push("confirmation_timed_out");
    if (action.status === "done" && confirmationState === "none") gaps.push("done_without_confirmation_record");

    return {
      actionId, found: true, domain: action.domain, actionType: action.action_type,
      actionStatus: action.status, correlationId: action.correlation_id ?? null,
      stages: {
        executed: { reached: executed, evidence: executed ? { execLogDone: (execDone?.c ?? 0) > 0, executedAt: action.executed_at ?? null } : null },
        effectConfirmed: { reached: effectConfirmed, confirmationState, method: conf?.confirmation_method ?? null, confirmedAt: conf?.confirmed_at ?? null },
        // Business outcome é da F3 (resolver determinístico) — honesto, nunca inferido de "done".
        businessOutcomeConfirmed: { reached: "unknown", reason: "resolver_pending" },
        impactMeasured: { reached: impactMeasured, count: outs.length, anyFactBasis: anyFact },
      },
      assuranceState,
      gaps,
      isDoneWithoutOutcome: action.status === "done" && !impactMeasured,
      note: "Estado DERIVADO read-only (RN-OA-3); DONE ≠ RESULTADO (RN-OA-1). Confirmação de outcome de negócio entra na F3.",
    };
  }

  /**
   * Deriva a garantia de uma CORRELAÇÃO inteira (todas as ações do fio). Read-only.
   * `overall` = o PIOR estado entre as ações (uma ação sem garantia rebaixa o fio).
   */
  static assessCorrelation(orgId: string, correlationId: string): any {
    const cid = String(correlationId || "").trim();
    if (!orgId || !cid) return { correlationId: cid, actions: [], overall: "unknown" as AssuranceState, gaps: [] };
    const actionIds = (db.prepare("SELECT id FROM decision_actions WHERE organization_id = ? AND correlation_id = ? ORDER BY created_at ASC, id ASC").all(orgId, cid) as any[]).map((r) => r.id);
    const assessments = actionIds.map((id) => this.assessAction(orgId, id));
    const overall = this.worstState(assessments.map((a) => a.assuranceState));
    const gaps = [...new Set(assessments.flatMap((a) => a.gaps))];
    return {
      correlationId: cid,
      actionCount: assessments.length,
      overall,
      gaps,
      hasDoneWithoutOutcome: assessments.some((a) => a.isDoneWithoutOutcome),
      actions: assessments,
      note: "Garantia derivada do fio inteiro (RN-OA-3, read-only). overall = pior estado entre as ações.",
    };
  }

  private static readonly ORDER: AssuranceState[] = ["unknown", "planned", "executed", "effect_confirmed", "impact_measured", "assured"];
  /** Pior (menor) estado da escada — uma ação frouxa rebaixa o fio. */
  static worstState(states: AssuranceState[]): AssuranceState {
    if (!states.length) return "unknown";
    return states.reduce((worst, s) => (this.ORDER.indexOf(s) < this.ORDER.indexOf(worst) ? s : worst), "assured" as AssuranceState);
  }
}

export default OutcomeAssuranceService;
