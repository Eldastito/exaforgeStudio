/**
 * ReputationRecoveryService (ADR-162 / PRD 5 §22-§24, F6) — o RECOVERY PLAYBOOK:
 * transforma a INVESTIGAÇÃO (F5) num PLANO de recuperação — ações RECOMENDADAS —
 * SEM efeito externo. Não envia mensagem, não reembolsa, não reexpede: apenas PROPÕE
 * ações no ledger governado (`DecisionActionService.propose`, domínio 'recovery'), que
 * já as submete à `ApprovalPolicyService`/Autonomy Contract. A execução material é
 * fatia posterior (F8 resposta pública / F9 resolução) — aqui paramos na recomendação.
 *
 * A ESTRATÉGIA sai da epistemologia da F5 (§22-24, níveis de automação conservadores):
 *   - HIGH-RISK (F4) → só `internal_handoff` (apuração humana). NUNCA propõe resposta
 *     pública ou reembolso autônomo num caso de acidente/fraude/LGPD (RN-CRR-4).
 *   - GROUNDED (reclamação CORROBORADA por fato interno) → remediação material por
 *     categoria (reexpedição / reembolso / encaminhar atendimento) + contato privado.
 *   - ALEGAÇÃO sem lastro (grounding 'unsupported') → contato privado primeiro (ouvir/
 *     esclarecer) — não se age sobre alegação não verificada (RN-CRR-2/3); escala se sério.
 *
 * Guardrails duros:
 *   - SEM EFEITO EXTERNO: `propose` só grava a ação; nenhum provider/executor é chamado.
 *   - NÃO INVENTA DINHEIRO (RN-CRR-7): reembolso vai com `expectedImpact=null` e payload
 *     marcando `missing:['amount']` — o valor é do humano. A reexpedição referencia o
 *     PEDIDO REAL da evidência (fato), nunca um id fabricado (RN-151).
 *   - FINANCEIRO É DEFAULT-DENY: `refund` sem política de autonomia é BLOQUEADO pela
 *     `resolveContract` (RN-159-1) — o plano expõe "bloqueado, requer política/humano",
 *     em vez de auto-aprovar. Nunca cria segundo gate (D5).
 *   - IDEMPOTENTE: reusa a ação de recovery já aberta pro mesmo sinal+tipo (re-recomendar
 *     não duplica o ledger).
 * Determinístico (roda em CI). Isolado por org (RN-CRR-9). Não age.
 */
import db from "./db.js";
import { ReputationInvestigationService } from "./ReputationInvestigationService.js";
import { DecisionActionService } from "./DecisionActionService.js";

type Strategy = "high_risk_handoff" | "grounded_remediation" | "claim_outreach";

interface ActionSpec {
  actionType: string;
  title: string;
  commandType: string | null;   // o que SERIA feito na execução (F8/F9) — aqui só descreve
  buildPayload?: (facts: any) => any;
}

// Remediação material por CATEGORIA — usada SÓ quando a reclamação é corroborada
// (grounded). Cada uma referencia fato real (pedido) quando aplicável; nunca inventa.
const MATERIAL_BY_CATEGORY: Record<string, ActionSpec[]> = {
  delivery: [{ actionType: "order_reship", title: "Reexpedir o pedido não entregue", commandType: "order_reship", buildPayload: (f) => reshipPayload(f) }],
  wrong_order: [{ actionType: "order_reship", title: "Corrigir/reenviar itens do pedido", commandType: "order_reship", buildPayload: (f) => reshipPayload(f) }],
  product_defect: [{ actionType: "order_reship", title: "Reenviar produto (troca por defeito)", commandType: "order_reship", buildPayload: (f) => reshipPayload(f) }],
  // Reembolso é FINANCEIRO → default-deny sem política (surfacado como bloqueado).
  refund_billing: [{ actionType: "refund", title: "Processar reembolso/estorno (requer política/aprovação)", commandType: "refund_request", buildPayload: () => ({ amount: null, missing: ["amount"] }) }],
  service_quality: [{ actionType: "ticket_assign", title: "Encaminhar atendimento a um responsável", commandType: "ticket_assign" }],
};

function reshipPayload(facts: any): any {
  const order = (facts?.orders || [])[0] || null;
  return order ? { orderId: order.sourceId, missing: [] } : { orderId: null, missing: ["orderId"] };
}

export interface RecommendedAction {
  actionType: string;
  title: string;
  commandType: string | null;
  actionId: string | null;
  status: string;                 // approved | awaiting_approval | blocked | reused
  approvalPolicy?: string | null;
  requiredRole?: string | null;
  blocked?: boolean;
  reason?: string | null;
  conditional?: boolean;          // pendente de verificação (caso sem lastro)
}

export interface RecoveryPlan {
  signalId: string;
  found: boolean;
  category: string;
  highRisk: boolean;
  escalate: boolean;
  grounding: string;              // grounded | unsupported | skipped (da F5)
  corroborated: boolean;
  strategy: Strategy;
  recommendedActions: RecommendedAction[];
  note: string;
  generatedAt: string;
}

