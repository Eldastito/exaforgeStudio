/**
 * RetailCommissionGovernanceService — o gerente PROPÕE, o dono APROVA (ZapFlow Grupo / TOULON).
 *
 * Decisão do dono (04/10): o gerente da loja vê e edita as regras de comissão DA LOJA dele, mas toda
 * alteração só vale depois que o Bruno confirma — e os dois são avisados do que aconteceu.
 * O ciclo de vida (proposta → pendente → confirmada | arquivada) já existe em `RetailCommissionPolicyService`
 * (pendente NUNCA vira pagamento). Este serviço só cuida do AVISO, sempre pela espinha (`business_signals`,
 * convenção nº 12 — nunca tabela de alerta própria):
 *   - proposta enviada  → sinal "aguardando aprovação" (o dono vê em Hoje/Central de Saúde; o gerente da loja vê o status);
 *   - confirmada/recusada → o sinal pendente é resolvido e nasce um aviso de decisão para a loja (qual proposta,
 *     o que decidiram, o motivo e o que fazer), SÓ quando quem decidiu não é quem propôs.
 * O sinal é amarrado à loja (`retail_store`), então a trava por loja (StoreSignalScopeService) mostra ao gerente
 * somente os da loja dele. Best-effort: aviso que falha nunca derruba a decisão.
 */
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

const storeName = (orgId: string, storeId: string): string =>
  String((db.prepare("SELECT name FROM retail_stores WHERE organization_id = ? AND id = ?").get(orgId, storeId) as any)?.name || "loja");
const who = (orgId: string, userId: string | null | undefined): string => {
  if (!userId) return "alguém da equipe";
  const u = db.prepare("SELECT name FROM users WHERE organization_id = ? AND id = ?").get(orgId, userId) as any;
  return String(u?.name || "alguém da equipe");
};
const pendingKey = (proposalId: string) => `commission_proposal_pending:${proposalId}`;
const decidedKey = (proposalId: string) => `commission_proposal_decided:${proposalId}`;

export class RetailCommissionGovernanceService {
  /** Proposta de uma LOJA enviada pra aprovação → avisa o dono (e deixa o status visível pro gerente da loja). */
  static notifyPending(orgId: string, proposal: { id: string; storeId: string | null; month: string | null; createdBy: string | null; note: string | null }): void {
    if (!proposal.storeId) return; // proposta da rede inteira é do dono — sem aviso
    try {
      const store = storeName(orgId, proposal.storeId);
      BusinessSignalService.publish(orgId, {
        domain: "retail_ops", signalType: "retail_commission_proposal_pending", severity: "attention", basis: "fact", confidence: 1,
        sourceService: "RetailCommissionGovernanceService", sourceEntityType: "retail_store", sourceEntityId: proposal.storeId,
        evidence: {
          store, proposalId: proposal.id, month: proposal.month, proposedBy: who(orgId, proposal.createdBy), note: proposal.note,
          what: `${who(orgId, proposal.createdBy)} propôs uma mudança nas regras de comissão da loja ${store}${proposal.month ? ` (${proposal.month})` : ""}.`,
          where: "Operação da Rede → Comissão → Propostas",
          todo: "Confira os valores e confirme ou recuse. Enquanto não confirmar, a regra antiga continua valendo.",
        },
        dedupeKey: pendingKey(proposal.id),
      } as any);
    } catch { /* aviso é best-effort */ }
  }

  /** Decisão do dono (confirmou/recusou): fecha o pendente e avisa a loja. */
  static notifyDecided(orgId: string, proposal: { id: string; storeId: string | null; month: string | null; createdBy: string | null }, decision: "confirmed" | "archived", by: string | null, reason?: string | null): void {
    if (!proposal.storeId) return;
    try {
      BusinessSignalService.resolveByDedupe(orgId, pendingKey(proposal.id));
      if (by && by === proposal.createdBy) return; // quem propôs e decidiu é a mesma pessoa (dono) — sem aviso redundante
      const store = storeName(orgId, proposal.storeId);
      const ok = decision === "confirmed";
      BusinessSignalService.publish(orgId, {
        domain: "retail_ops", signalType: ok ? "retail_commission_proposal_confirmed" : "retail_commission_proposal_rejected",
        severity: ok ? "info" : "attention", basis: "fact", confidence: 1,
        sourceService: "RetailCommissionGovernanceService", sourceEntityType: "retail_store", sourceEntityId: proposal.storeId,
        evidence: {
          store, proposalId: proposal.id, month: proposal.month, decidedBy: who(orgId, by), reason: reason || null,
          what: ok ? `${who(orgId, by)} confirmou a mudança de comissão da loja ${store}${proposal.month ? ` (${proposal.month})` : ""}. Já vale a partir de agora.`
                   : `${who(orgId, by)} recusou a mudança de comissão proposta para a loja ${store}${proposal.month ? ` (${proposal.month})` : ""}.${reason ? ` Motivo: ${reason}.` : ""}`,
          where: "Operação da Rede → Comissão → Propostas",
          todo: ok ? "Nada a fazer." : "Ajuste e envie uma nova proposta, ou fale com o dono.",
        },
        dedupeKey: decidedKey(proposal.id),
      } as any);
    } catch { /* aviso é best-effort */ }
  }
}

export default RetailCommissionGovernanceService;
