import db from "./db.js";
import { phoneMatches } from "./phoneMatch.js";
import { PermissionService } from "./PermissionService.js";
import { FinancialLedgerService } from "./FinancialLedgerService.js";
import { ImpactPrioritizationService } from "./ImpactPrioritizationService.js";
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

export type GestorIntent = "menu" | "saldo" | "a_receber" | "a_pagar" | "prioridades" | "acao_diferida" | "desconhecido";

export interface GestorResult { handled: boolean; reply: string; intent: GestorIntent; denied?: boolean; user?: { id: string; name: string } | null }

export class GestorCommandService {
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
  static parse(text: string): { intent: GestorIntent } {
    const m = String(text || "").trim().toLowerCase();
    if (!m || /^(oi|ol[áa]|menu|ajuda|help|bom dia|boa tarde|boa noite|comandos?)$/.test(m)) return { intent: "menu" };
    if (/(^|\b)(saldo|caixa|quanto tenho|dinheiro)(\b|$)/.test(m)) return { intent: "saldo" };
    if (/(a\s*receber|receb[ií]veis|vencidos?|cobran[çc]a)/.test(m)) return { intent: "a_receber" };
    if (/(a\s*pagar|pagar|contas? a pagar|fornecedor)/.test(m)) return { intent: "a_pagar" };
    if (/(prioridade|o que.*(fazer|atacar)|hoje|foco)/.test(m)) return { intent: "prioridades" };
    if (/^(aprovar|aprova|delegar|delega|adiar|adia|dispensar|dispensa|rejeitar|rejeita|explicar|explica)\b/.test(m)) return { intent: "acao_diferida" };
    return { intent: "desconhecido" };
  }

  private static menu(name: string): string {
    return `Olá${name ? `, ${name}` : ""}! Sou o *Controller IA* 📊\nConsulte o negócio por aqui:\n\n• *saldo* — caixa atual\n• *a receber* — recebíveis e vencidos\n• *a pagar* — contas em aberto\n• *prioridades* — o que atacar hoje\n\n(As ações — aprovar, dispensar — ficam no *Plano de Ação* do painel por enquanto.)`;
  }

  /** Consulta financeira exige leitura no módulo `financeiro` (RBAC, Epic 0). */
  private static canFinance(orgId: string, user: any): boolean {
    return PermissionService.can(orgId, user, "financeiro", "read");
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
    const { intent } = this.parse(text);
    try { logAuthEvent(orgId, user.id, null, "WA_GESTOR_COMMAND", { intent, from: fromNumber }); } catch { /* noop */ }

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
      return { handled: true, reply: "As ações por aqui (aprovar, dispensar, delegar, adiar) entram *em breve* — por enquanto use o *Plano de Ação* no painel, onde cada ação passa pela sua política de aprovação.", intent, user: { id: user.id, name: user.name } };
    }

    if (intent === "desconhecido") {
      return { handled: true, reply: `Não entendi. 🤔\n${this.menu(name)}`, intent, user: { id: user.id, name: user.name } };
    }

    return { handled: true, reply: this.menu(name), intent: "menu", user: { id: user.id, name: user.name } };
  }
}

export default GestorCommandService;
