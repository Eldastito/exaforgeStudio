import { randomUUID } from "node:crypto";
import db from "./db.js";
import { ProspectResearchService } from "./ProspectResearchService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * CreativeExperimentService — Creative Experiment Engine (PRD 11 / ADR-168 F6).
 *
 * O PRD 10 gera variantes A/B/C (`CreativeVariantService`) mas não as TESTA com rigor. F6
 * generaliza o motor de experimento que já existe em prospecção (`ProspectResearchService`:
 * `twoProportionZ`, campeão/desafiante) sobre VARIANTES DE CONTEÚDO — mede a taxa de
 * ENGAJAMENTO de cada variante (`social_post_metrics` por `variant_key`) e declara o campeão.
 *
 * §37 — REUTILIZA `ProspectResearchService.twoProportionZ` (a estatística), NÃO cria 2º motor
 * de experimento. Espelha a decisão determinística (melhor × 2ª melhor, z ≥ confiança,
 * amostra mínima, campeão/desafiante).
 *
 * ATENÇÃO (RN-CG-01): o vencedor AQUI é por ENGAJAMENTO — um PROXY. O vencedor por RESULTADO
 * DE NEGÓCIO (lead/venda/receita/margem) é a F9 (Objective-aware Winner), que se sobrepõe a
 * este quando o desfecho de negócio existir. `ENGAGEMENT ≠ BUSINESS VALUE`.
 *
 * Guardrails:
 *  - RN-CG-07 — vencedor exige amostra mínima (`min_sample` impressões/variante); sem amostra
 *    → `insufficient_data` (nunca declara campeão no ruído).
 *  - RN-CG-08 — decidir NÃO executa: promover o campeão pra publicação é comando GOVERNADO
 *    (F16). Aqui só registra o vencedor.
 *  - convenção nº 1 — isolamento por org.
 */

export interface VariantMeasurement { variantKey: string; label: string | null; impressions: number; engagement: number; rate: number | null; isChampion: boolean }
export interface ExperimentDecision {
  experimentId: string; status: string; decision: string | null; winnerVariantKey: string | null;
  reason: string; z: number | null; metric: string; measurements: VariantMeasurement[];
  basis?: "business_outcome" | "engagement"; outcomes?: Array<{ variantKey: string; revenueFact: number; leads: number }>;
}

export class CreativeExperimentService {
  /** Cria um experimento com ≥2 variantes (hipótese pré-declarada). */
  static create(orgId: string, actor: string | null, input: {
    hypothesis: string; variants: { variantKey: string; label?: string | null; correlationId?: string | null }[];
    objectiveId?: string | null; correlationId?: string | null; minSample?: number; confidenceZ?: number;
  }): { id: string; variantKeys: string[] } {
    if (!orgId) throw new Error("orgId obrigatório");
    const hypothesis = String(input?.hypothesis || "").trim();
    if (!hypothesis) throw new Error("Informe a hipótese do experimento.");
    const variants = (input?.variants || []).filter((v) => v && String(v.variantKey || "").trim());
    if (variants.length < 2) throw new Error("Um experimento precisa de ao menos 2 variantes.");
    const minSample = Math.max(1, Number(input.minSample) || 100);
    const confidenceZ = Number(input.confidenceZ) > 0 ? Number(input.confidenceZ) : 1.96;

    const id = randomUUID();
    db.prepare(
      `INSERT INTO creative_experiments (id, organization_id, hypothesis, objective_id, correlation_id, metric, min_sample, confidence_z, created_by)
       VALUES (?, ?, ?, ?, ?, 'engagement', ?, ?, ?)`
    ).run(id, orgId, hypothesis, input.objectiveId || null, input.correlationId || null, minSample, confidenceZ, actor || null);
    // `correlation_id` por variante liga a variante às atribuições de negócio (F7/F8 → F9).
    const ins = db.prepare(`INSERT OR IGNORE INTO creative_experiment_variants (id, organization_id, experiment_id, variant_key, label, correlation_id) VALUES (?, ?, ?, ?, ?, ?)`);
    for (const v of variants) ins.run(randomUUID(), orgId, id, String(v.variantKey), v.label ? String(v.label) : null, v.correlationId ? String(v.correlationId) : null);
    return { id, variantKeys: variants.map((v) => String(v.variantKey)) };
  }

