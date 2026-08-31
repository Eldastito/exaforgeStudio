/**
 * GroupBillingService — ADR-199 (observação #1): PRÉVIA de fatura do grupo.
 *
 * READ-MODEL determinístico (RN-004) que MEDE quanto o grupo custaria por mês, SEM tocar
 * gateway. É a "medição" que o PRD §11 pede antes da cobrança real (bloqueada até o ASAAS
 * deixar de ser mockado — ADR-177). NÃO emite cobrança, NÃO cria assinatura: só calcula.
 *
 * Modelo (docs/prd/OBSERVACOES-ZAPFLOW-GRUPO.md — decidido com o cliente):
 *  - Assinatura POR OPERAÇÃO (CNPJ = org): preço do plano de cada org (PLAN_GRADE).
 *  - Desconto por VOLUME de operações ativas no grupo:
 *      1–2 operações → 0% · 3–5 → 10% · 6+ → 20%.
 *  - Add-on "Grupo/Consolidação" cobrado UMA vez por grupo (valor configurável; default 0
 *    até o comercial definir — NÃO inventa dinheiro).
 *
 * Honestidade dura (RN §dinheiro): operação sem plano conhecido entra como "unpriced"
 * (preço null, fora do subtotal) — nunca com valor inventado. Só conta no total o que tem
 * preço de plano real. Role-gated na rota (owner/admin).
 */
import db from "./db.js";
import { PLAN_GRADE } from "./plansGrade.js";
import { OrgGroupService } from "./OrgGroupService.js";

/** Faixas de desconto por volume (limites inclusivos). Configurável via opts.tiers. */
export interface VolumeTier { minOps: number; maxOps: number | null; discountPct: number }
export const DEFAULT_VOLUME_TIERS: VolumeTier[] = [
  { minOps: 1, maxOps: 2, discountPct: 0 },
  { minOps: 3, maxOps: 5, discountPct: 10 },
  { minOps: 6, maxOps: null, discountPct: 20 },
];

export interface BillingOperationRow {
  organizationId: string;
  businessName: string | null;
  planId: string | null;
  planName: string | null;
  basePrice: number | null;   // preço de tabela do plano (null = plano desconhecido)
  netPrice: number | null;    // basePrice com o desconto de volume (null se unpriced)
  unpriced: boolean;          // true = sem plano conhecido (fora do subtotal)
}

export interface GroupBillingPreview {
  groupId: string;
  operationCount: number;         // operações ativas (base da faixa de volume)
  volumeDiscountPct: number;
  operations: BillingOperationRow[];
  operationsSubtotal: number;     // soma dos netPrice (só operações com plano conhecido)
  groupAddon: number;             // add-on de grupo (uma vez)
  total: number;                  // subtotal + add-on
  currency: "BRL";
  unpricedOperations: string[];   // orgs sem plano conhecido (transparência)
  note: string;
}

const PRICE_BY_PLAN: Record<string, { name: string; price: number }> = Object.fromEntries(
  PLAN_GRADE.map((p) => [p.id, { name: p.name, price: p.price }])
);

function tierFor(count: number, tiers: VolumeTier[]): number {
  const t = tiers.find((x) => count >= x.minOps && (x.maxOps == null || count <= x.maxOps));
  return t ? t.discountPct : 0;
}

export class GroupBillingService {
  /**
   * Calcula a prévia de fatura do grupo. `opts.groupAddon` (default 0 — não inventa) e
   * `opts.tiers` (default DEFAULT_VOLUME_TIERS) permitem o comercial parametrizar sem
   * mexer no código. Só operações ATIVAS (org não bloqueada, billing_status != cancelled)
   * contam como operação faturável.
   */
  static preview(groupId: string, opts: { groupAddon?: number; tiers?: VolumeTier[] } = {}): GroupBillingPreview {
    const tiers = opts.tiers || DEFAULT_VOLUME_TIERS;
    const groupAddon = Number.isFinite(opts.groupAddon as number) ? Number(opts.groupAddon) : 0;

    const members = OrgGroupService.membersOf(groupId).map((m) => m.organizationId);
    const active = members.filter((orgId) => {
      const s = db.prepare("SELECT status, billing_status FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      if (!s) return false;
      if (s.status === "blocked") return false;
      if (s.billing_status === "cancelled") return false;
      return true;
    });

    const operationCount = active.length;
    const volumeDiscountPct = tierFor(operationCount, tiers);

    const operations: BillingOperationRow[] = [];
    const unpricedOperations: string[] = [];
    let operationsSubtotal = 0;

    for (const orgId of active) {
      const s = db.prepare("SELECT business_name, plan_id FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
      const planId: string | null = s?.plan_id || null;
      const plan = planId ? PRICE_BY_PLAN[planId] : undefined;
      if (!plan) {
        operations.push({ organizationId: orgId, businessName: s?.business_name ?? null, planId, planName: null, basePrice: null, netPrice: null, unpriced: true });
        unpricedOperations.push(orgId);
        continue;
      }
      // Arredonda a 2 casas — dinheiro nunca em float cru.
      const netPrice = Math.round(plan.price * (1 - volumeDiscountPct / 100) * 100) / 100;
      operationsSubtotal += netPrice;
      operations.push({ organizationId: orgId, businessName: s?.business_name ?? null, planId, planName: plan.name, basePrice: plan.price, netPrice, unpriced: false });
    }

    operationsSubtotal = Math.round(operationsSubtotal * 100) / 100;
    const total = Math.round((operationsSubtotal + groupAddon) * 100) / 100;

    return {
      groupId,
      operationCount,
      volumeDiscountPct,
      operations,
      operationsSubtotal,
      groupAddon,
      total,
      currency: "BRL",
      unpricedOperations,
      note: "Prévia (read-model). NÃO é cobrança — emissão real depende do gateway (ASAAS). "
        + `Desconto de volume: ${volumeDiscountPct}% (${operationCount} operação(ões) ativa(s)).`,
    };
  }
}
