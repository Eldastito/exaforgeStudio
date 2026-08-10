/**
 * FalaTuApprovalService — PRD 1 Fase 4 (§24-25, §54, §66): Approval Center. A
 * aprovação acontece DENTRO do Fala Tu, mas o MOTOR é o canônico — não se
 * reimplementa policy/ledger/RBAC (CA15). Esta camada só APRESENTA e DELEGA:
 *   - apresenta o card da aprovação (valor, motivo, política que exige, §24);
 *   - decide com `actionId` EXPLÍCITO + decisão enum (nunca texto livre ambíguo,
 *     §25) → delega pra DecisionActionService.approve/reject (identidade
 *     obrigatória, two-step, audit, idempotência já garantidos pelo motor);
 *   - a autorização usa a MESMA porta (`DecisionActionService.canApprove`) da
 *     rota core — o Fala Tu NÃO pode virar bypass de permissão (§30/CA13).
 */
import { DecisionActionService } from "./DecisionActionService.js";

function br(n: number | null | undefined): string {
  return n == null ? "—" : `R$${Number(n).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Motivo legível de por que a ação exige aprovação (§24), derivado dos campos
// que a ação JÁ carrega (política + papel + impacto) — sem recomputar nada.
function whyApproval(a: any): string {
  const parts: string[] = [];
  if (a.approval_policy === "two_step") parts.push("exige duas aprovações");
  else if (a.approval_role) parts.push(`exige aprovação do perfil ${a.approval_role}`);
  else parts.push("exige aprovação");
  if (a.expected_impact != null) parts.push(`impacto estimado ${br(a.expected_impact)}`);
  return `Sua política ${parts.join("; ")}.`;
}

export class FalaTuApprovalService {
  /** Card canônico de uma ação pendente (o que a UI do Fala Tu mostra, §24). */
  private static card(a: any, canApprove: boolean): any {
    return {
      actionId: a.id, title: a.title, domain: a.domain, actionType: a.action_type,
      expectedImpact: a.expected_impact ?? null, impactUnit: a.impact_unit ?? null,
      approvalPolicy: a.approval_policy, approvalRole: a.approval_role ?? null,
      why: whyApproval(a), status: a.status, correlationId: a.correlation_id ?? null,
      canApprove, // se false, o usuário vê mas não pode decidir (a UI trava os botões)
    };
  }

  /** Aprovações aguardando — cada uma como card, com o flag de permissão do usuário. */
  static pending(orgId: string, user: any): { total: number; items: any[] } {
    const items = DecisionActionService.list(orgId, { status: "awaiting_approval" })
      .map((a) => this.card(a, DecisionActionService.canApprove(orgId, user, a)));
    return { total: items.length, items };
  }

  /**
   * Decide uma aprovação por `actionId` EXPLÍCITO (§25). `decision` é enum, não
   * texto livre. Enforce RBAC (mesma porta da rota core) ANTES de delegar. O
   * motor é idempotente (§54): o mesmo usuário decidir 2× é no-op.
   */
  static decide(orgId: string, user: any, actionId: string, decision: "approve" | "reject", reason?: string | null): { action: any; message: string } {
    const a = DecisionActionService.get(orgId, actionId);
    if (!a) throw new Error("Ação não encontrada.");
    const userId = user?.userId || user?.id;

    if (decision === "approve") {
      if (!DecisionActionService.canApprove(orgId, user, a)) throw new Error(`Você não tem permissão para aprovar esta ação${a.approval_role ? ` (exige perfil ${a.approval_role})` : ""}.`);
      const updated = DecisionActionService.approve(orgId, actionId, userId, { reason: reason || undefined });
      const msg = updated.status === "approved"
        ? "✅ Aprovado. A execução segue conforme a política."
        : "✅ Sua aprovação foi registrada. Ainda falta a de outro aprovador (política de dois passos).";
      return { action: updated, message: msg };
    }
    if (decision === "reject") {
      if (!DecisionActionService.canReject(orgId, user)) throw new Error("Você não tem permissão para rejeitar esta ação.");
      const updated = DecisionActionService.reject(orgId, actionId, userId, { reason: reason || undefined });
      return { action: updated, message: "🚫 Rejeitado. A ação não será executada." };
    }
    throw new Error("Decisão inválida (use approve ou reject).");
  }
}
