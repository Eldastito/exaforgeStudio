import db from "./db.js";
import { GrimoireService } from "./GrimoireService.js";
import { CollectionAbMeasurementService } from "./CollectionAbMeasurementService.js";

/**
 * GrimoirePostmortemService — o canal de pós-mortem do grimoire (ADR-155 F1.4,
 * fecha a Fase 1). Lê o resultado do A/B da copy (F2.3) e, quando a variante
 * `calibrated` está PERDENDO pra `control` (com amostra suficiente), grava uma
 * `Lição` datada na rubrica `dunning-cadence` — que o `GrimoireService` passa a
 * injetar no prompt (bloco <licoes>). Quando a calibrada volta a empatar/ganhar,
 * a lição é aposentada. É o "o erro de ontem vira regra de amanhã" do padrão 4.
 *
 * Roda no `Scheduler.collectionCadencePass` logo após a medição F2.3.
 */

const RUBRIC = "dunning-cadence";
const DEDUPE = "ab:dunning-cadence:calibrated-underperform";

export class GrimoirePostmortemService {
  /**
   * Avalia o A/B de uma org e grava/aposenta a lição. Só age com amostra
   * suficiente em AMBAS as variantes (o `winner` do measure já exige isso).
   */
  static async runCollectionAb(orgId: string): Promise<{ recorded: boolean; retired: boolean }> {
    const m = CollectionAbMeasurementService.measure(orgId);
    const c = m.variants.find((v) => v.variant === "control");
    const cal = m.variants.find((v) => v.variant === "calibrated");
    if (!c || !cal || c.sent < m.minSample || cal.sent < m.minSample) return { recorded: false, retired: false };

    if (cal.recoveryRatePct < c.recoveryRatePct) {
      await GrimoireService.recordLesson(orgId, RUBRIC, {
        lesson: `A/B: a copy calibrada recuperou ${cal.recoveryRatePct}% (${cal.recovered}/${cal.sent}) contra ${c.recoveryRatePct}% (${c.recovered}/${c.sent}) do control — a calibração de dunning está pior que o baseline. Revisar antes de ampliar o rollout.`,
        source: "collection_ab_result",
        dedupeKey: DEDUPE,
        evidence: { control: c, calibrated: cal },
      });
      return { recorded: true, retired: false };
    }
    // calibrada empatou/ganhou → a lição (se existia) não vale mais.
    await GrimoireService.retireLesson(orgId, RUBRIC, DEDUPE);
    return { recorded: false, retired: true };
  }

  /** Roda o pós-mortem pra todas as orgs com follow-ups de cobrança. Best-effort. */
  static async runAll(): Promise<{ orgs: number; recorded: number; retired: number }> {
    const orgs = db.prepare(`SELECT DISTINCT organization_id AS orgId FROM collection_followup_attempts`).all() as any[];
    let recorded = 0, retired = 0;
    for (const o of orgs) {
      try {
        const r = await this.runCollectionAb(String(o.orgId));
        if (r.recorded) recorded++;
        if (r.retired) retired++;
      } catch (e) { console.error("[Grimoire F1.4] pós-mortem falhou pra org", o.orgId, e); }
    }
    return { orgs: orgs.length, recorded, retired };
  }
}

export default GrimoirePostmortemService;
