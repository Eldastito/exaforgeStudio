import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ProductionService } from "./ProductionService.js";

/**
 * ProductionSignalPublisher (Supervisor de Produção IA — fatia 4, ADR-141).
 *
 * Fecha o loop da Produção com o resto do sistema: deriva SINAIS tipados das
 * ordens abertas — `production.order.late` (atraso), `production.material.shortage`
 * (falta de material p/ o saldo pendente) e `production.scrap.above_target`
 * (refugo acima da meta) — e publica no `business_signals` (ADR-136 C1), de onde
 * já fluem para o Pareto e o briefing do gestor. DETERMINÍSTICO, idempotente por
 * `tipo:ordem:dia` (rodar 2× no mesmo dia não duplica). Sob demanda. Isolado por
 * organization_id. Não executa nada — só sinaliza.
 */

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const today = () => new Date().toISOString().slice(0, 10);

export class ProductionSignalPublisher {
  /** Deriva e publica os sinais de produção. `scrapTargetPct` default 10%. */
  static run(orgId: string, opts: { asOfDate?: string; scrapTargetPct?: number } = {}): { late: number; shortage: number; scrap: number; published: number } {
    const asOf = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.asOfDate || "")) ? opts.asOfDate! : today();
    const scrapTarget = opts.scrapTargetPct != null ? Number(opts.scrapTargetPct) : 0.1;
    const orders = db.prepare("SELECT * FROM production_orders WHERE organization_id = ? AND status IN ('released','in_progress')").all(orgId) as any[];

    let late = 0, shortage = 0, scrap = 0;
    const pub = (s: any) => { try { BusinessSignalService.publish(orgId, { domain: "production", basis: "fact", confidence: 1, sourceService: "ProductionSignalPublisher", sourceEntityType: "production_order", ...s }); return true; } catch { return false; } };

    for (const o of orders) {
      const pending = round2(Math.max(0, o.qty_planned - o.qty_produced));
      const productName = (db.prepare("SELECT name FROM manufactured_products WHERE id = ? AND organization_id = ?").get(o.manufactured_product_id, orgId) as any)?.name || "produto";

      // 1) Atraso: prometida < hoje e ordem ainda aberta.
      if (o.promised_date && o.promised_date < asOf) {
        if (pub({ signalType: "production_order_late", severity: "risk", impactAmount: pending, impactUnit: "units", sourceEntityId: o.id, evidence: { product: productName, promisedDate: o.promised_date, pending }, dedupeKey: `production:order_late:${o.id}:${asOf}` })) late++;
      }

      // 2) Falta de material p/ o saldo pendente (reusa a necessidade da BOM).
      if (o.bom_id && pending > 0) {
        const req = ProductionService.materialRequirements(orgId, o.bom_id, pending);
        if (req?.hasShortage) {
          const totalShort = round2(req.items.reduce((s: number, i: any) => s + (i.shortage || 0), 0));
          if (pub({ signalType: "production_material_shortage", severity: "risk", impactAmount: totalShort, impactUnit: "units", sourceEntityId: o.id, evidence: { product: productName, pending, shortages: req.items.filter((i: any) => i.shortage > 0).map((i: any) => ({ material: i.materialName, shortage: i.shortage })) }, dedupeKey: `production:material_shortage:${o.id}:${asOf}` })) shortage++;
        }
      }

      // 3) Refugo acima da meta.
      const totalUnits = round2(o.qty_produced + o.qty_scrapped);
      if (totalUnits > 0) {
        const rate = o.qty_scrapped / totalUnits;
        if (rate > scrapTarget) {
          if (pub({ signalType: "production_scrap_above_target", severity: "attention", basis: "fact", impactAmount: round2(o.qty_scrapped), impactUnit: "units", sourceEntityId: o.id, evidence: { product: productName, scrapped: o.qty_scrapped, produced: o.qty_produced, ratePct: round2(rate * 100), targetPct: round2(scrapTarget * 100) }, dedupeKey: `production:scrap:${o.id}:${asOf}` })) scrap++;
        }
      }
    }

    return { late, shortage, scrap, published: late + shortage + scrap };
  }
}

export default ProductionSignalPublisher;
