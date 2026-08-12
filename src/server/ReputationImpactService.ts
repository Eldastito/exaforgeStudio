/**
 * ReputationImpactService (ADR-162 / PRD 5 §51-§55, F13) — o IMPACTO do módulo, fechando
 * o loop com os KPIs certos. Reusa/estende o Impact Ledger unificado (D6) — sem tabela nova:
 *
 *   - KPI CENTRAL É PROBLEMA RESOLVIDO (§55), não "respostas enviadas": `kpi()` deriva por
 *     query quantos casos de reputação foram RESOLVIDOS (F10) vs abertos → taxa de
 *     recuperação. O que a recuperação PROTEGEU em R$ vem do `OutcomeMeasurementService`
 *     (domínio `recovery`), SEPARADO por categoria (revenueRecovered/lossPrevented/
 *     costAvoided) e por base (fact/estimate/INFLUENCED) — NUNCA somados entre si (§52/§54).
 *   - `recordRecoveryValue()` registra o valor recuperado ATRIBUÍDO a uma ação de recovery
 *     como `basis='influenced'` (D6 — a ação contribuiu, não é a causa única) via
 *     `measurement_method='attributed'`. §52: dinheiro protegido SÓ com valor REAL +
 *     evidência + janela de atribuição — nunca inventa (RN-CRR-7).
 *
 * Determinístico, isolado por org (RN-CRR-9). Não age; só mede o que já aconteceu.
 */
import db from "./db.js";
import { OutcomeMeasurementService } from "./OutcomeMeasurementService.js";

const CATEGORIES = new Set(["revenueRecovered", "lossPrevented", "costAvoided"]);
const CATEGORY_FIELD: Record<string, "revenueRecovered" | "lossPrevented" | "costAvoided"> = {
  revenueRecovered: "revenueRecovered", lossPrevented: "lossPrevented", costAvoided: "costAvoided",
};
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

export interface ReputationImpactKpi {
  windowDays: number | null;
  northStar: "problems_resolved";
  problemsResolved: number;
  openProblems: number;
  totalProblems: number;
  recoveryRatePct: number | null;
  value: {
    // NUNCA somados entre si (§54): três bases distintas de credibilidade.
    byBasis: { fact: { realized: number }; estimate: { realized: number }; influenced: { realized: number } };
    // NUNCA somadas entre si (§52): cada categoria na sua interpretação.
    categories: { revenueRecovered: number; costAvoided: number; lossPrevented: number };
  };
  note: string;
}

export class ReputationImpactService {
  /** Filtro de janela opcional sobre detected_at (default all-time). */
  private static windowClause(windowDays?: number | null, now?: number): { clause: string; params: any[] } {
    if (!windowDays || windowDays <= 0) return { clause: "", params: [] };
    const from = new Date((now || Date.now()) - windowDays * 86400e3).toISOString();
    return { clause: " AND datetime(detected_at) >= datetime(?)", params: [from] };
  }

  /**
   * KPI da recuperação (§55). Problema RESOLVIDO é o número que importa; o valor
   * protegido é separado por categoria e por base. Derivado por query (RN-004).
   */
  static kpi(orgId: string, opts: { windowDays?: number | null; now?: number } = {}): ReputationImpactKpi {
    const w = this.windowClause(opts.windowDays, opts.now);
    const countBy = (status: string | null) => {
      let sql = `SELECT COUNT(*) n FROM business_signals WHERE organization_id = ? AND domain = 'reputation' AND signal_type = 'public_complaint'${w.clause}`;
      const params: any[] = [orgId, ...w.params];
      if (status) { sql += " AND status = ?"; params.push(status); }
      return (db.prepare(sql).get(...params) as any).n as number;
    };
    const total = countBy(null);
    const resolved = countBy("resolved");
    const open = countBy("open");
    const recoveryRatePct = total > 0 ? round2((resolved / total) * 100) : null;

    // Valor protegido: outcomes das ações de recovery, SEM somar entre bases/categorias.
    const t = OutcomeMeasurementService.ledger(orgId, { domain: "recovery" }).totals;

    return {
      windowDays: opts.windowDays ?? null,
      northStar: "problems_resolved",
      problemsResolved: resolved,
      openProblems: open,
      totalProblems: total,
      recoveryRatePct,
      value: {
        byBasis: {
          fact: { realized: t.fact.realized },
          estimate: { realized: t.estimate.realized },
          influenced: { realized: t.influenced.realized },
        },
        categories: {
          revenueRecovered: t.categories.revenueRecovered,
          costAvoided: t.categories.costAvoided,
          lossPrevented: t.categories.lossPrevented,
        },
      },
      note: "KPI central = problemas RESOLVIDOS (§55), não respostas enviadas. Valor protegido nunca somado entre categorias (§52) nem entre fact/estimate/INFLUENCED (§54).",
    };
  }

  /**
   * Registra o valor recuperado ATRIBUÍDO a uma ação de recovery (§51-54). `basis`
   * default `influenced` (D6). §52/RN-CRR-7: exige valor REAL + evidência — nunca
   * inventa dinheiro protegido. A ação precisa existir na org e ser do domínio recovery.
   */
  static recordRecoveryValue(orgId: string, actionId: string, input: {
    realizedValue: number; category: string; evidence: any;
    basis?: "fact" | "estimate" | "influenced"; attributionWindowDays?: number | null;
  }): any {
    const action = db.prepare(`SELECT id, domain FROM decision_actions WHERE id = ? AND organization_id = ?`).get(actionId, orgId) as any;
    if (!action) throw new Error("Ação não encontrada.");
    if (action.domain !== "recovery") throw new Error("Valor de recuperação só se atribui a ação de recovery.");
    if (input?.realizedValue == null || !Number.isFinite(Number(input.realizedValue))) throw new Error("realizedValue obrigatório (§52 — não inventa dinheiro).");
    if (input?.evidence == null) throw new Error("evidence obrigatória (§52 — valor só com lastro).");
    if (!CATEGORIES.has(String(input?.category))) throw new Error("category deve ser revenueRecovered|lossPrevented|costAvoided.");

    const basis = input.basis === "fact" || input.basis === "estimate" ? input.basis : "influenced";
    const field = CATEGORY_FIELD[String(input.category)];
    return OutcomeMeasurementService.record(orgId, actionId, {
      realizedValue: Number(input.realizedValue),
      basis,
      measurementMethod: "attributed",
      attributionWindowDays: input.attributionWindowDays ?? null,
      evidence: { ...input.evidence, category: input.category, attributedBy: "reputation_recovery" },
      [field]: Number(input.realizedValue),
    });
  }
}

export default ReputationImpactService;
