import db from "./db.js";
import { LossMarginService } from "./LossMarginService.js";
import { AnalyticsService } from "./AnalyticsService.js";
import { QuoteService } from "./QuoteService.js";
import { RevenueIntelligenceService } from "./RevenueIntelligenceService.js";
import { RetailImpactService } from "./RetailImpactService.js";
import { TaskService } from "./TaskService.js";

/**
 * Adapters de domínio do Business Snapshot V2 (ADR-135, Epic 1 — Fatia B2).
 * READ-ONLY, reusam serviços/queries existentes, falham isolados (erro → um
 * domínio devolve `{ available:false }` sem derrubar o snapshot). Cada métrica
 * carrega `source`/`basis`. Determinístico, isolado por organization_id.
 */

const round2 = (n: any) => Math.round((Number(n) || 0) * 100) / 100;
const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };
const countSafe = (sql: string, orgId: string): number => { try { return Number((db.prepare(sql).get(orgId) as any)?.c) || 0; } catch { return 0; } };
const fail = (source: string, e: any) => ({ available: false, source, error: String(e?.message || e) });

export class SalesSnapshotAdapter {
  static build(orgId: string, period = new Date().toISOString().slice(0, 7)): any {
    try {
      const revenue = safe(() => LossMarginService.monthlyRevenue(orgId, period), 0);
      const prof = safe(() => AnalyticsService.getProfit(orgId, { period: "month" } as any) as any, null);
      const conv = safe(() => QuoteService.conversionStats(orgId) as any, null);
      const rie = safe(() => RevenueIntelligenceService.getSnapshot(orgId) as any, null);
      const lossSources = Array.isArray(rie?.lossSources) ? rie.lossSources : [];
      const perdaTotal = round2(lossSources.reduce((a: number, s: any) => a + (Number(s?.amount) || 0), 0));
      return {
        available: true, source: "SalesSnapshotAdapter", period,
        receitaMes: { value: round2(revenue), basis: "fact", source: "LossMarginService" },
        margemPct: prof?.hasCostData ? { value: prof.margin, basis: "estimate", source: "AnalyticsService" } : null,
        conversaoOrcamentos: conv?.ratePct != null ? { ratePct: conv.ratePct, prevRatePct: conv.prevRatePct, signal: conv.signal, basis: "fact", source: "QuoteService" } : null,
        perdaEstimada: lossSources.length ? { total: perdaTotal, fontes: lossSources.length, basis: "estimate", source: "RevenueIntelligenceService" } : null,
      };
    } catch (e) { return fail("SalesSnapshotAdapter", e); }
  }
}

export class InventorySnapshotAdapter {
  static build(orgId: string): any {
    try {
      const sc = safe(() => RetailImpactService.stockCapital(orgId) as any, null);
      const estoqueBaixo = countSafe("SELECT COUNT(*) c FROM inventory_items WHERE organization_id = ? AND quantity_available > 0 AND low_stock_threshold > 0 AND quantity_available <= low_stock_threshold", orgId);
      const rupturas = countSafe("SELECT COUNT(*) c FROM inventory_items WHERE organization_id = ? AND quantity_available <= 0", orgId);
      return {
        available: true, source: "InventorySnapshotAdapter",
        capitalTotal: { value: Number(sc?.totalCapital) || 0, basis: "fact", source: "RetailImpactService" },
        semGiro: { value: Number(sc?.slowMoverCapital) || 0, itens: Number(sc?.slowMoverCount) || 0, basis: "fact", source: "RetailImpactService" },
        estoqueBaixo: { itens: estoqueBaixo, basis: "fact" },
        rupturas: { itens: rupturas, basis: "fact" },
      };
    } catch (e) { return fail("InventorySnapshotAdapter", e); }
  }
}

export class ProcurementSnapshotAdapter {
  static build(orgId: string): any {
    try {
      return {
        available: true, source: "ProcurementSnapshotAdapter",
        requisicoesAbertas: { value: countSafe("SELECT COUNT(*) c FROM purchase_requisitions WHERE organization_id = ? AND status IN ('draft','approved')", orgId), basis: "fact" },
        cotacoesAguardando: { value: countSafe("SELECT COUNT(*) c FROM purchase_quotes WHERE organization_id = ? AND status = 'sent'", orgId), basis: "fact" },
        cotacoesRespondidas: { value: countSafe("SELECT COUNT(*) c FROM purchase_quotes WHERE organization_id = ? AND status = 'answered'", orgId), basis: "fact" },
      };
    } catch (e) { return fail("ProcurementSnapshotAdapter", e); }
  }
}

export class RetailOpsSnapshotAdapter {
  static build(orgId: string): any {
    try {
      return {
        available: true, source: "RetailOpsSnapshotAdapter",
        fechamentosPendentes: { value: countSafe("SELECT COUNT(*) c FROM retail_daily_closings WHERE organization_id = ? AND status IN ('pending','needs_review')", orgId), basis: "fact" },
        divergencias: { value: countSafe("SELECT COUNT(*) c FROM retail_daily_closings WHERE organization_id = ? AND divergence_status = 'divergent'", orgId), basis: "fact" },
      };
    } catch (e) { return fail("RetailOpsSnapshotAdapter", e); }
  }
}

export class TaskSnapshotAdapter {
  static build(orgId: string): any {
    try {
      const s = safe(() => TaskService.summary(orgId), { a_fazer: 0, fazendo: 0, feito: 0 } as any);
      return {
        available: true, source: "TaskSnapshotAdapter",
        aFazer: s.a_fazer, fazendo: s.fazendo, feito: s.feito,
        vencidas: { value: countSafe("SELECT COUNT(*) c FROM tasks WHERE organization_id = ? AND status IN ('a_fazer','fazendo') AND due_at IS NOT NULL AND due_at < datetime('now')", orgId), basis: "fact" },
        semResponsavel: { value: countSafe("SELECT COUNT(*) c FROM tasks WHERE organization_id = ? AND status IN ('a_fazer','fazendo') AND (assigned_to IS NULL OR assigned_to = '')", orgId), basis: "fact" },
      };
    } catch (e) { return fail("TaskSnapshotAdapter", e); }
  }
}
