import db from "./db.js";
import { randomUUID } from "crypto";
import { FalatuRefundService } from "./FalatuRefundService.js";

/**
 * FalatuSaveOfferService — save offers antes do cancelamento/reembolso do FalaTu
 * (ADR-155 F5.1). Implementa o cancel flow do `churn-prevention` destilado na
 * rubrica docs/grimoire/copy/compose/save-offer-ladder.md: captura o MOTIVO e
 * mapeia pro DEGRAU certo do ladder (não oferece todos).
 *
 * GUARDRAIL DURO (money-critical, herdado da ADR-154 RN-E / RN-155 §5): a
 * garantia de 7 dias (CDC Art. 49) NUNCA é bloqueada pela oferta. Por isso todo
 * retorno carrega `eligibility` (do FalatuRefundService) — a UI mantém o botão
 * de reembolso acessível e recusar a oferta leva DIRETO ao reembolso. A oferta é
 * opt-out, não fricção.
 *
 * F5.1 = captura + mapa (recomendação). A EXECUÇÃO do degrau (pausa/downgrade/
 * desconto ligando no entitlement ADR-153) é a F5.2; a medição de retenção
 * (aceitos vs reembolsados) é a F5.3. Este serviço só sugere — não pausa, não
 * dá desconto, não estorna sozinho.
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
}

export default FalatuSaveOfferService;
