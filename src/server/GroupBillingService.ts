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

  /**
   * FATURAMENTO SEPARADO (obs #1). Particiona a prévia por PAGADOR: cada CNPJ paga a
   * própria fatura por default (payer_ref null → chave = a própria org); operações com o
   * MESMO payer_ref caem numa fatura só (ex.: uma marca).
   *
   * DECISÃO DE DESCONTO (política): a faixa de volume é calculada pela ESCALA REAL do
   * cliente (total de operações ativas no grupo) e aplicada à fatura de CADA CNPJ — separar
   * o pagamento NÃO tira o desconto que o cliente ganhou por ter N lojas. Invariante: a
   * soma das faturas separadas == a fatura consolidada (`preview().total`).
   *
   * ADD-ON de grupo: cobrado UMA vez por grupo (não por pagador). Vai no pagador PRINCIPAL
   * (default: o 1º em ordem determinística; `opts.addonPayerRef` fixa outro).
   */
  static previewByPayer(
    groupId: string,
    opts: { groupAddon?: number; tiers?: VolumeTier[]; addonPayerRef?: string } = {}
  ): {
    groupId: string; operationCount: number; volumeDiscountPct: number; groupAddon: number;
    payers: { payerRef: string; operations: BillingOperationRow[]; subtotal: number; addon: number; total: number }[];
    grandTotal: number; currency: "BRL"; unpricedOperations: string[]; note: string;
  } {
    const tiers = opts.tiers || DEFAULT_VOLUME_TIERS;
    const groupAddon = Number.isFinite(opts.groupAddon as number) ? Number(opts.groupAddon) : 0;

    const members = OrgGroupService.membersOf(groupId);
    const active = members.filter((m) => {
      const s = db.prepare("SELECT status, billing_status FROM organization_settings WHERE organization_id = ?").get(m.organizationId) as any;
      return s && s.status !== "blocked" && s.billing_status !== "cancelled";
    });

    // Desconto pela ESCALA DO GRUPO (não do subgrupo) — a fatura de cada CNPJ herda a faixa.
    const operationCount = active.length;
    const volumeDiscountPct = tierFor(operationCount, tiers);

    // Agrupa por pagador: payer_ref quando setado, senão a própria org (paga sozinha).
    const buckets = new Map<string, BillingOperationRow[]>();
    const unpricedOperations: string[] = [];
    for (const m of active) {
      const key = m.payerRef || m.organizationId;
      const s = db.prepare("SELECT business_name, plan_id FROM organization_settings WHERE organization_id = ?").get(m.organizationId) as any;
      const planId: string | null = s?.plan_id || null;
      const plan = planId ? PRICE_BY_PLAN[planId] : undefined;
      const row: BillingOperationRow = plan
        ? { organizationId: m.organizationId, businessName: s?.business_name ?? null, planId, planName: plan.name, basePrice: plan.price, netPrice: Math.round(plan.price * (1 - volumeDiscountPct / 100) * 100) / 100, unpriced: false }
        : { organizationId: m.organizationId, businessName: s?.business_name ?? null, planId, planName: null, basePrice: null, netPrice: null, unpriced: true };
      if (row.unpriced) unpricedOperations.push(m.organizationId);
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(row);
    }

    const payerKeys = [...buckets.keys()].sort();
    const addonKey = (opts.addonPayerRef && buckets.has(opts.addonPayerRef)) ? opts.addonPayerRef : payerKeys[0];

    const payers = payerKeys.map((payerRef) => {
      const operations = buckets.get(payerRef)!;
      const subtotal = Math.round(operations.reduce((s, o) => s + (o.netPrice ?? 0), 0) * 100) / 100;
      const addon = payerRef === addonKey ? groupAddon : 0;
      return { payerRef, operations, subtotal, addon, total: Math.round((subtotal + addon) * 100) / 100 };
    });

    const grandTotal = Math.round(payers.reduce((s, p) => s + p.total, 0) * 100) / 100;

    return {
      groupId, operationCount, volumeDiscountPct, groupAddon, payers, grandTotal,
      currency: "BRL", unpricedOperations,
      note: "Prévia SEPARADA por pagador (read-model). Cada CNPJ paga a própria fatura; o "
        + `desconto (${volumeDiscountPct}%) vem da escala do grupo (${operationCount} operações). `
        + "Add-on de grupo cobrado uma vez. Soma das faturas == prévia consolidada.",
    };
  }
}
