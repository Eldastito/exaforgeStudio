import db from "./db.js";
import { randomUUID } from "crypto";

/**
 * ApprovalPolicyService (ADR-136, Epic 2 — C2).
 *
 * Decide se uma ação pode ser preparada, aprovada por 1, por perfil, ou por 2
 * pessoas (two_step). Determinístico: usa a política da organização
 * (`agent_policies`) quando existe; senão a MATRIZ PADRÃO do PRD §10.2. Nunca
 * "execute" automático nesta fatia — o mais alto é preparar/aprovar.
 *
 * ADR-159 F3 (D4) — Autonomy Contract de 1ª classe: `resolveContract` devolve um
 * dos 4 ESTADOS (permitido/requer aprovação/escalonar/bloqueado) a partir de
 * BANDAS valor→papel (`agent_policies.config_json.bands`), com ponte pro modelo
 * legado (max_auto_amount/approval_role) e opinião de default-deny p/ ações
 * financeiras/destrutivas sem política (RN-159-1). Estende o service — sem engine
 * de governança paralelo (RN-159-4).
 */

export type ApprovalPolicy = "none" | "single" | "role" | "two_step";

// ADR-159 F3 — os 4 estados do Autonomy Contract (Estado Final §16).
export type AutonomyState = "allow" | "require_approval" | "escalate" | "deny";
const AUTONOMY_STATES = new Set<AutonomyState>(["allow", "require_approval", "escalate", "deny"]);

/** Uma banda valor→papel: até `upTo` (null = teto/sem limite) → `state` (+ `role`). */
export interface AutonomyBand { upTo: number | null; state: AutonomyState; role?: string | null; }

// Ações financeiras/destrutivas: default-deny quando NÃO há política/banda
// resolvida (RN-159-1). Conservador — dinheiro que sai + destrutivo irreversível.
const FINANCIAL_OR_DESTRUCTIVE = new Set([
  "refund", "issue_payment", "change_price", "choose_supplier", "create_purchase_order",
  "delete_record", "cancel_subscription", "asaas_pix_charge",
]);

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
  // ADR-167 F11 — publicação social exige aprovação humana por padrão (governança
  // on por default; o Autonomy Contract pode liberar/bloquear por banda).
  social_publish: { policy: "single" },
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

  /**
   * A ação é financeira/destrutiva? Fonte ÚNICA da definição de "crítico"
   * (reusada pelo default-deny do resolveContract e pelo step-up MFA da F6).
   */
  static isFinancialOrDestructive(domain: string, actionType: string): boolean {
    return FINANCIAL_OR_DESTRUCTIVE.has(actionType) || domain === "finance";
  }

  /**
   * ADR-159 F3 (D4) — resolve o ESTADO do Autonomy Contract para (domínio, tipo,
   * valor). Ordem de precedência:
   *   1) BANDAS valor→papel (`config_json.bands`) — o modelo D4 de 1ª classe.
   *      A 1ª banda cujo teto (`upTo`) cobre o valor decide (null = teto final).
   *      `enforced=true`: o `propose` PASSA A IMPOR este estado (opt-in — só
   *      quando o dono configurou bandas).
   *   2) Ponte LEGADA: `max_auto_amount` + `approval_role`. Acima do teto →
   *      escalonar (se há papel) / requer aprovação; dentro → permitido.
   *      `enforced=false` (advisória — não muda o fluxo pré-F3).
   *   3) Sem política: default-deny p/ financeiro/destrutivo (RN-159-1), senão
   *      "requer aprovação" por padrão. `enforced=false` (opinião; o enforcement
   *      geral do default-deny é o D3/F4 sob flag).
   */
  static resolveContract(orgId: string, input: { domain: string; actionType: string; amount?: number | null }): {
    state: AutonomyState; requiredRole: string | null; band: AutonomyBand | null; reason: string; enforced: boolean;
  } {
    const cfg = db.prepare("SELECT approval_role, max_auto_amount, active, config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?")
      .get(orgId, input.domain, input.actionType) as any;
    const amount = Math.abs(Number(input.amount) || 0);

    // 1) Bandas explícitas.
    let bands: AutonomyBand[] | null = null;
    if (cfg?.config_json) { try { const c = JSON.parse(cfg.config_json); if (Array.isArray(c?.bands) && c.bands.length) bands = c.bands; } catch { /* config torto → ignora bandas */ } }
    if (bands) {
      const sorted = [...bands].sort((a, b) => (a.upTo == null ? Infinity : Number(a.upTo)) - (b.upTo == null ? Infinity : Number(b.upTo)));
      const match = sorted.find((b) => b.upTo == null || amount <= Number(b.upTo)) || sorted[sorted.length - 1];
      const state: AutonomyState = AUTONOMY_STATES.has(match.state) ? match.state : "require_approval";
      return { state, requiredRole: match.role ?? cfg.approval_role ?? null, band: match, reason: `banda valor→papel (valor=${amount})`, enforced: true };
    }

    // 2) Ponte legada (max_auto_amount / approval_role).
    if (cfg && Number(cfg.active)) {
      if (cfg.max_auto_amount != null && amount > Number(cfg.max_auto_amount)) {
        return { state: cfg.approval_role ? "escalate" : "require_approval", requiredRole: cfg.approval_role ?? null, band: null, reason: `acima do teto de automação (${cfg.max_auto_amount})`, enforced: false };
      }
      return { state: "allow", requiredRole: null, band: null, reason: "dentro do teto de automação", enforced: false };
    }

    // 3) Sem política resolvida.
    const risky = FINANCIAL_OR_DESTRUCTIVE.has(input.actionType) || input.domain === "finance";
    return risky
      ? { state: "deny", requiredRole: null, band: null, reason: "ação financeira/destrutiva sem política resolvida (default-deny, RN-159-1)", enforced: false }
      : { state: "require_approval", requiredRole: null, band: null, reason: "sem política — requer aprovação por padrão", enforced: false };
  }

  /**
   * ADR-159 F3 — grava/atualiza as bandas valor→papel de uma (domínio, tipo) em
   * `config_json.bands` (upsert idempotente da linha de `agent_policies`, sem
   * tocar autonomy_level/execution_mode). Ligar bandas é o opt-in do enforcement.
   */
  static setBands(orgId: string, domain: string, actionType: string, bands: AutonomyBand[]): void {
    const cur = db.prepare("SELECT id, config_json FROM agent_policies WHERE organization_id = ? AND domain = ? AND action_type = ?").get(orgId, domain, actionType) as any;
    let config: any = {};
    if (cur?.config_json) { try { config = JSON.parse(cur.config_json) || {}; } catch { config = {}; } }
    config.bands = bands;
    if (cur) db.prepare("UPDATE agent_policies SET config_json = ? WHERE id = ?").run(JSON.stringify(config), cur.id);
    else db.prepare("INSERT INTO agent_policies (id, organization_id, domain, action_type, autonomy_level, active, config_json) VALUES (?, ?, ?, ?, 'suggest', 1, ?)").run(randomUUID(), orgId, domain, actionType, JSON.stringify(config));
  }
}

export default ApprovalPolicyService;
