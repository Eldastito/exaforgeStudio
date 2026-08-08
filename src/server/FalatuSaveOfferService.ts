import db from "./db.js";
import { randomUUID } from "crypto";
import { FalatuRefundService } from "./FalatuRefundService.js";
import { FALATU_PLAN_IDS, FALATU_PLANS } from "./falatuPlans.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * FalatuSaveOfferService — save offers antes do cancelamento/reembolso do FalaTu
 * (ADR-155 F5). Implementa o cancel flow do `churn-prevention` destilado na
 * rubrica docs/grimoire/copy/compose/save-offer-ladder.md: captura o MOTIVO e
 * mapeia pro DEGRAU certo do ladder (não oferece todos).
 *
 * GUARDRAIL DURO (money-critical, herdado da ADR-154 RN-E / RN-155 §5): a
 * garantia de 7 dias (CDC Art. 49) NUNCA é bloqueada pela oferta. Por isso todo
 * retorno carrega `eligibility` (do FalatuRefundService) — a UI mantém o botão
 * de reembolso acessível e recusar a oferta leva DIRETO ao reembolso. A oferta é
 * opt-out, não fricção.
 *
 * F5.1 = captura + mapa (recomendação). F5.2 = aceitar o degrau LIGANDO no
 * entitlement (ADR-153) SEM autonomia de cobrança: seguindo o G-153-3 (aceitar
 * recomendação nunca executa a mudança — só registra e encaminha pro operador
 * finalizar em Cobrança) e o RN-155 §2 (a IA não muda billing sozinha),
 * `acceptOffer` calcula o alvo do downgrade a partir do próprio catálogo de
 * planos, marca a intenção como retida e publica um sinal de handoff — mas NÃO
 * chama setPlan/setBillingStatus/ASAAS. A execução do dinheiro é do humano.
 * A medição de retenção (aceitos vs reembolsados) é a F5.3.
 */

export const CANCELLATION_REASONS = ["preco", "pouco_uso", "faltou_feature", "problema_tecnico", "outro"] as const;
export type CancellationReason = typeof CANCELLATION_REASONS[number];

export type SaveOfferType = "downgrade" | "pause" | "roadmap" | "support" | "none";

export interface SaveOffer {
  type: SaveOfferType;
  headline: string;
  description: string;
  cta: string | null;
}

export interface SaveOfferIntent {
  intentId: string;
  reason: CancellationReason;
  offer: SaveOffer;
  eligibility: ReturnType<typeof FalatuRefundService.checkEligibility>;
  /** Transparência: a garantia segue disponível; recusar leva ao reembolso. */
  refundNote: string;
}

/** O que o operador precisa fazer em Cobrança pra materializar o degrau aceito. */
export interface SaveOfferHandoff {
  action: "downgrade" | "pause" | "roadmap_followup" | "route_support";
  targetPlanId?: string | null;
  targetPlanName?: string | null;
  months?: number;
  /** Instrução curta pro operador (G-153-3: a mudança de billing é dele). */
  note: string;
}

export interface AcceptOfferResult {
  ok: boolean;
  reason?: string; // no_pending_intent | no_offer
  outcome?: "retained";
  degrau?: SaveOfferType;
  handoff?: SaveOfferHandoff;
  eligibility?: ReturnType<typeof FalatuRefundService.checkEligibility>;
  /** Money-critical: nada foi cobrado/alterado; garantia intacta. */
  note?: string;
}

// Preço mensal por tier do catálogo FalaTu — fonte da verdade pro impacto do sinal.
const PLAN_PRICE: Record<string, number> = Object.fromEntries(FALATU_PLANS.map((p) => [p.id, p.price]));

/** Recorte de retenção (F5.3), derivado por query. `key` = degrau ou motivo. */
export interface RetentionBreakdown {
  key: string;
  offered: number;
  retained: number;
  refunded: number;
  cancelled: number;
  pending: number;
  retentionRatePct: number | null;
}

export interface RetentionMetrics {
  scope: "org" | "platform";
  total: number;
  pending: number;
  retained: number;
  refunded: number;
  cancelled: number;
  resolved: number;
  retentionRatePct: number | null;
  byOffer: RetentionBreakdown[];
  byReason: RetentionBreakdown[];
}

