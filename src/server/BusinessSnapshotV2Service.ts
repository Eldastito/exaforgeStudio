import { FinanceSnapshotAdapter } from "./FinanceSnapshotAdapter.js";
import { BusinessHealthService } from "./BusinessHealthService.js";
import { SalesSnapshotAdapter, InventorySnapshotAdapter, ProcurementSnapshotAdapter, RetailOpsSnapshotAdapter, TaskSnapshotAdapter } from "./BusinessSnapshotAdapters.js";
// ADR-160 F2 — ciclo com EvidencePackageService (que importa este service). Só é
// acessado em tempo de CHAMADA (dentro de `read`), nunca no load — o binding vivo
// do ESM já está populado quando `read` roda, então o ciclo é seguro.
import { EvidencePackageService } from "./EvidencePackageService.js";

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

  /**
   * ADR-160 F2 (Onda A / D2) — LEITURA DEFAULT do snapshot. `build()` recomputa
   * stateless a cada chamada (custo/latência §4.4). `read()` é o caminho que os
   * consumidores (Diretor/Advisor, API) usam: quando a org liga o Evidence Layer
   * (`evidence_layer_enabled`), serve o snapshot do cache TTL'd do
   * `EvidencePackageService` (persistido/versionado); senão, computa fresco —
   * comportamento IDÊNTICO ao de hoje (flag default 0 → 0 regressão).
   *
   * A forma é a MESMA do `build()` (organization/period/dataQuality/domains/
   * topPriorities) reconstruída sem perda do pacote (internalEvidence=domains),
   * + `_cache` (freshness/cacheHit/generatedAt/expiresAt) aditivo. Import
   * dinâmico pra quebrar o ciclo com o EvidencePackageService.
   */
  static read(orgId: string, period?: string): any {
    try {
      if (EvidencePackageService.isEnabled(orgId)) {
        const p = period || new Date().toISOString().slice(0, 7);
        const pkg = EvidencePackageService.build(orgId, { period: p });
        return {
          organization: { id: orgId },
          period: pkg.period,
          dataQuality: pkg.dataQuality,
          domains: pkg.internalEvidence || {},
          topPriorities: pkg.topPriorities || [],
          schemaVersion: 1,
          _cache: { freshness: pkg.freshness, cacheHit: !!pkg.cacheHit, generatedAt: pkg.generatedAt, expiresAt: pkg.expiresAt },
        };
      }
    } catch { /* cache indisponível → cai no fresco */ }
    return this.build(orgId, period);
  }
}

export default BusinessSnapshotV2Service;