export class ReputationRecoveryService {
  static recommend(orgId: string, signalId: string, opts: { now?: number } = {}): RecoveryPlan | null {
    const inv = ReputationInvestigationService.investigate(orgId, signalId, { now: opts.now });
    if (!inv) return null;

    // Contato conhecido? (a F3 re-sujeitou). Vai nos payloads de contato.
    const contactId = (db.prepare(
      `SELECT subject_id FROM business_signals WHERE organization_id = ? AND id = ? AND subject_type = 'contact'`
    ).get(orgId, signalId) as any)?.subject_id || null;
    const facts = { orders: (inv.facts || []).filter((f) => f.service === "orders"), contactId };

    // ── Estratégia (§22-24) ──
    let strategy: Strategy;
    const specs: ActionSpec[] = [];
    const outreach: ActionSpec = {
      actionType: "customer_private_message", title: "Contato privado com o cliente",
      commandType: "customer_private_message", buildPayload: () => ({ contactId, channel: null, message: null, missing: ["message"] }),
    };
    const handoff: ActionSpec = { actionType: "internal_handoff", title: "Encaminhar para apuração humana", commandType: null, buildPayload: () => ({ contactId }) };

    if (inv.highRisk) {
      strategy = "high_risk_handoff";
      specs.push(handoff); // RN-CRR-4 — nada de público/financeiro autônomo
    } else if (inv.grounding.corroboratedByInternalFact) {
      strategy = "grounded_remediation";
      specs.push(...(MATERIAL_BY_CATEGORY[inv.category] || []), outreach);
    } else {
      strategy = "claim_outreach";
      specs.push(outreach);
      if (inv.escalate) specs.push(handoff); // sério + sem lastro → também apura
    }

    const recommendedActions = specs.map((s) => this.proposeOne(orgId, signalId, s, facts, inv, strategy));

    const note = strategy === "high_risk_handoff"
      ? "Caso de alto risco: recomendado apenas encaminhamento humano. IA não propõe resposta pública nem reembolso autônomo (RN-CRR-4)."
      : strategy === "grounded_remediation"
        ? "Reclamação corroborada por fato interno: remediação recomendada, ainda sujeita à política de aprovação. Nenhum efeito externo aqui."
        : "Sem corroboração interna: recomendado contato para esclarecer antes de qualquer remediação (alegação ≠ fato, RN-CRR-2).";

    return {
      signalId, found: true, category: inv.category, highRisk: inv.highRisk, escalate: inv.escalate,
      grounding: inv.grounding.status, corroborated: inv.grounding.corroboratedByInternalFact,
      strategy, recommendedActions, note, generatedAt: new Date(opts.now || Date.now()).toISOString(),
    };
  }

  /**
   * Propõe UMA ação no ledger governado. Idempotente (reusa ação aberta do mesmo
   * sinal+tipo). Captura o default-deny financeiro (RN-159-1) como `blocked` — nunca
   * deixa a exceção derrubar o plano. Sem efeito externo (propose só grava).
   */
  private static proposeOne(orgId: string, signalId: string, spec: ActionSpec, facts: any, inv: any, strategy: Strategy): RecommendedAction {
    // Dedupe: já existe ação de recovery aberta pra este sinal+tipo?
    const existing = db.prepare(
      `SELECT id, status, approval_policy, approval_role FROM decision_actions
       WHERE organization_id = ? AND signal_id = ? AND action_type = ? AND domain = 'recovery'
         AND status NOT IN ('rejected','cancelled','done') ORDER BY created_at DESC LIMIT 1`
    ).get(orgId, signalId, spec.actionType) as any;
    if (existing) {
      return { actionType: spec.actionType, title: spec.title, commandType: spec.commandType, actionId: existing.id, status: "reused", approvalPolicy: existing.approval_policy, requiredRole: existing.approval_role, conditional: strategy === "claim_outreach" };
    }
    try {
      const action = DecisionActionService.propose(orgId, {
        signalId,
        domain: "recovery",
        actionType: spec.actionType,
        title: spec.title,
        description: inv.headline,
        basis: "hypothesis",          // recomendação derivada de causa provável (§13)
        confidence: inv.confidence,
        expectedImpact: null,         // RN-CRR-7 — não inventa dinheiro
        commandType: spec.commandType,
        commandPayload: spec.buildPayload ? spec.buildPayload(facts) : null,
        createdBy: "reputation_recovery",
      });
      return {
        actionType: spec.actionType, title: spec.title, commandType: spec.commandType,
        actionId: action.id, status: action.status, approvalPolicy: action.approval_policy, requiredRole: action.approval_role,
        conditional: strategy === "claim_outreach",
      };
    } catch (e: any) {
      // default-deny (financeiro/destrutivo sem política) e afins → bloqueado, não erro.
      return { actionType: spec.actionType, title: spec.title, commandType: spec.commandType, actionId: null, status: "blocked", blocked: true, reason: String(e?.message || e) };
    }
  }
}

export default ReputationRecoveryService;
