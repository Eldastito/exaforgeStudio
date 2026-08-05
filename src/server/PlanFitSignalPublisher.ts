/**
 * PlanFitSignalPublisher (ADR-153 F7.1) — publish + sweep pra sinais `domain='plan'`.
 *
 * Pattern: mesmo do `ClinicRenewalTaskService.run` (F136) — publica os
 * candidatos do `PlanFitDetectorService`, rastreia dedupe_keys válidas, e
 * fecha (resolveByDedupe) sinais abertos que não estão mais no set válido
 * (uso caiu abaixo do threshold — dono deixou de precisar do upgrade).
 *
 * Idempotente: rodar 2× no mesmo dia atualiza a evidência mas não duplica
 * sinal (BusinessSignalService.publish dedup por (org, dedupe_key)).
 *
 * NÃO cria DecisionAction, NÃO manda mensagem, NÃO propõe upgrade sozinho.
 * Só sinal — dono decide via UI (F4.2 lista o placeholder; F7.4 vai popular).
 * G-153-3 preservada.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { PlanFitDetectorService } from "./PlanFitDetectorService.js";

export class PlanFitSignalPublisher {
  /**
   * Executa uma varredura na org. Retorna resumo (published + deduped + resolved).
   * Isolado por org — todo query filtra organization_id.
   */
  static run(orgId: string): {
    seen: number;
    published: number;
    deduped: number;
    resolved: number;
  } {
    const candidates = PlanFitDetectorService.detect(orgId);

    // Dedupe keys válidas pós-rodada — sinais abertos com key fora daqui
    // são "stale" e viram resolved (dono passou pelo pico e voltou ao normal).
    const validKeys = new Set<string>();

    let published = 0;
    let deduped = 0;

    for (const c of candidates) {
      validKeys.add(c.dedupeKey);
      const res = BusinessSignalService.publish(orgId, {
        domain: "plan",
        signalType: c.signalType,
        severity: c.severity,
        basis: "fact",
        confidence: 1,
        // F7.2 — uplift em BRL/mês (payback conservador 3× diff de preço).
        impactAmount: c.impactAmount,
        impactUnit: c.impactUnit,
        sourceService: "PlanFitSignalPublisher",
        sourceEntityType: "org_plan",
        sourceEntityId: c.planId,
        evidence: c.evidence,
        premises: {
          detector: "PlanFitDetectorService",
          rule: c.signalType === "plan_module_gap"
            ? `module_gap:${c.evidence.moduleKey} → ${c.severity} (score=${c.score})`
            : `pct=${c.evidence.pctInt} → ${c.severity} (score=${c.score})`,
          upgradePath: c.evidence.upgradeTargetPlan,
          // F7.2 — score threshold aplicado no detector; qualquer sinal
          // publicado tem score ≥ 60 (PRD §14).
          scoreThreshold: 60,
          scoreTotal: c.score,
        },
        dedupeKey: c.dedupeKey,
      });
      if (res.deduped) deduped++;
      else published++;
    }

    // Fecha sinais que existiam antes e não estão mais válidos.
    // F7.2: inclui `plan_module_gap` na família de resolve.
    const open = db.prepare(
      `SELECT dedupe_key FROM business_signals
        WHERE organization_id = ? AND domain = 'plan' AND status = 'open'
          AND signal_type IN ('plan_near_limit_ai','plan_near_limit_contacts','plan_near_limit_channels','plan_near_limit_users','plan_module_gap')`,
    ).all(orgId) as any[];

    let resolved = 0;
    for (const row of open) {
      if (!validKeys.has(row.dedupe_key)) {
        const r = BusinessSignalService.resolveByDedupe(orgId, row.dedupe_key);
        if (r.ok) resolved++;
      }
    }

    return { seen: candidates.length, published, deduped, resolved };
  }

  /**
   * Sweep de todas as orgs elegíveis. Best-effort — erro em uma org não trava
   * as outras. Chamado por `Scheduler.planFitPass()`.
   */
  static runAll(): { orgsSeen: number; totalPublished: number; totalResolved: number } {
    const orgs = db.prepare(
      `SELECT organization_id FROM organization_settings
        WHERE deleted_at IS NULL AND plan_id IS NOT NULL AND plan_id != 'cortesia'
          AND COALESCE(billing_status, 'active') NOT IN ('blocked', 'cancelled', 'past_due')`,
    ).all() as any[];

    let totalPublished = 0;
    let totalResolved = 0;
    for (const o of orgs) {
      try {
        const r = this.run(o.organization_id);
        totalPublished += r.published;
        totalResolved += r.resolved;
      } catch (e) {
        console.error("[PlanFitSignalPublisher] runAll: erro na org", o.organization_id, e);
      }
    }
    return { orgsSeen: orgs.length, totalPublished, totalResolved };
  }
}
