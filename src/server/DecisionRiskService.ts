import db from "./db.js";
import { randomUUID } from "crypto";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * DecisionRiskService — riscos previstos pela DI-2 (Pre-Mortem/Red Team),
 * aditivo sobre ADR-136. Ver docs/decision-intelligence/PLANO-E-FATIAS.md.
 *
 * Guarda a PREVISÃO de risco (probabilidade, indicador líder, limiar,
 * mitigação) na tabela `decision_risks` e — para riscos monitoráveis — PUBLICA
 * no ledger existente `business_signals` (domain 'decision'), NUNCA numa tabela
 * de alerta própria (convenção nº 12). Isso satisfaz o encadeamento do PRD
 * (§18): "todo risco → indicador monitorável → evento" reusando a
 * infraestrutura de sinais/alertas que já existe.
 *
 * Publicação em business_signals é BEST-EFFORT (convenção nº 7): falha ao
 * publicar não derruba o registro do risco. Só riscos com probabilidade
 * medium/high (ou severidade risk/critical) viram sinal — para não poluir a
 * caixa de alertas com hipóteses de baixa probabilidade.
 *
 * Ciclo: predicted → materialized (o indicador cruzou o limiar) → resolved (o
 * risco deixou de valer; resolve também o sinal via resolveByDedupe). Isolado
 * por organization_id (convenção nº 1); idempotente por (org, dedupe_key).
 */

export interface PredictedRisk {
  description: string;
  probability?: "low" | "medium" | "high";
  severity?: "info" | "attention" | "risk" | "critical";
  impactAmount?: number | null;
  impactUnit?: string | null;
  leadingIndicator?: string | null;
  threshold?: string | null;
  mitigation?: string | null;
  dedupeKey: string;
}

const PROB_CONFIDENCE: Record<string, number> = { high: 0.8, medium: 0.6, low: 0.35 };

export class DecisionRiskService {
  /**
   * Registra os riscos previstos (idempotente por dedupe_key) e publica os
   * monitoráveis em business_signals. Retorna os ids gravados.
   */
  static record(orgId: string, input: { decisionId?: string | null; source?: string; risks: PredictedRisk[] }): { ids: string[]; published: number } {
    const source = input.source || "premortem";
    const ids: string[] = [];
    let published = 0;

    for (const r of input.risks || []) {
      if (!r?.description || !r?.dedupeKey) continue;
      const severity = r.severity || (r.probability === "high" ? "risk" : "attention");
      const dedupeKey = `decision:risk:${r.dedupeKey}`;

      // Publica no ledger só se for monitorável e relevante (best-effort).
      let signalId: string | null = null;
      const monitorable = (r.probability === "high" || r.probability === "medium" || severity === "risk" || severity === "critical");
      if (monitorable) {
        try {
          const out = BusinessSignalService.publish(orgId, {
            domain: "decision",
            signalType: "decision_risk",
            severity,
            basis: "estimate",
            confidence: PROB_CONFIDENCE[r.probability || "medium"] ?? 0.6,
            impactAmount: r.impactAmount ?? null,
            impactUnit: r.impactUnit ?? null,
            sourceService: "DecisionEngine",
            sourceEntityType: input.decisionId ? "decision_action" : null,
            sourceEntityId: input.decisionId ?? null,
            evidence: { leadingIndicator: r.leadingIndicator || null, threshold: r.threshold || null, mitigation: r.mitigation || null, decisionId: input.decisionId || null, source },
            dedupeKey,
          });
          signalId = out.id;
          published++;
        } catch { /* best-effort: nunca derruba o registro do risco */ }
      }

      const existing = db.prepare("SELECT id FROM decision_risks WHERE organization_id = ? AND dedupe_key = ?").get(orgId, r.dedupeKey) as any;
      if (existing) {
        db.prepare(`UPDATE decision_risks SET decision_id=?, source=?, description=?, probability=?, severity=?, impact_amount=?, impact_unit=?, leading_indicator=?, threshold=?, mitigation=?, signal_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(input.decisionId || null, source, r.description, r.probability || null, severity, r.impactAmount ?? null, r.impactUnit ?? null, r.leadingIndicator ?? null, r.threshold ?? null, r.mitigation ?? null, signalId, existing.id);
        ids.push(existing.id);
      } else {
        const id = randomUUID();
        db.prepare(`INSERT INTO decision_risks (id, organization_id, decision_id, source, description, probability, severity, impact_amount, impact_unit, leading_indicator, threshold, mitigation, status, dedupe_key, signal_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'predicted', ?, ?)`)
          .run(id, orgId, input.decisionId || null, source, r.description, r.probability || null, severity, r.impactAmount ?? null, r.impactUnit ?? null, r.leadingIndicator ?? null, r.threshold ?? null, r.mitigation ?? null, r.dedupeKey, signalId);
        ids.push(id);
      }
    }
    return { ids, published };
  }

  /** Lista riscos (isolado por org), filtros opcionais por decisão/status. */
  static list(orgId: string, opts: { decisionId?: string; status?: string } = {}): any[] {
    let sql = "SELECT * FROM decision_risks WHERE organization_id = ?";
    const params: any[] = [orgId];
    if (opts.decisionId) { sql += " AND decision_id = ?"; params.push(opts.decisionId); }
    if (opts.status) { sql += " AND status = ?"; params.push(opts.status); }
    sql += " ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'risk' THEN 1 WHEN 'attention' THEN 2 ELSE 3 END, predicted_at DESC LIMIT 200";
    return db.prepare(sql).all(...params) as any[];
  }

  /** O indicador líder cruzou o limiar: o risco materializou. */
  static materialize(orgId: string, id: string): { ok: boolean } {
    const r = db.prepare("UPDATE decision_risks SET status='materialized', materialized_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND status='predicted'").run(id, orgId);
    return { ok: r.changes > 0 };
  }

  /** O risco deixou de valer: resolve o registro e o sinal correspondente. */
  static resolve(orgId: string, id: string): { ok: boolean } {
    const row = db.prepare("SELECT dedupe_key FROM decision_risks WHERE id=? AND organization_id=?").get(id, orgId) as any;
    const r = db.prepare("UPDATE decision_risks SET status='resolved', resolved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=? AND organization_id=? AND status IN ('predicted','materialized')").run(id, orgId);
    if (r.changes > 0 && row?.dedupe_key) {
      try { BusinessSignalService.resolveByDedupe(orgId, `decision:risk:${row.dedupe_key}`); } catch { /* best-effort */ }
    }
    return { ok: r.changes > 0 };
  }
}

export default DecisionRiskService;
