import db from "./db.js";

/**
 * ApprovalPolicyService (ADR-136, Epic 2 — C2).
 *
 * Decide se uma ação pode ser preparada, aprovada por 1, por perfil, ou por 2
 * pessoas (two_step). Determinístico: usa a política da organização
 * (`agent_policies`) quando existe; senão a MATRIZ PADRÃO do PRD §10.2. Nunca
 * "execute" automático nesta fatia — o mais alto é preparar/aprovar.
 */

export type ApprovalPolicy = "none" | "single" | "role" | "two_step";

// Matriz padrão por tipo de ação (PRD §10.2). Chave = action_type.
const DEFAULTS: Record<string, { policy: ApprovalPolicy; role?: string }> = {
  create_task: { policy: "none" },
  internal_reminder: { policy: "none" },
  register_financial_plan: { policy: "none" },
  prepare_campaign: { policy: "single" },
  send_campaign: { policy: "role", role: "admin" },
  prepare_purchase: { policy: "single" },
  send_quote_request: { policy: "single" },
  collection: { policy: "single" },
  choose_supplier: { policy: "two_step" },
  create_purchase_order: { policy: "two_step" },
  change_price: { policy: "role", role: "owner" },
};

const DEFAULT_FALLBACK: { policy: ApprovalPolicy; role?: string } = { policy: "single" };

export class ApprovalPolicyService {
  /**
   * Resolve a política para (domínio, tipo, valor). Considera a config da org e,
   * quando `autonomy_level` restringe, endurece a política (observe/suggest não
   * podem ser 'none'). `max_auto_amount` eleva para aprovação quando excedido.
   */
  static resolve(orgId: string, input: { domain: string; actionType: string; expectedImpact?: number | null }): { policy: ApprovalPolicy; requiredRole: string | null; autonomy: string } {
    const base = DEFAULTS[input.actionType] || DEFAULT_FALLBACK;
    let policy: ApprovalPolicy = base.policy;
    let requiredRole: string | null = base.role || null;
    let autonomy = "suggest";

    const cfg = db.prepare("SELECT autonomy_level, approval_role, max_auto_amount, active FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?")
      .get(orgId, input.domain, input.actionType) as any;
    if (cfg && Number(cfg.active)) {
      autonomy = String(cfg.autonomy_level || "suggest");
      if (cfg.approval_role) requiredRole = String(cfg.approval_role);
      // Autonomia mais baixa nunca reduz a exigência de aprovação abaixo de 'single'.
      if ((autonomy === "observe" || autonomy === "suggest") && policy === "none") policy = "single";
      // Valor acima do teto de automação → exige aprovação.
      const amount = Math.abs(Number(input.expectedImpact) || 0);
      if (cfg.max_auto_amount != null && amount > Number(cfg.max_auto_amount) && policy === "none") policy = "single";
      if (requiredRole && policy === "single") policy = "role";
    }
    return { policy, requiredRole, autonomy };
  }

  /** Quantas aprovações distintas a política exige (two_step = 2, none = 0). */
  static requiredApprovals(policy: ApprovalPolicy): number {
    return policy === "two_step" ? 2 : policy === "none" ? 0 : 1;
  }
}

export default ApprovalPolicyService;
