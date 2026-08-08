import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { AsaasService } from "./AsaasService.js";
import { PlanService } from "./PlanService.js";
import { isFalatuPlanId } from "./falatuPlans.js";

/**
 * ADR-154 F2.2 (Fatia E) — reembolso AUTOMÁTICO da garantia de 7 dias via ASAAS.
 *
 * Fecha a promessa das Fatias B/D ("garantia de 7 dias, CDC Art. 49") com
 * execução real: o cliente aciona uma vez (self-serve, no próprio app) e o
 * sistema (1) estorna o(s) pagamento(s) confirmado(s) no ASAAS, (2) cancela a
 * assinatura recorrente pra não cobrar de novo e (3) marca o billing terminal
 * como `cancelled`. Zero intervenção humana.
 *
 * Regras (RN):
 *  - RN-E1 Janela: elegível só DENTRO da garantia (`guarantee_days` do plano,
 *    default 7), contada a partir de `falatu_terms_accepted_at` (o momento em
 *    que o cliente contratou — proxy do "recebimento" do Art. 49). Fora da
 *    janela → `guarantee_expired` (aí é cancelamento simples, sem devolução).
 *  - RN-E2 Escopo: só planos `falatu_*` (B2C). Nunca estorna um tier B2B.
 *  - RN-E3 Idempotência: um único estorno por org. Reentrada (duplo-clique,
 *    retry) → `already_refunded`. Guardado por auditoria + estado `cancelled`.
 *  - RN-E4 Money-critical: se QUALQUER estorno falhar no ASAAS, ABORTA sem
 *    cancelar a assinatura (não deixa o cliente sem serviço E sem dinheiro de
 *    volta). O ASAAS é a fonte da verdade do que foi estornado.
 *  - RN-E5 Ordem: estorna PRIMEIRO, cancela DEPOIS. Cancelar antes arriscaria
 *    perder o serviço mesmo se o estorno recuar.
 *
 * O webhook PAYMENT_REFUNDED do ASAAS chega DEPOIS e é reconciliado no
 * AsaasService.handleWebhook: como a org já está `cancelled`, ele preserva o
 * terminal (não rebaixa pra `suspended`).
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const PAID_STATUSES = ["CONFIRMED", "RECEIVED", "RECEIVED_IN_CASH"];

export type RefundEligibility = {
  eligible: boolean;
  /** 'ok' | 'not_falatu_plan' | 'already_refunded' | 'guarantee_expired' | 'guarantee_window_unknown' */
  reason: string;
  windowDays: number;
  daysLeft: number;        // >= 0; quantos dias ainda restam da garantia (0 quando não elegível)
  deadline: string | null; // ISO — o prazo final da garantia
};

export type RefundResult = {
  organizationId: string;
  refundedPaymentIds: string[];
  refundedTotal: number;
  billingStatus: "cancelled";
};

export type RefundDeps = {
  listInvoices?: typeof AsaasService.listInvoices;
  refundPayment?: typeof AsaasService.refundPayment;
  cancelSubscription?: typeof AsaasService.cancelSubscription;
  asaasConfigured?: () => boolean;
  nowMs?: number; // injetável pra teste determinístico da janela
};

export class FalatuRefundError extends Error {
  constructor(public code: string, public httpStatus: number, message?: string) { super(message || code); }
}