export class FalatuSaveOfferService {
  static isReason(r: string): r is CancellationReason {
    return (CANCELLATION_REASONS as readonly string[]).includes(r);
  }

  /** Mapa motivo → degrau do ladder (grimoire save-offer-ladder). Puro. */
  static offerForReason(reason: CancellationReason): SaveOffer {
    switch (reason) {
      case "preco":
        return { type: "downgrade", headline: "Que tal um plano mais leve?", description: "Dá pra continuar num plano menor e pagar menos, mantendo o essencial.", cta: "Ver plano menor" };
      case "pouco_uso":
        return { type: "pause", headline: "Quer dar uma pausa em vez de sair?", description: "Posso pausar sua conta por 1 mês, sem cobrança — você volta de onde parou.", cta: "Pausar 1 mês" };
      case "faltou_feature":
        return { type: "roadmap", headline: "Conta o que faltou?", description: "Se faltou algo específico, me diz — muita coisa já está no roadmap e posso te avisar quando sair.", cta: null };
      case "problema_tecnico":
        return { type: "support", headline: "Deixa a gente resolver primeiro", description: "Se rolou um problema técnico, o suporte resolve rapidinho antes de você decidir sair.", cta: "Falar com o suporte" };
      case "outro":
      default:
        return { type: "none", headline: "", description: "", cta: null };
    }
  }