  /**
   * Resultado de NEGÓCIO por variante (F9): receita atribuída (fact) + leads, via o
   * `correlation_id` da variante (F7/F8). É o que distingue `ENGAGEMENT ≠ BUSINESS VALUE`.
   * Sem `correlation_id` (variante não publicada/atribuída) → tudo 0 (honesto).
   */
  static outcomeFor(orgId: string, experimentId: string): Array<{ variantKey: string; label: string | null; correlationId: string | null; revenueFact: number; revenueEstimate: number; leads: number }> {
    const vars = db.prepare(`SELECT variant_key, label, correlation_id FROM creative_experiment_variants WHERE organization_id = ? AND experiment_id = ? ORDER BY created_at ASC`).all(orgId, experimentId) as any[];
    return vars.map((v) => {
      let revenueFact = 0, revenueEstimate = 0, leads = 0;
      if (v.correlation_id) {
        const rev = db.prepare(
          "SELECT COALESCE(SUM(CASE WHEN revenue_basis='fact' THEN revenue ELSE 0 END),0) AS rf, COALESCE(SUM(CASE WHEN revenue_basis='estimate' THEN revenue ELSE 0 END),0) AS re FROM content_sale_attributions WHERE organization_id = ? AND correlation_id = ?"
        ).get(orgId, v.correlation_id) as any;
        revenueFact = Number(rev?.rf || 0); revenueEstimate = Number(rev?.re || 0);
        leads = Number((db.prepare("SELECT COUNT(*) AS n FROM content_lead_attributions WHERE organization_id = ? AND correlation_id = ?").get(orgId, v.correlation_id) as any)?.n || 0);
      }
      return { variantKey: v.variant_key, label: v.label ?? null, correlationId: v.correlation_id ?? null, revenueFact, revenueEstimate, leads };
    });
  }

  private static experiment(orgId: string, id: string): any {
    return db.prepare(`SELECT * FROM creative_experiments WHERE organization_id = ? AND id = ?`).get(orgId, id);
  }

  /** Mede a taxa de engajamento (engajamento/impressões) de cada variante — derivado por query. */
  static measure(orgId: string, experimentId: string): VariantMeasurement[] {
    const vars = db.prepare(`SELECT variant_key, label, is_champion FROM creative_experiment_variants WHERE organization_id = ? AND experiment_id = ? ORDER BY created_at ASC`).all(orgId, experimentId) as any[];
    return vars.map((v) => {
      const agg = db.prepare(
        `SELECT COALESCE(SUM(impressions),0) AS impressions,
                COALESCE(SUM(COALESCE(likes,0)+COALESCE(comments,0)+COALESCE(shares,0)+COALESCE(saves,0)),0) AS engagement
         FROM social_post_metrics WHERE organization_id = ? AND variant_key = ?`
      ).get(orgId, v.variant_key) as any;
      const impressions = Number(agg?.impressions || 0);
      const engagement = Number(agg?.engagement || 0);
      // RN-CG-12 honesto: sem impressões não há taxa (null, nunca 0 forçado).
      const rate = impressions > 0 ? engagement / impressions : null;
      return { variantKey: v.variant_key, label: v.label ?? null, impressions, engagement, rate, isChampion: !!v.is_champion };
    });
  }

