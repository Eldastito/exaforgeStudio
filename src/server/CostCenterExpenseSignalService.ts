/**
 * CostCenterExpenseSignalService — ADR-185 F3: sinal ADVISORY de despesa NÃO apropriada.
 *
 * Quando a org usa centros de custo mas a MAIOR PARTE da despesa do mês ainda não tem centro
 * (`unallocated`), publica um `business_signal` pro operador APROPRIAR — nunca apropria sozinho
 * (RN-CC-1, tag é sempre explícita). Hipótese (não prova de erro): `basis:'hypothesis'`,
 * `impactAmount:null` (não inventa dinheiro). Self-healing: fração cai → `resolveByDedupe`; recorre
 * → `reopenByDedupe` (respeita o `dismissed` humano §65). Dedupe por período. Best-effort.
 * Espelha `PnlReconciliationService.publishOverlapSignal`.
 */
import db from "./db.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

// Só nudge quando a MAIORIA da despesa está solta E o valor solto é material (evita ruído em
// centavos). Limiares conservadores — o objetivo é lembrar de apropriar, não incomodar.
const UNALLOCATED_FRACTION_THRESHOLD = 0.5;
const UNALLOCATED_FLOOR = 100; // R$

export class CostCenterExpenseSignalService {
  static publishUnallocatedExpenseSignal(orgId: string, period: string): { published: boolean; resolved: boolean } {
    const dedupeKey = `cc_unallocated:${period}`;
    let published = false, resolved = false;
    try {
      // Só faz sentido pra quem OPTOU pela dimensão (tem centro ativo).
      const hasCenter = !!db.prepare("SELECT 1 FROM cost_centers WHERE organization_id = ? AND active = 1 LIMIT 1").get(orgId);
      const rep = FinancialLedgerService.expensesByCostCenter(orgId, { from: `${period}-01`, to: `${period}-31` });
      const fraction = rep.total > 0 ? rep.unallocated / rep.total : 0;
      const trigger = hasCenter && rep.unallocated >= UNALLOCATED_FLOOR && fraction > UNALLOCATED_FRACTION_THRESHOLD;
      if (trigger) {
        BusinessSignalService.publish(orgId, {
          domain: "cost_center",
          signalType: "unallocated_expense",
          severity: "attention",
          basis: "hypothesis",
          confidence: 0.5,
          impactAmount: null,            // nunca inventa dinheiro
          sourceService: "CostCenterExpenseSignalService",
          evidence: {
            period, unallocated: rep.unallocated, total: rep.total,
            fractionPct: Math.round(fraction * 100),
            message: "A maior parte da sua despesa do mês ainda não está apropriada a um centro de custo. Aproprie as contas em Controladoria para ver quanto cada centro custou.",
          },
          dedupeKey,
        });
        try { BusinessSignalService.reopenByDedupe(orgId, dedupeKey); } catch { /* noop */ }
        published = true;
      } else {
        try { const rr = BusinessSignalService.resolveByDedupe(orgId, dedupeKey); resolved = !!rr?.ok; } catch { /* noop */ }
      }
    } catch { /* best-effort */ }
    return { published, resolved };
  }

  /** Passe do Scheduler: só orgs com centro de custo ativo (quem optou pela dimensão). */
  static pass(): void {
    let orgs: any[] = [];
    const period = new Date().toISOString().slice(0, 7);
    try { orgs = db.prepare(`SELECT DISTINCT organization_id FROM cost_centers WHERE active = 1`).all() as any[]; }
    catch { return; }
    for (const o of orgs) {
      try { this.publishUnallocatedExpenseSignal(o.organization_id, period); }
      catch (e) { console.error("[CentroDeCusto] unallocated pass falhou", o.organization_id, e); }
    }
  }
}

export default CostCenterExpenseSignalService;
