import { FinanceSnapshotAdapter } from "./FinanceSnapshotAdapter.js";
import { BusinessHealthService } from "./BusinessHealthService.js";
import { SalesSnapshotAdapter, InventorySnapshotAdapter, ProcurementSnapshotAdapter, RetailOpsSnapshotAdapter, TaskSnapshotAdapter } from "./BusinessSnapshotAdapters.js";

/**
 * Business Snapshot V2 (ADR-135, Enterprise Intelligence Kernel — Epic 1).
 *
 * Consolida o panorama por DOMÍNIO em JSON estruturado, reusando os motores
 * determinísticos existentes via adapters. Cada adapter falha isolado — um
 * domínio indisponível não derruba o snapshot. A camada de IA (Diretor) apenas
 * NARRA este JSON; nunca calcula nem inventa. Aditivo: NÃO substitui
 * BusinessContextService.build(). Fase B1 entrega o domínio `finance`; os demais
 * adapters entram nas fatias seguintes.
 */

const safe = <T>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

export class BusinessSnapshotV2Service {
  static build(orgId: string, period?: string): any {
    const p = period || new Date().toISOString().slice(0, 7);
    return {
      organization: { id: orgId },
      period: { month: p },
      dataQuality: safe(() => BusinessHealthService.dataQuality(orgId), null),
      domains: {
        finance: FinanceSnapshotAdapter.build(orgId, p),
        sales: SalesSnapshotAdapter.build(orgId, p),
        inventory: InventorySnapshotAdapter.build(orgId),
        procurement: ProcurementSnapshotAdapter.build(orgId),
        retail_ops: RetailOpsSnapshotAdapter.build(orgId),
        tasks: TaskSnapshotAdapter.build(orgId),
      },
      topPriorities: safe(() => (BusinessHealthService.overview(orgId) as any).priorities || [], []),
    };
  }
}

export default BusinessSnapshotV2Service;