/** SQLite CURRENT_TIMESTAMP grava 'YYYY-MM-DD HH:MM:SS' em UTC — parse seguro. */
function parseSqliteUtc(s: string | null | undefined): number | null {
  if (!s) return null;
  const str = String(s);
  const iso = str.includes("T") ? str : str.replace(" ", "T") + (/[zZ]|[+-]\d\d:?\d\d$/.test(str) ? "" : "Z");
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

const REASON_MSG: Record<string, string> = {
  not_falatu_plan: "Reembolso automático disponível só para assinaturas do FalaTu.",
  already_refunded: "Este reembolso já foi processado.",
  guarantee_expired: "O prazo de garantia de 7 dias já passou. Você ainda pode cancelar a assinatura.",
  guarantee_window_unknown: "Não foi possível verificar o prazo da garantia. Fale com o suporte.",
  billing_not_configured: "Serviço de cobrança indisponível no momento.",
};

export class FalatuRefundService {
  private static guaranteeDays(orgId: string): number {
    const feats: any = PlanService.getCurrentPlan(orgId)?.features || {};
    const n = Number(feats.guarantee_days);
    return Number.isFinite(n) && n > 0 ? n : 7;
  }

  /** Já houve um estorno pra esta org? (auditoria OU billing já terminal cancelado). */
  private static alreadyRefunded(orgId: string, billingStatus?: string): boolean {
    if (String(billingStatus || "") === "cancelled") return true;
    const row = db.prepare(`SELECT 1 FROM auth_audit_logs WHERE organization_id = ? AND event_type = 'FALATU_REFUND_ISSUED' LIMIT 1`).get(orgId);
    return !!row;
  }

  /** A garantia de 7 dias ainda vale? (read-only, pra UI mostrar/esconder o botão). */
  static checkEligibility(orgId: string, deps?: Pick<RefundDeps, "nowMs">): RefundEligibility {
    const org = db.prepare(`SELECT plan_id, billing_status, falatu_terms_accepted_at FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    const windowDays = this.guaranteeDays(orgId);
    const no = (reason: string): RefundEligibility => ({ eligible: false, reason, windowDays, daysLeft: 0, deadline: null });

    if (!org || !isFalatuPlanId(org.plan_id)) return no("not_falatu_plan");
    if (this.alreadyRefunded(orgId, org.billing_status)) return no("already_refunded");

    const acceptedMs = parseSqliteUtc(org.falatu_terms_accepted_at);
    if (!acceptedMs) return no("guarantee_window_unknown");

    const now = deps?.nowMs ?? Date.now();
    const deadlineMs = acceptedMs + windowDays * DAY_MS;
    const deadline = new Date(deadlineMs).toISOString();
    if (now > deadlineMs) return { eligible: false, reason: "guarantee_expired", windowDays, daysLeft: 0, deadline };

    const daysLeft = Math.max(0, Math.ceil((deadlineMs - now) / DAY_MS));
    return { eligible: true, reason: "ok", windowDays, daysLeft, deadline };
  }

  /**
   * Aciona o reembolso da garantia: estorna os pagamentos confirmados no ASAAS,
   * cancela a assinatura e marca `cancelled`. Idempotente (RN-E3) e
   * money-critical (RN-E4/E5).
   */
  static async requestRefund(orgId: string, actorUserId?: string | null, deps?: RefundDeps): Promise<RefundResult> {
    const elig = this.checkEligibility(orgId, deps);
    if (!elig.eligible) {
      const httpByReason: Record<string, number> = { not_falatu_plan: 400, already_refunded: 409, guarantee_expired: 403, guarantee_window_unknown: 422 };
      throw new FalatuRefundError(elig.reason, httpByReason[elig.reason] || 400, REASON_MSG[elig.reason] || elig.reason);
    }

    const configured = deps?.asaasConfigured ? deps.asaasConfigured() : AsaasService.isConfigured();
    if (!configured) throw new FalatuRefundError("billing_not_configured", 503, REASON_MSG.billing_not_configured);

    const listInvoices = deps?.listInvoices || AsaasService.listInvoices.bind(AsaasService);
    const refundPayment = deps?.refundPayment || AsaasService.refundPayment.bind(AsaasService);
    const cancelSubscription = deps?.cancelSubscription || AsaasService.cancelSubscription.bind(AsaasService);

    // RN-E4: estorna cada pagamento pago; se um falhar, aborta ANTES de cancelar.
    const invoices = await listInvoices(orgId);
    const paid = invoices.filter((i) => PAID_STATUSES.includes(String(i.status)));
    const refundedPaymentIds: string[] = [];
    let refundedTotal = 0;
    for (const inv of paid) {
      try {
        await refundPayment(inv.id, { description: "FalaTu — garantia de 7 dias (CDC Art. 49)" });
        refundedPaymentIds.push(inv.id);
        refundedTotal += Number(inv.value || 0);
      } catch (e: any) {
        throw new FalatuRefundError("refund_failed", 502, `Falha ao estornar o pagamento ${inv.id}: ${e?.message || e}`);
      }
    }

    // RN-E5: só depois de estornar, para a recorrência e fecha em 'cancelled'.
    // (Se não havia pagamento pago — ex.: boleto pendente dentro da janela —,
    // ainda assim cancela pra não cobrar; refundedTotal fica 0.)
    await cancelSubscription(orgId);

    logAuthEvent(orgId, actorUserId || null, actorUserId || null, "FALATU_REFUND_ISSUED", {
      refundedPaymentIds, refundedTotal, windowDays: elig.windowDays, daysLeftAtRequest: elig.daysLeft,
    });

    return { organizationId: orgId, refundedPaymentIds, refundedTotal, billingStatus: "cancelled" };
  }
}

export default FalatuRefundService;
