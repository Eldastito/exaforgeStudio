/**
 * OutcomeAssuranceMetricsService — PRD 8 / ADR-165 F11 (§13, RN-004): métricas de garantia.
 *
 * Mede o quão longe o `DONE` está do `RESULTADO` na operação: das ações concluídas, quantas
 * tiveram o efeito confirmado, o impacto medido, e quantas viraram GAP aberto. Tudo DERIVADO
 * por query sobre o que a espinha já registra (decision_actions × action_confirmations ×
 * action_outcomes × business_signals de outcome_assurance) — nenhuma tabela/contador novo
 * (RN-004). Read-only, determinístico (`now` injetável), isolado por `organization_id`.
 *
 * KPIs (janela default 30 dias, por completed_at/created_at):
 *   - outcomeCoveragePct  = ações done COM outcome / done      (fecha o gap (b))
 *   - effectConfirmedPct  = done com confirmação confirmada / done
 *   - assuredPct          = done com confirmação E outcome / done  (a barra do "assured")
 *   - openGaps            = sinais de garantia abertos (done_without_outcome / confirmation_timed_out)
 */
import db from "./db.js";

const round1 = (n: number) => Math.round(n * 10) / 10;

export class OutcomeAssuranceMetricsService {
  static metrics(orgId: string, opts: { now?: number; days?: number } = {}): any {
    if (!orgId) return { available: false, reason: "no_org" };
    const now = opts.now ?? Date.now();
    const days = Math.min(Math.max(Number(opts.days) || 30, 1), 365);
    const since = new Date(now - days * 86400000).toISOString();

    const done = (db.prepare(
      `SELECT COUNT(*) c FROM decision_actions WHERE organization_id = ? AND status = 'done' AND COALESCE(completed_at, created_at) >= ?`
    ).get(orgId, since) as any).c as number;

    const measured = (db.prepare(
      `SELECT COUNT(*) c FROM decision_actions a WHERE a.organization_id = ? AND a.status = 'done' AND COALESCE(a.completed_at, a.created_at) >= ?
         AND EXISTS (SELECT 1 FROM action_outcomes o WHERE o.action_id = a.id AND o.organization_id = a.organization_id)`
    ).get(orgId, since) as any).c as number;

    const confirmed = (db.prepare(
      `SELECT COUNT(*) c FROM decision_actions a WHERE a.organization_id = ? AND a.status = 'done' AND COALESCE(a.completed_at, a.created_at) >= ?
         AND EXISTS (SELECT 1 FROM action_confirmations c WHERE c.action_id = a.id AND c.organization_id = a.organization_id AND c.status = 'confirmed')`
    ).get(orgId, since) as any).c as number;

    const assured = (db.prepare(
      `SELECT COUNT(*) c FROM decision_actions a WHERE a.organization_id = ? AND a.status = 'done' AND COALESCE(a.completed_at, a.created_at) >= ?
         AND EXISTS (SELECT 1 FROM action_confirmations c WHERE c.action_id = a.id AND c.organization_id = a.organization_id AND c.status = 'confirmed')
         AND EXISTS (SELECT 1 FROM action_outcomes o WHERE o.action_id = a.id AND o.organization_id = a.organization_id)`
    ).get(orgId, since) as any).c as number;

    const gapRows = db.prepare(
      `SELECT signal_type, COUNT(*) c FROM business_signals WHERE organization_id = ? AND domain = 'outcome_assurance' AND status = 'open' GROUP BY signal_type`
    ).all(orgId) as any[];
    const openGaps: Record<string, number> = { done_without_outcome: 0, confirmation_timed_out: 0 };
    let openGapsTotal = 0;
    for (const g of gapRows) { openGaps[g.signal_type] = g.c; openGapsTotal += g.c; }

    const pct = (num: number, den: number) => (den > 0 ? round1((num / den) * 100) : null);

    return {
      available: true,
      windowDays: days,
      generatedAt: new Date(now).toISOString(),
      done,
      // DONE ≠ RESULTADO tornado número: das concluídas, quantas de fato foram confirmadas/medidas.
      outcomeCoveragePct: pct(measured, done),
      effectConfirmedPct: pct(confirmed, done),
      assuredPct: pct(assured, done),
      counts: { measured, confirmed, assured },
      openGaps, openGapsTotal,
      gapRatePct: pct(openGaps.done_without_outcome, done),   // done que virou gap de medição
      note: "Derivado por query (RN-004); read-only. null quando não há ações concluídas na janela (RN-OA-2 — não inventa 0%).",
    };
  }
}

export default OutcomeAssuranceMetricsService;
