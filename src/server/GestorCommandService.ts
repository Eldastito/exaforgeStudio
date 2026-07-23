import db from "./db.js";
import { phoneMatches } from "./phoneMatch.js";
import { PermissionService } from "./PermissionService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
import { DecisionActionService } from "./DecisionActionService.js";
import { logAuthEvent } from "./auditLog.js";

/**
 * GestorCommandService — WhatsApp como interface de GESTÃO (Epic 3, PRD §14).
 *
 * O gestor consulta o negócio pelo WhatsApp ("saldo", "a receber", "prioridades")
 * com os dados vindo do núcleo seguro. Esta fatia é DETERMINÍSTICA e SÓ LEITURA:
 *   - autenticação do NÚMERO (só responde a `users.phone` da própria org);
 *   - RBAC: consulta financeira exige permissão no módulo `financeiro`
 *     (aceite do PRD: "usuário sem permissão não recebe DRE ou retiradas");
 *   - comandos de AÇÃO (aprovar/dispensar/delegar/adiar) são reconhecidos, mas
 *     NÃO executam nada aqui — respondem que a ação sai pelo painel (a execução
 *     governada vem na fatia seguinte, já sob a política do Epic 2).
 * Opt-in por organização (`wa_gestor_enabled`). Auditável. Não envia nada — só
 * devolve o texto de resposta; quem envia é o chamador (webhook).
 */

