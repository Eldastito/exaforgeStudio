/**
 * UxPresentationService — PRD 6 / ADR-163 F4 (§9, §39-44): Progressive disclosure.
 *
 * É FORMA, não fonte (D1/CA17): não lê engine novo, não cria alerta, não decide
 * política. Recebe uma ação/estado que JÁ existe (`decision_actions`, atenção) e
 * devolve o "Decision Card" canônico — significado ANTES do detalhe (§39/CA12),
 * com o detalhe sempre acessível (CA13). Composto por três primitivas puras:
 *
 *   - `humanState(status)` — mapa determinístico técnico→humano (§41): open→"Identificado",
 *     awaiting_approval→"Precisa de você", executing→"Em andamento", done→"Concluído",
 *     failed→"Não deu certo". NUNCA esconde a falha (RN-UX-4/§44) — `failed` tem estado
 *     próprio, visível, com tom de alerta.
 *   - `humanError(err)` — erro técnico vira mensagem humana + SEMPRE `hasDetails:true` e o
 *     `technical` preservado pra "ver detalhes" (§44 — simplicidade não mente; sem dark pattern).
 *   - `card(orgId, action, user)` — o cartão: o-quê / por-quê / impacto / recomendo / posso-fazer
 *     / regra. Escopo por papel (RN-UX-2): domínio invisível → `null`; dinheiro é role-gated
 *     (§73) — quem não tem visão completa vê que HÁ impacto, não o valor (`restricted:true`,
 *     nunca some com o fato). `canDo` deriva do status + RBAC real (reusa
 *     `DecisionActionService.canApprove/canReject` — a mesma porta, nenhuma superfície burla).
 *
 * Tudo derivado/puro (RN-004), sem tabela nova, sem flag nova (o frontend usa a
 * `invisible_ux_enabled` da F3 pra decidir se renderiza o cartão).
 */
import { DecisionActionService } from "./DecisionActionService.js";
import { ContextProjectionService } from "./ContextProjectionService.js";

export type StateTone = "identified" | "needs_you" | "ready" | "in_progress" | "done" | "failed" | "closed";
export interface HumanState { key: string; label: string; tone: StateTone; hint: string }

// Mapa único técnico→humano (§41). Cobre sinais, ações e execução/processo.
// `failed` é de PRIMEIRA CLASSE e visível — RN-UX-4 proíbe escondê-lo.
const STATE_MAP: Record<string, HumanState> = {
  // Sinais
  open: { key: "open", label: "Identificado", tone: "identified", hint: "Detectamos algo que merece atenção." },
  acknowledged: { key: "acknowledged", label: "Ciente", tone: "closed", hint: "Você já viu; sem ação pendente." },
  // Ações — ciclo de decisão
  proposed: { key: "proposed", label: "Precisa de você", tone: "needs_you", hint: "Aguarda a sua decisão." },
  awaiting_approval: { key: "awaiting_approval", label: "Precisa de você", tone: "needs_you", hint: "Aguarda a sua aprovação." },
  approved: { key: "approved", label: "Aprovado — pronto", tone: "ready", hint: "Aprovado; pronto pra executar/concluir." },
  rejected: { key: "rejected", label: "Recusado", tone: "closed", hint: "Decidiu não seguir." },
  cancelled: { key: "cancelled", label: "Cancelado", tone: "closed", hint: "Interrompido antes de concluir." },
  // Execução / processo
  planned: { key: "planned", label: "Em preparação", tone: "ready", hint: "Preparando pra executar." },
  authorized: { key: "authorized", label: "Em preparação", tone: "ready", hint: "Autorizado; entrando na fila." },
  queued: { key: "queued", label: "Em preparação", tone: "ready", hint: "Na fila de execução." },
  executing: { key: "executing", label: "Em andamento", tone: "in_progress", hint: "Executando agora." },
  waiting_external_response: { key: "waiting_external_response", label: "Em andamento", tone: "in_progress", hint: "Aguardando resposta externa." },
  completed: { key: "completed", label: "Concluído", tone: "done", hint: "Feito." },
  measured: { key: "measured", label: "Concluído", tone: "done", hint: "Feito e medido." },
  done: { key: "done", label: "Concluído", tone: "done", hint: "Feito." },
  resolved: { key: "resolved", label: "Resolvido", tone: "done", hint: "Encerrado com resolução." },
  // Falha — NUNCA escondida (§44/RN-UX-4)
  failed: { key: "failed", label: "Não deu certo", tone: "failed", hint: "A execução falhou; veja os detalhes." },
  // Encerramentos passivos
  expired: { key: "expired", label: "Expirou", tone: "closed", hint: "Perdeu a validade sem ação." },
  dismissed: { key: "dismissed", label: "Descartado", tone: "closed", hint: "Marcado como não relevante." },
};
const STATE_UNKNOWN: HumanState = { key: "unknown", label: "Em análise", tone: "identified", hint: "Estado ainda não classificado." };

// Erro técnico → humano. Ordem importa (do mais específico ao genérico). Cada
// entrada mantém a promessa: mensagem clara, mas o técnico continua acessível.
const ERROR_RULES: Array<{ re: RegExp; category: string; message: string }> = [
  { re: /SQLITE_CONSTRAINT_UNIQUE|UNIQUE constraint/i, category: "duplicate", message: "Esse item já existe — não foi duplicado." },
  { re: /não está aguardando aprovação|não pode ser rejeitada|já finalizada|Só conclui/i, category: "state", message: "Esse item mudou de estado — recarregue e tente de novo." },
  { re: /permiss|forbidden|não autoriz|unauthorized|403|401/i, category: "permission", message: "Você não tem permissão pra isso." },
  { re: /bloquead[ao] pela política de autonomia/i, category: "policy", message: "A política de autonomia bloqueou esta ação." },
  { re: /identificad|usuário identificado/i, category: "identity", message: "Precisamos de um usuário identificado pra registrar essa decisão." },
  { re: /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|network|fetch failed/i, category: "network", message: "A conexão falhou. Tente novamente em instantes." },
];