  /**
   * Captura a intenção de cancelamento com o motivo e a oferta mapeada. Dedupe:
   * mantém UMA intenção `pending` por org (upsert) — reabrir o fluxo atualiza o
   * motivo/oferta, não empilha. SEMPRE retorna a elegibilidade do reembolso.
   */
  static captureIntent(orgId: string, userId: string | null | undefined, input: { reason: CancellationReason; freeText?: string | null }): SaveOfferIntent {
    const offer = this.offerForReason(input.reason);
    const eligibility = FalatuRefundService.checkEligibility(orgId);

    const existing = db.prepare(`SELECT id FROM falatu_cancellation_intents WHERE organization_id = ? AND outcome = 'pending' ORDER BY created_at DESC LIMIT 1`).get(orgId) as any;
    let intentId: string;
    if (existing) {
      intentId = existing.id;
      db.prepare(`UPDATE falatu_cancellation_intents SET reason = ?, free_text = ?, offered_type = ?, user_id = COALESCE(?, user_id) WHERE id = ?`)
        .run(input.reason, input.freeText ?? null, offer.type, userId ?? null, intentId);
    } else {
      intentId = randomUUID();
      db.prepare(`INSERT INTO falatu_cancellation_intents (id, organization_id, user_id, reason, free_text, offered_type) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(intentId, orgId, userId ?? null, input.reason, input.freeText ?? null, offer.type);
    }

    return {
      intentId,
      reason: input.reason,
      offer,
      eligibility,
      refundNote: eligibility.eligible
        ? `Você está dentro da garantia de 7 dias — o reembolso é seu direito e segue disponível. A oferta acima é opcional.`
        : `Você ainda pode cancelar a assinatura a qualquer momento; a oferta acima é opcional.`,
    };
  }

  /** Resolve a intenção pendente da org (usado por F5.2/F5.3). outcome ∈ retained|refunded|cancelled. */
  static resolve(orgId: string, outcome: "retained" | "refunded" | "cancelled"): { ok: boolean } {
    const r = db.prepare(`UPDATE falatu_cancellation_intents SET outcome = ?, resolved_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND outcome = 'pending'`).run(outcome, orgId);
    return { ok: r.changes > 0 };
  }

  private static currentPlanId(orgId: string): string | null {
    const org = db.prepare(`SELECT plan_id FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;
    return org?.plan_id ?? null;
  }

  /**
   * Tier de FalaTu imediatamente ABAIXO do plano atual da org (ou null se já é o
   * menor / não é um plano FalaTu). Deriva do catálogo `FALATU_PLAN_IDS`, que está
   * em ordem crescente de preço — o downgrade é o índice anterior. Puro/leitura.
   */
  static downgradeTargetFor(orgId: string): { id: string; name: string; price: number } | null {
    const cur = this.currentPlanId(orgId);
    if (!cur) return null;
    const idx = (FALATU_PLAN_IDS as readonly string[]).indexOf(cur);
    if (idx <= 0) return null; // não-FalaTu OU já é o menor tier (solo)
    const targetId = FALATU_PLAN_IDS[idx - 1];
    const p = FALATU_PLANS.find((x) => x.id === targetId);
    return p ? { id: p.id, name: p.name, price: p.price } : null;
  }

  /** Traduz o degrau aceito na instrução concreta pro operador (não executa nada). */
  private static handoffFor(orgId: string, degrau: SaveOfferType): SaveOfferHandoff {
    switch (degrau) {
      case "downgrade": {
        const target = this.downgradeTargetFor(orgId);
        return target
          ? { action: "downgrade", targetPlanId: target.id, targetPlanName: target.name, note: `Aplicar downgrade para ${target.name} (R$${target.price}/mês) em Cobrança.` }
          : { action: "downgrade", targetPlanId: null, targetPlanName: null, note: "Já está no menor plano — avaliar desconto/pausa em Cobrança." };
      }
      case "pause":
        return { action: "pause", months: 1, note: "Aplicar pausa de 1 mês (sem cobrança) em Cobrança." };
      case "roadmap":
        return { action: "roadmap_followup", note: "Cliente quer acompanhar o roadmap — registrar o interesse e avisar quando sair." };
      case "support":
      default:
        return { action: "route_support", note: "Encaminhar ao suporte para resolver o problema antes de qualquer cobrança." };
    }
  }

  /**
   * O cliente ACEITOU a save offer (F5.2). Segue o G-153-3 da ADR-153 e o RN-155
   * §2: aceitar NÃO executa a mudança de cobrança — `acceptOffer` marca a intenção
   * como retida, calcula o alvo do downgrade a partir do catálogo e publica um sinal
   * de handoff (`save_offer_accepted`, convenção nº 12) pro operador finalizar a
   * pausa/downgrade em Cobrança. NÃO chama setPlan/setBillingStatus/ASAAS. A
   * garantia de 7 dias segue intocada (não mexemos em billing aqui) — o retorno
   * ainda carrega `eligibility` pra transparência.
   */
  static acceptOffer(orgId: string, userId?: string | null): AcceptOfferResult {
    const intent = db.prepare(`SELECT id, reason, offered_type FROM falatu_cancellation_intents WHERE organization_id = ? AND outcome = 'pending' ORDER BY created_at DESC LIMIT 1`).get(orgId) as any;
    if (!intent) return { ok: false, reason: "no_pending_intent" };
    const degrau = (intent.offered_type || "none") as SaveOfferType;
    if (degrau === "none") return { ok: false, reason: "no_offer" }; // "outro" → sem oferta; vai pro reembolso

    const handoff = this.handoffFor(orgId, degrau);
    // RN-004: o outcome é o DADO; a medição F5.3 deriva retenção por query.
    this.resolve(orgId, "retained");

    // Handoff governado (G-153-3): downgrade/pause mexem em dinheiro (attention);
    // roadmap/support são follow-up sem cobrança (info). Best-effort (convenção
    // nº 7): nunca derruba o accept. Impacto = MRR retido (alvo do downgrade ou
    // plano atual), base `fact`.
    const hasBillingChange = degrau === "downgrade" || degrau === "pause";
    const mrr = handoff.targetPlanId ? (PLAN_PRICE[handoff.targetPlanId] ?? null) : (PLAN_PRICE[this.currentPlanId(orgId) ?? ""] ?? null);
    try {
      BusinessSignalService.publish(orgId, {
        domain: "churn",
        signalType: "save_offer_accepted",
        severity: hasBillingChange ? "attention" : "info",
        basis: "fact",
        confidence: 1,
        impactAmount: mrr,
        impactUnit: "BRL/mês",
        sourceService: "FalatuSaveOfferService",
        sourceEntityType: "cancellation_intent",
        sourceEntityId: intent.id,
        evidence: { reason: intent.reason, degrau, handoff, userId: userId ?? null },
        dedupeKey: `save_offer:accepted:${orgId}`,
      });
    } catch { /* best-effort */ }

    return {
      ok: true,
      outcome: "retained",
      degrau,
      handoff,
      eligibility: FalatuRefundService.checkEligibility(orgId),
      note: "Retenção registrada. Nenhuma cobrança foi alterada — a pausa/downgrade é finalizada pelo operador em Cobrança; a garantia de 7 dias segue disponível.",
    };
  }

  /**
   * F5.3 — medição de retenção (retidos vs reembolsados), DERIVADA por query
   * sobre `falatu_cancellation_intents.outcome` (RN-004: nunca contador mutável,
   * nunca tabela própria). `retentionRatePct = retained / resolved` onde
   * resolved = retained+refunded+cancelled; **null** quando ainda não há caso
   * resolvido (honestidade sobre o que o número mede, padrão 5 — não força 0%).
   * `byOffer` mostra qual degrau do ladder retém melhor (insumo pra afinar a
   * oferta). `orgId=null` agrega CROSS-ORG (só master admin — a rota que expõe
   * está sob requireMasterAdmin; toda rota self-serve passa o orgId do JWT).
   */
  static retentionMetrics(orgId: string): RetentionMetrics {
    return this.aggregate(orgId);
  }

  static retentionSummary(): RetentionMetrics {
    return this.aggregate(null);
  }

  private static aggregate(orgId: string | null): RetentionMetrics {
    const where = orgId ? "WHERE organization_id = ?" : "";
    const p: any[] = orgId ? [orgId] : [];
    const rows = db.prepare(`SELECT COALESCE(offered_type,'none') AS offer, reason, outcome, COUNT(*) AS c FROM falatu_cancellation_intents ${where} GROUP BY offer, reason, outcome`).all(...p) as any[];

    const zero = () => ({ offered: 0, pending: 0, retained: 0, refunded: 0, cancelled: 0 });
    const totals = zero();
    const byOfferMap = new Map<string, ReturnType<typeof zero>>();
    const byReasonMap = new Map<string, ReturnType<typeof zero>>();
    const bump = (b: ReturnType<typeof zero>, outcome: string, c: number) => {
      b.offered += c;
      if (outcome === "pending") b.pending += c;
      else if (outcome === "retained") b.retained += c;
      else if (outcome === "refunded") b.refunded += c;
      else if (outcome === "cancelled") b.cancelled += c;
    };
    for (const r of rows) {
      const c = Number(r.c) || 0;
      bump(totals, r.outcome, c);
      if (!byOfferMap.has(r.offer)) byOfferMap.set(r.offer, zero());
      bump(byOfferMap.get(r.offer)!, r.outcome, c);
      if (!byReasonMap.has(r.reason)) byReasonMap.set(r.reason, zero());
      bump(byReasonMap.get(r.reason)!, r.outcome, c);
    }

    const rate = (b: ReturnType<typeof zero>): number | null => {
      const resolved = b.retained + b.refunded + b.cancelled;
      return resolved > 0 ? Math.round((b.retained / resolved) * 100) : null;
    };
    const shape = (key: string, b: ReturnType<typeof zero>) => ({
      key, offered: b.offered, retained: b.retained, refunded: b.refunded, cancelled: b.cancelled, pending: b.pending, retentionRatePct: rate(b),
    });

    return {
      scope: orgId ? "org" : "platform",
      total: totals.offered,
      pending: totals.pending,
      retained: totals.retained,
      refunded: totals.refunded,
      cancelled: totals.cancelled,
      resolved: totals.retained + totals.refunded + totals.cancelled,
      retentionRatePct: rate(totals),
      byOffer: [...byOfferMap.entries()].map(([k, b]) => shape(k, b)).sort((a, z) => z.offered - a.offered),
      byReason: [...byReasonMap.entries()].map(([k, b]) => shape(k, b)).sort((a, z) => z.offered - a.offered),
    };
  }
}

export default FalatuSaveOfferService;
