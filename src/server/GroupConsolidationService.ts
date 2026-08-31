/**
 * GroupConsolidationService — ADR-199 F2: visão consolidada do grupo (fan-out).
 *
 * O ÚNICO módulo autorizado a iterar as orgs de um grupo (RN-GRP-01/§4.4/§9.3 — choke
 * point). Para cada operação chama um service org-scoped JÁ EXISTENTE (o dashboard de
 * varejo por org), UMA org por chamada, e agrega os resultados. NUNCA faz SQL próprio de
 * negócio nem lê mais de uma org numa instrução — a agregação é soma dos números que
 * cada org devolve isoladamente.
 *
 * Garantias:
 *  - Isolamento: nenhuma query cruza orgs; cada número vem de uma chamada single-org.
 *  - Degradação graciosa (§4.4): se UMA operação falha, ela vira "parcial" e a
 *    consolidação segue com as demais — nunca um erro global derruba o painel.
 *  - Filtro por marca/operação (onlyOrg).
 *  - Read-only.
 *
 * O provider por-org é INJETÁVEL (snapshotFn) só para teste determinístico; em produção
 * o default é RetailDashboardService.monthly (org-scoped).
 */
import { OrgGroupService } from "./OrgGroupService.js";
import { RetailDashboardService } from "./RetailDashboardService.js";
import db from "./db.js";

export interface OperationMetrics {
  totalSales: number;
  closingsCount: number;
  commissionEstimate: number;
}

export interface OperationRow extends Partial<OperationMetrics> {
  organizationId: string;
  businessName: string | null;
  partial: boolean;                // true = a org falhou/indisponível (dados omitidos)
}

export interface GroupConsolidation {
  groupId: string;
  month: string;
  totals: OperationMetrics;        // soma verificável das operações NÃO-parciais
  operations: OperationRow[];
  partial: string[];              // orgIds que falharam (aparecem como parcial)
}

type SnapshotFn = (orgId: string, month: string) => { totalSales?: any; closingsCount?: any; commissionEstimate?: any };

function n(v: any): number { const x = Number(v); return Number.isFinite(x) ? x : 0; }

export class GroupConsolidationService {
  /**
   * Consolida o mês para todas as operações do grupo (ou só `onlyOrg`), por fan-out.
   * Cada org é lida isoladamente; falha em uma vira "parcial" sem derrubar o todo.
   */
  static consolidateMonthly(
    groupId: string,
    month: string,
    opts: { onlyOrg?: string; snapshotFn?: SnapshotFn } = {}
  ): GroupConsolidation {
    const snapshot = opts.snapshotFn || ((orgId: string, m: string) => RetailDashboardService.monthly(orgId, m));
    let members = OrgGroupService.membersOf(groupId).map((m) => m.organizationId);
    if (opts.onlyOrg) members = members.filter((o) => o === opts.onlyOrg);

    const totals: OperationMetrics = { totalSales: 0, closingsCount: 0, commissionEstimate: 0 };
    const operations: OperationRow[] = [];
    const partial: string[] = [];

    for (const orgId of members) {
      const businessName = (db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.business_name ?? null;
      try {
        // FAN-OUT: uma org por chamada. Nunca uma query lê >1 org (RN-GRP-01).
        const s = snapshot(orgId, month) || {};
        const m: OperationMetrics = { totalSales: n(s.totalSales), closingsCount: n(s.closingsCount), commissionEstimate: n(s.commissionEstimate) };
        totals.totalSales += m.totalSales;
        totals.closingsCount += m.closingsCount;
        totals.commissionEstimate += m.commissionEstimate;
        operations.push({ organizationId: orgId, businessName, ...m, partial: false });
      } catch {
        // Degradação graciosa: a operação some dos totais, mas o painel não quebra.
        operations.push({ organizationId: orgId, businessName, partial: true });
        partial.push(orgId);
      }
    }

    return { groupId, month, totals, operations, partial };
  }
}