export class UxPresentationService {
  /** Estado técnico → humano (§41). Determinístico, sem DB. `failed` é visível. */
  static humanState(status: string | null | undefined): HumanState {
    if (!status) return STATE_UNKNOWN;
    return STATE_MAP[String(status)] || STATE_UNKNOWN;
  }

  /** Erro técnico → { message humano, category, hasDetails, technical }. Nunca engole (§44). */
  static humanError(err: unknown): { message: string; category: string; hasDetails: boolean; technical: string } {
    const technical = err instanceof Error ? err.message : String(err ?? "");
    const hit = ERROR_RULES.find((r) => r.re.test(technical));
    return {
      message: hit ? hit.message : "Algo não saiu como esperado.",
      category: hit ? hit.category : "unknown",
      hasDetails: true,        // SEMPRE — o técnico fica atrás de "ver detalhes", nunca some.
      technical,
    };
  }

  /** Faixa de confiança humana (§64) — evita expor score cru. */
  static confidenceBand(confidence: number | null | undefined): "alta" | "média" | "baixa" | null {
    if (confidence == null) return null;
    const c = Number(confidence);
    if (Number.isNaN(c)) return null;
    if (c >= 0.8) return "alta";
    if (c >= 0.5) return "média";
    return "baixa";
  }

  /**
   * Decision Card canônico sobre UMA ação. `null` se o domínio é invisível ao papel
   * (RN-UX-2). Dinheiro role-gated (§73): sem visão completa, `impact.amount=null` +
   * `restricted:true` (o fato do impacto permanece; só o valor é reservado ao gestor).
   */
  static card(orgId: string, action: any, user: any): any | null {
    if (!action) return null;
    const domain = action.domain || null;
    if (!ContextProjectionService.canSeeDomain(orgId, user, domain)) return null;
    const fullVisibility = ContextProjectionService.hasFullBusinessVisibility(orgId, user);
    const state = this.humanState(action.status);

    // Impacto — role-gated (§73). Nunca esconde que HÁ impacto; gate só o número.
    const hasImpact = action.expected_impact != null;
    const impact = hasImpact
      ? (fullVisibility
        ? { amount: Number(action.expected_impact), unit: action.impact_unit || "BRL", restricted: false }
        : { amount: null, unit: action.impact_unit || "BRL", restricted: true })
      : { amount: null, unit: null, restricted: false };

    // Posso-fazer — deriva do status + RBAC real (mesma porta que a rota usa).
    const canDo: string[] = [];
    if (action.status === "awaiting_approval" || action.status === "proposed") {
      if (DecisionActionService.canApprove(orgId, user, action)) canDo.push("approve");
      if (DecisionActionService.canReject(orgId, user)) canDo.push("reject");
    } else if (action.status === "approved") {
      canDo.push("complete", "cancel");
    }

    return {
      id: action.id,
      what: action.title || action.action_type || "Ação",
      why: {
        text: action.description || null,
        basis: action.basis || null,                     // fato | estimativa | influenciado
        confidenceBand: this.confidenceBand(action.confidence),
        signalId: action.signal_id || null,              // rastro pra evidência (drill-down §71)
        correlationId: action.correlation_id || null,
      },
      impact,
      recommendation: this.recommendation(action, canDo),
      canDo,
      rule: this.ruleText(action),                       // transparência da regra que governa (§40)
      state,
      domain,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Cartões das ações que pedem atenção (aprovação + decisão + aprovadas), já role-scoped. */
  static cards(orgId: string, user: any, opts: { statuses?: string[]; limit?: number } = {}): any[] {
    const statuses = opts.statuses || ["awaiting_approval", "proposed", "approved"];
    const out: any[] = [];
    for (const st of statuses) {
      for (const a of DecisionActionService.list(orgId, { status: st })) {
        const c = this.card(orgId, a, user);
        if (c) out.push(c);
      }
    }
    return out.slice(0, opts.limit || 50);
  }

  /** Recomendação humana — o próximo passo sugerido, sem forçar (advisória, §40). */
  private static recommendation(action: any, canDo: string[]): string {
    switch (action.status) {
      case "awaiting_approval":
        return canDo.includes("approve") ? "Revise e aprove se fizer sentido." : "Aguardando quem tem permissão pra aprovar.";
      case "proposed":
        return "Decida se seguimos com esta ação.";
      case "approved":
        return "Pronto pra executar ou concluir.";
      case "failed":
        return "Veja o motivo da falha e decida se repete.";
      case "done":
      case "resolved":
        return "Concluído — nada a fazer.";
      default:
        return "Sem ação pendente sua.";
    }
  }

  /** Regra que governa a ação, em linguagem clara (§40 — transparência, não jargão). */
  private static ruleText(action: any): string {
    const role = action.approval_role ? String(action.approval_role) : null;
    switch (action.approval_policy) {
      case "none": return "Ação autônoma — não exige aprovação (o executor ainda passa pelos guardas).";
      case "single": return "Exige 1 aprovação.";
      case "role": return role ? `Exige aprovação do perfil "${role}".` : "Exige aprovação de um perfil específico.";
      case "two_step": return "Exige 2 aprovações de pessoas distintas.";
      default: return "Segue a política de aprovação padrão.";
    }
  }
}

export default UxPresentationService;