const brl = (n: any) => `R$ ${(Number(n) || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type GestorIntent = "menu" | "saldo" | "a_receber" | "a_pagar" | "prioridades" | "aprovacoes" | "aprovar" | "rejeitar" | "acao_diferida" | "desconhecido";

export interface GestorResult { handled: boolean; reply: string; intent: GestorIntent; denied?: boolean; user?: { id: string; name: string } | null }

export class GestorCommandService {
  // Memória curta: última lista de aprovações enviada por (org, usuário) — para
  // resolver "aprovar 2" contra o que foi numerado (como o Coordenador faz).
  private static lastActions = new Map<string, { ids: string[] }>();

  // Intents que o Controller "possui" no canal interno — o webhook roteia só
  // estes para cá; menu/greeting/desconhecido caem no Coordenador (tarefas).
  static ROUTED_INTENTS: GestorIntent[] = ["saldo", "a_receber", "a_pagar", "prioridades", "aprovacoes", "aprovar", "rejeitar", "acao_diferida"];

  /** O webhook deve entregar esta mensagem ao Controller (em vez do Coordenador)? */
  static shouldRoute(r: GestorResult): boolean {
    return !!(r && r.handled && r.user && this.ROUTED_INTENTS.includes(r.intent));
  }

  static isEnabled(orgId: string): boolean {
    try { return !!Number((db.prepare("SELECT wa_gestor_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.wa_gestor_enabled); }
    catch { return false; }
  }

  /** Resolve o usuário-gestor pelo número (ativo, da própria org). */
  static resolveUser(orgId: string, fromNumber: string): any | null {
    const users = db.prepare("SELECT id, name, email, phone, role, role_profile_id FROM users WHERE organization_id = ? AND phone IS NOT NULL AND phone != '' AND COALESCE(global_status,'active') = 'active'").all(orgId) as any[];
    return users.find((u) => phoneMatches(u.phone, fromNumber)) || null;
  }

  /** Classifica o texto num intent determinístico (sem IA). */
  static parse(text: string): { intent: GestorIntent; index?: number } {
    const m = String(text || "").trim().toLowerCase();
    if (!m || /^(oi|ol[áa]|menu|ajuda|help|bom dia|boa tarde|boa noite|comandos?)$/.test(m)) return { intent: "menu" };
    let mm: RegExpMatchArray | null;
    // Ações numeradas primeiro (aprovar/dispensar N) — antes das consultas.
    if ((mm = m.match(/^(aprovar|aprova|aprovado)\s+(\d+)/))) return { intent: "aprovar", index: parseInt(mm[2], 10) };
    if ((mm = m.match(/^(dispensar|dispensa|rejeitar|rejeita|recusar|recusa)\s+(\d+)/))) return { intent: "rejeitar", index: parseInt(mm[2], 10) };
    if (/(aprova[çc][õo]es|aprovacoes|pend[êe]ncias|o que.*aprovar|aguardando aprova)/.test(m)) return { intent: "aprovacoes" };
    if (/(^|\b)(saldo|caixa|quanto tenho|dinheiro)(\b|$)/.test(m)) return { intent: "saldo" };
    if (/(a\s*receber|receb[ií]veis|vencidos?|cobran[çc]a)/.test(m)) return { intent: "a_receber" };
    if (/(a\s*pagar|pagar|contas? a pagar|fornecedor)/.test(m)) return { intent: "a_pagar" };
    // "prioridades" só com frase clara — evita colidir com pergunta de tarefas
    // do colaborador ("o que tenho pra fazer hoje") no canal interno.
    if (/(prioridades?|o que.*atacar|foco do dia)/.test(m)) return { intent: "prioridades" };
    // Delegar/adiar/explicar ainda são diferidos (sem execução nesta fatia).
    if (/^(delegar|delega|adiar|adia|explicar|explica)\b/.test(m)) return { intent: "acao_diferida" };
    return { intent: "desconhecido" };
  }

  private static menu(name: string): string {
    return `Olá${name ? `, ${name}` : ""}! Sou o *Controller IA* 📊\nConsulte e decida por aqui:\n\n• *saldo* — caixa atual\n• *a receber* — recebíveis e vencidos\n• *a pagar* — contas em aberto\n• *prioridades* — o que atacar hoje\n• *aprovações* — ações aguardando sua decisão\n• *aprovar 1* / *dispensar 2* — decidir uma ação da lista`;
  }

  /** Consulta financeira exige leitura no módulo `financeiro` (RBAC, Epic 0). */
  private static canFinance(orgId: string, user: any): boolean {
    return PermissionService.can(orgId, user, "financeiro", "read");
  }

  /** Só gestores (owner/admin) operam aprovações pelo WhatsApp — igual à rota. */
  private static isManager(user: any): boolean {
    return ["owner", "admin"].includes(String(user?.role));
  }

  /**
   * Processa uma mensagem do gestor. Retorna o texto de resposta (não envia).
   * `handled=false` quando a org não habilitou a interface (o webhook segue o
   * fluxo normal). Número desconhecido é recusado com aviso.
   */
  static handle(orgId: string, fromNumber: string, text: string): GestorResult {
    if (!this.isEnabled(orgId)) return { handled: false, reply: "", intent: "menu", user: null };
    const user = this.resolveUser(orgId, fromNumber);
    if (!user) {
      return { handled: true, reply: "Olá! Não reconheço este número. 🙋 Peça ao administrador para cadastrar seu WhatsApp em *Configurações → Usuários*.", intent: "menu", user: null };
    }
    const name = String(user.name || "").trim().split(/\s+/)[0] || "";
    const { intent, index } = this.parse(text);
    const key = `${orgId}:${user.id}`;
    try { logAuthEvent(orgId, user.id, null, "WA_GESTOR_COMMAND", { intent, from: fromNumber }); } catch { /* noop */ }

    // ── Aprovações governadas (Epic 2 / DecisionActionService) ──
    if (intent === "aprovacoes" || intent === "aprovar" || intent === "rejeitar") {
      if (!this.isManager(user)) {
        try { logAuthEvent(orgId, user.id, null, "WA_ACTION_DENIED", { intent }); } catch { /* noop */ }
        return { handled: true, reply: "Apenas gestores (dono/administrador) decidem ações por aqui.", intent, denied: true, user: { id: user.id, name: user.name } };
      }
      if (intent === "aprovacoes") {
        const pend = DecisionActionService.list(orgId, { status: "awaiting_approval" });
        this.lastActions.set(key, { ids: pend.map((a: any) => a.id) });
        const reply = pend.length
          ? `📝 *Aguardando sua decisão:*\n\n${pend.map((a: any, i: number) => `*${i + 1}.* ${a.title}${a.expected_impact != null ? ` (${brl(a.expected_impact)})` : ""}`).join("\n")}\n\nResponda *aprovar 1* ou *dispensar 1*.`
          : "✅ Nada aguardando aprovação no momento.";
        return { handled: true, reply, intent, user: { id: user.id, name: user.name } };
      }
      // aprovar/rejeitar N → resolve o índice contra a última lista enviada.
      const ids = this.lastActions.get(key)?.ids || DecisionActionService.list(orgId, { status: "awaiting_approval" }).map((a: any) => a.id);
      const id = index && index > 0 ? ids[index - 1] : undefined;
      if (!id) return { handled: true, reply: "Não achei essa ação. Manda *aprovações* que eu numero pra você.", intent, user: { id: user.id, name: user.name } };
      const action = DecisionActionService.get(orgId, id);
      // Aceite do PRD: só age em ação AINDA VÁLIDA e da MESMA organização.
      if (!action || action.status !== "awaiting_approval") {
        return { handled: true, reply: "Essa ação não está mais disponível para decisão (já resolvida ou cancelada).", intent, user: { id: user.id, name: user.name } };
      }
      if (intent === "aprovar") {
        // RBAC igual à rota: perfil exigido pela política; senão owner/admin.
        const required = action.approval_role;
        const ok = required ? (user.role === required || user.role === "owner") : ["owner", "admin"].includes(user.role);
        if (!ok) {
          try { logAuthEvent(orgId, user.id, null, "WA_ACTION_DENIED", { intent, actionId: id, required }); } catch { /* noop */ }
          return { handled: true, reply: `Esta aprovação exige o perfil *${required || "gestor"}*. Você não pode aprovar esta ação.`, intent, denied: true, user: { id: user.id, name: user.name } };
        }
        try {
          const r = DecisionActionService.approve(orgId, id, user.id, { reason: "aprovado via WhatsApp" });
          const reply = r.status === "approved"
            ? `✅ *Aprovada:* ${action.title}`
            : `👍 Registrei sua aprovação de *${action.title}*. Ainda falta outra aprovação (política de 2 pessoas).`;
          return { handled: true, reply, intent, user: { id: user.id, name: user.name } };
        } catch (e: any) { return { handled: true, reply: `Não consegui aprovar: ${e.message}`, intent, user: { id: user.id, name: user.name } }; }
      }
      // rejeitar
      try {
        DecisionActionService.reject(orgId, id, user.id, { reason: "dispensado via WhatsApp" });
        return { handled: true, reply: `🚫 *Dispensada:* ${action.title}`, intent, user: { id: user.id, name: user.name } };
      } catch (e: any) { return { handled: true, reply: `Não consegui dispensar: ${e.message}`, intent, user: { id: user.id, name: user.name } }; }
    }

    // Consultas financeiras: exigem RBAC de leitura em `financeiro`.
    if (intent === "saldo" || intent === "a_receber" || intent === "a_pagar") {
      if (!this.canFinance(orgId, user)) {
        try { logAuthEvent(orgId, user.id, null, "WA_FINANCE_DENIED", { intent }); } catch { /* noop */ }
        return { handled: true, reply: "Você não tem permissão para consultar dados financeiros por aqui. Fale com o gestor da conta.", intent, denied: true, user: { id: user.id, name: user.name } };
      }
      const s = FinancialLedgerService.summary(orgId);
      let reply = "";
      if (intent === "saldo") reply = `💰 *Caixa atual:* ${brl(s.caixaAtual)}\nA receber: ${brl(s.aReceber)} · A pagar: ${brl(s.aPagar)}`;
      else if (intent === "a_receber") reply = `📥 *A receber:* ${brl(s.aReceber)}\n(fiado ${brl(s.aReceberDetalhe?.fiado)} + contas ${brl(s.aReceberDetalhe?.manual)})${s.aReceberVencido ? `\n⚠️ Vencido: ${brl(s.aReceberVencido)}` : ""}`;
      else reply = `📤 *A pagar (em aberto):* ${brl(s.aPagar)}`;
      return { handled: true, reply, intent, user: { id: user.id, name: user.name } };
    }

    if (intent === "prioridades") {
      // Prioridades tocam finanças/operação → mesma exigência de leitura.
      if (!this.canFinance(orgId, user)) {
        try { logAuthEvent(orgId, user.id, null, "WA_FINANCE_DENIED", { intent }); } catch { /* noop */ }
        return { handled: true, reply: "Você não tem permissão para ver as prioridades do negócio por aqui.", intent, denied: true, user: { id: user.id, name: user.name } };
      }
      const top = (ImpactPrioritizationService.prioritize(orgId)?.global || []).slice(0, 3);
      const reply = top.length
        ? `🎯 *Prioridades de hoje:*\n\n${top.map((p: any, i: number) => `*${i + 1}.* ${p.recommendedAction}${p.impact ? ` (${p.impact.unit === "BRL" ? brl(p.impact.amount) : `${p.impact.amount} ${p.impact.unit || ""}`.trim()})` : ""}`).join("\n")}\n\n_Para agir, use o Plano de Ação no painel._`
        : "✅ Sem prioridades no momento. Quando surgirem sinais (caixa, recebíveis, estoque…), eles aparecem aqui.";
      return { handled: true, reply, intent, user: { id: user.id, name: user.name } };
    }

    if (intent === "acao_diferida") {
      return { handled: true, reply: "Delegar/adiar/explicar ainda ficam no *Plano de Ação* do painel por enquanto. Por aqui você já pode *aprovar* e *dispensar* — manda *aprovações* pra ver a lista.", intent, user: { id: user.id, name: user.name } };
    }

    if (intent === "desconhecido") {
      return { handled: true, reply: `Não entendi. 🤔\n${this.menu(name)}`, intent, user: { id: user.id, name: user.name } };
    }

    return { handled: true, reply: this.menu(name), intent: "menu", user: { id: user.id, name: user.name } };
  }
}

export default GestorCommandService;