  /**
   * Decide o experimento (determinístico). Melhor × 2ª melhor por taxa; z de duas proporções
   * (REUSA `ProspectResearchService.twoProportionZ`); exige amostra mínima; só declara campeão
   * com z ≥ confiança. NÃO executa (RN-CG-08) — só registra o vencedor e marca o champion.
   */
  static decide(orgId: string, experimentId: string, actor?: string | null): ExperimentDecision {
    const e = this.experiment(orgId, experimentId);
    if (!e) throw new Error("Experimento não encontrado.");
    const measurements = this.measure(orgId, experimentId);
    const outcomes = this.outcomeFor(orgId, experimentId);
    // RN-CG-01 — quando HÁ resultado de negócio atribuído (F7/F8), ele DECIDE, sobrepondo o
    // engajamento. Engajamento só decide quando ainda não há desfecho de negócio (proxy).
    const hasBusiness = outcomes.some((o) => o.revenueFact > 0 || o.leads > 0);

    let decision = "insufficient_data"; let reason: string; let z: number | null = null; let winnerKey: string | null = null;
    let basis: "business_outcome" | "engagement" = "engagement";

    if (hasBusiness) {
      basis = "business_outcome";
      // Ranqueia por (receita fact desc, leads desc) — dinheiro provado antes de lead.
      const ranked = [...outcomes].sort((a, b) => (b.revenueFact - a.revenueFact) || (b.leads - a.leads));
      const bo = ranked[0]; const so = ranked[1];
      const strictlyBetter = so ? (bo.revenueFact > so.revenueFact || (bo.revenueFact === so.revenueFact && bo.leads > so.leads)) : true;
      if (strictlyBetter && (bo.revenueFact > 0 || bo.leads > 0)) {
        decision = "winner"; winnerKey = bo.variantKey;
        const metricTxt = bo.revenueFact > 0 ? `R$ ${bo.revenueFact.toFixed(2)} de receita atribuída` : `${bo.leads} lead(s)`;
        reason = `"${bo.label || bo.variantKey}" venceu por RESULTADO DE NEGÓCIO (${metricTxt}) — sobrepõe o engajamento (RN-CG-01: ENGAGEMENT ≠ BUSINESS VALUE).`;
      } else {
        decision = "inconclusive";
        reason = "Empate no resultado de negócio entre as variantes — inconclusivo (não decide no ruído).";
      }
    } else {
      // Sem desfecho de negócio ainda → decide por ENGAJAMENTO (PROXY), como na F6.
      const withRate = measurements.filter((m) => m.rate !== null) as (VariantMeasurement & { rate: number })[];
      const sorted = [...withRate].sort((a, b) => b.rate - a.rate);
      const best = sorted[0]; const second = sorted[1];
      const enough = !!best && !!second && best.impressions >= e.min_sample && second.impressions >= e.min_sample;
      if (!enough) {
        reason = `Amostra insuficiente (mínimo ${e.min_sample} impressões por variante) — inconclusivo por padrão.`;
      } else {
        z = ProspectResearchService.twoProportionZ(best.engagement, best.impressions, second.engagement, second.impressions);
        if (Math.abs(z) >= Number(e.confidence_z)) {
          decision = "winner"; winnerKey = best.variantKey;
          reason = `"${best.label || best.variantKey}" venceu por engajamento (${(best.rate * 100).toFixed(1)}% vs ${(second.rate * 100).toFixed(1)}%, z=${z.toFixed(2)} ≥ ${e.confidence_z}). Engajamento é PROXY — o resultado de negócio (F7/F8) sobrepõe quando existir.`;
        } else {
          decision = "inconclusive";
          reason = `Diferença não é estatisticamente significativa (z=${z.toFixed(2)} < ${e.confidence_z}) — inconclusivo. Estenda a amostra.`;
        }
      }
    }

    // Persiste a decisão. Só 'winner'/'inconclusive' fecham o experimento; 'insufficient_data'
    // mantém 'running' (pode decidir de novo quando a amostra crescer).
    const newStatus = decision === "insufficient_data" ? "running" : "completed";
    db.prepare(
      `UPDATE creative_experiments SET decision = ?, winner_variant_key = ?, decision_reason = ?, status = ?,
        completed_at = CASE WHEN ? = 'completed' THEN CURRENT_TIMESTAMP ELSE completed_at END
       WHERE organization_id = ? AND id = ?`
    ).run(decision, winnerKey, reason, newStatus, newStatus, orgId, experimentId);

    // Campeão/desafiante: vencedora vira champion; as outras perdem o posto (RN-CG-08 — só
    // marca; NÃO publica). Não executa nada.
    if (winnerKey) {
      db.prepare(`UPDATE creative_experiment_variants SET is_champion = 0 WHERE organization_id = ? AND experiment_id = ?`).run(orgId, experimentId);
      db.prepare(`UPDATE creative_experiment_variants SET is_champion = 1 WHERE organization_id = ? AND experiment_id = ? AND variant_key = ?`).run(orgId, experimentId, winnerKey);
    }
    try { logAuthEvent(orgId, actor || null, null, "CREATIVE_EXPERIMENT_DECISION", { experimentId, decision, winnerVariantKey: winnerKey, basis, z: z != null ? Number(z.toFixed(3)) : null }); } catch { /* audit best-effort */ }

    return { experimentId, status: newStatus, decision, winnerVariantKey: winnerKey, reason, z, metric: e.metric, measurements, basis, outcomes: outcomes.map((o) => ({ variantKey: o.variantKey, revenueFact: o.revenueFact, leads: o.leads })) };
  }

  static get(orgId: string, id: string): any | null {
    const e = this.experiment(orgId, id);
    if (!e) return null;
    return {
      id: e.id, hypothesis: e.hypothesis, objectiveId: e.objective_id ?? null, correlationId: e.correlation_id ?? null,
      metric: e.metric, minSample: e.min_sample, confidenceZ: e.confidence_z, status: e.status,
      decision: e.decision ?? null, winnerVariantKey: e.winner_variant_key ?? null, decisionReason: e.decision_reason ?? null,
      createdAt: e.created_at, completedAt: e.completed_at ?? null,
      variants: db.prepare(`SELECT variant_key AS variantKey, label, is_champion AS isChampion FROM creative_experiment_variants WHERE organization_id = ? AND experiment_id = ? ORDER BY created_at ASC`).all(orgId, id),
    };
  }

  static list(orgId: string, opts?: { status?: string }): any[] {
    const rows = opts?.status
      ? db.prepare(`SELECT id, hypothesis, status, decision, winner_variant_key, created_at FROM creative_experiments WHERE organization_id = ? AND status = ? ORDER BY created_at DESC`).all(orgId, opts.status)
      : db.prepare(`SELECT id, hypothesis, status, decision, winner_variant_key, created_at FROM creative_experiments WHERE organization_id = ? ORDER BY created_at DESC`).all(orgId);
    return rows as any[];
  }
}

export default CreativeExperimentService;
