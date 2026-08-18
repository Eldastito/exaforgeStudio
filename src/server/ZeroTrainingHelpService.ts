/**
 * ZeroTrainingHelpService — PRD 6 / ADR-163 F7 (§30-§36): ajuda zero-training.
 *
 * RN-UX-1 (§115/CA17): NÃO é um assistente de navegação separado — É o Fala Tu
 * respondendo dúvida contextual. Este service é a camada DETERMINÍSTICA (§91-92 —
 * determinístico antes de LLM) que classifica a pergunta em intenção e COMPÕE a
 * resposta a partir dos engines que já existem; o LLM do Fala Tu é o fallback pro
 * que o determinístico não cobre. Nenhum motor/tabela/rota de ajuda paralela.
 *
 * Três verbos (§30-§33):
 *   - "ensine/o que é" → EXPLICA (usa `ModuleService.MODULE_META`), sem inventar;
 *   - "mostre/cadê"    → aponta EVIDÊNCIA (reusa `SmartInboxService` — já role-scoped);
 *   - "faça/quero"     → aponta o caminho GOVERNADO (reusa `ApprovalPolicyService` pra
 *                        dizer QUEM aprova) e deixa CLARO que não executa sozinho
 *                        (RN-UX-3/§27 — inferência/ajuda nunca autoriza política material);
 *   - "onde fica/abrir" → NAVEGA (reusa `NavigationManifestService`, respeitando plano/RBAC).
 *
 * Guardrails: role-scope (RN-UX-2); honestidade (RN-UX-4 — se o recurso não está no
 * plano/perfil, diz isso, não finge). Isolado por org.
 */
import db from "./db.js";
import { ModuleService } from "./ModuleService.js";
import { NavigationManifestService } from "./NavigationManifestService.js";
import { SmartInboxService } from "./SmartInboxService.js";
import { ApprovalPolicyService } from "./ApprovalPolicyService.js";
import { HelpKnowledgeService } from "./HelpKnowledgeService.js";

export type HelpIntent = "teach" | "show" | "do" | "navigate" | "unknown";

// Ações comuns → (actionType, domain) pra resolver a política que governa.
const DO_MAP: Array<{ re: RegExp; actionType: string; domain: string; label: string }> = [
  { re: /campanha|divulga|marketing/i, actionType: "prepare_campaign", domain: "sales", label: "campanha" },
  { re: /reembols|estorn/i, actionType: "refund", domain: "finance", label: "reembolso" },
  { re: /cobran|cobrar|receb/i, actionType: "collection", domain: "finance", label: "cobrança" },
  { re: /compra|comprar|fornecedor|pedido de compra/i, actionType: "prepare_purchase", domain: "procurement", label: "compra" },
  { re: /tarefa|lembrete|lembrar/i, actionType: "create_task", domain: "operations", label: "tarefa" },
];

// Superfícies de 1º nível (nav por necessidade da F2) — alvos de "onde fica / mostre".
const SURFACES: Record<string, { key: string; label: string }> = {
  hoje: { key: "hoje", label: "Hoje" },
  executando: { key: "executando", label: "Executando" },
  resultados: { key: "resultados", label: "Resultados" },
  empresa: { key: "empresa", label: "Empresa" },
};

export class ZeroTrainingHelpService {
  /** Classifica a pergunta e compõe a resposta. Determinístico, role-scoped. */
  static answer(orgId: string, user: any, input: { text: string; moduleKey?: string | null }): {
    intent: HelpIntent;
    message: string;
    module: { key: string; label: string; desc: string } | null;
    navTarget: { key: string; label: string; available: boolean } | null;
    evidence: { category: string; count: number } | null;
    governedBy: { actionType: string; policy: string; requiredRole: string | null } | null;
    article: { id: string; title: string; moduleKey: string | null; steps: string[]; commonErrors: string[]; sourceRef: string | null } | null;
    gapLogged: boolean;
    invisibleUxEnabled: boolean;
    source: "falatu_help";
  } {
    const text = String(input?.text || "").trim();
    const intent = this.classify(text);
    const mod = this.matchModule(text);
    const inv = db.prepare(`SELECT COALESCE(invisible_ux_enabled,0) e FROM organization_settings WHERE organization_id = ?`).get(orgId) as any;

    let message = "";
    let module: { key: string; label: string; desc: string } | null = null;
    let navTarget: { key: string; label: string; available: boolean } | null = null;
    let evidence: { category: string; count: number } | null = null;
    let governedBy: { actionType: string; policy: string; requiredRole: string | null } | null = null;

    if (intent === "teach") {
      if (mod) { module = mod; message = `${mod.label}: ${mod.desc}`; }
      else message = "Me diga sobre o que você quer entender — um recurso, uma tela ou uma ação — que eu explico.";
    } else if (intent === "show") {
      const ev = this.evidenceFor(orgId, user, text);
      evidence = ev;
      message = ev.count > 0
        ? `Você tem ${ev.count} ${this.categoryLabel(ev.category)} — abra "Hoje" pra ver.`
        : `Sem ${this.categoryLabel(ev.category)} agora. Quando aparecer, mostro em "Hoje".`;
    } else if (intent === "do") {
      const g = this.governedFor(orgId, text);
      if (g) {
        governedBy = { actionType: g.actionType, policy: g.policy, requiredRole: g.requiredRole };
        const gate = g.policy === "none" ? "você confirma e eu preparo" : g.requiredRole ? `precisa da aprovação do perfil "${g.requiredRole}"` : "precisa de aprovação";
        message = `Posso preparar "${g.label}", mas não executo sozinho: ${gate}. Nada sai sem a sua confirmação.`;
      } else {
        message = "Me diga o que você quer fazer (ex.: campanha, cobrança, compra) que eu preparo — sempre com a sua confirmação.";
      }
    } else if (intent === "navigate") {
      navTarget = this.navFor(orgId, user, text, mod);
      if (navTarget) message = navTarget.available ? `Fica em "${navTarget.label}".` : `"${navTarget.label}" não está no seu plano/perfil ainda.`;
      else message = "Não achei essa tela pelo nome. Tente pelo Hoje ou me diga o que quer fazer.";
    } else {
      message = "Posso explicar um recurso, mostrar o que precisa de você, fazer uma ação (com a sua confirmação) ou te levar a uma tela. O que você precisa?";
    }

    // ── Camada de conteúdo curado (ADR-179 F1) — aterra a resposta num ARTIGO ──
    // Só entra em dúvidas de "como/o que/onde/faça" (não em "mostre", que é evidência
    // ao vivo). Grounded: quando há artigo, cita e enriquece com o passo a passo;
    // sem cobertura E sem resposta substantiva dos engines → HONESTO + registra a
    // lacuna (RN-HELP-1). 0-regressão: nunca sobrescreve uma resposta de engine.
    let article: { id: string; title: string; moduleKey: string | null; steps: string[]; commonErrors: string[]; sourceRef: string | null } | null = null;
    let gapLogged = false;
    if (intent !== "show") {
      const moduleKey = input?.moduleKey || module?.key || null;
      const kb = HelpKnowledgeService.retrieve(orgId, text, moduleKey);
      if (kb) {
        article = { id: kb.id, title: kb.title, moduleKey: kb.module_key, steps: kb.steps, commonErrors: kb.commonErrors, sourceRef: kb.sourceRef };
        const steps = kb.steps.map((s, i) => `${i + 1}) ${s}`).join(" ");
        // Enriquece: mantém o texto do engine (quando houver) e acrescenta o passo a passo citado.
        const grounded = `${kb.what || kb.title}${steps ? ` Passo a passo: ${steps}` : ""} (fonte: ${kb.title})`;
        message = module ? `${message} ${grounded}` : grounded;
      } else if (!this.hasSubstance(intent, module, governedBy, navTarget)) {
        // Nada dos engines E nada na base → admite e registra a lacuna (nunca inventa).
        HelpKnowledgeService.logGap(orgId, text, moduleKey);
        gapLogged = true;
      }
    }

    return { intent, message, module, navTarget, evidence, governedBy, article, gapLogged, invisibleUxEnabled: !!(inv && inv.e), source: "falatu_help" };
  }

  /** Houve resposta CONCRETA dos engines determinísticos? (define se a lacuna é real). */
  private static hasSubstance(
    intent: HelpIntent,
    module: { key: string } | null,
    governedBy: { actionType: string } | null,
    navTarget: { available: boolean } | null,
  ): boolean {
    if (intent === "teach") return !!module;
    if (intent === "do") return !!governedBy;
    if (intent === "navigate") return !!navTarget;
    return false; // unknown → sem substância
  }

  // ── classificação (determinística) ──
  private static classify(text: string): HelpIntent {
    if (!text) return "unknown";
    if (/o que (é|e|significa|faz)|pra que serve|como funciona|me explica|explica|ensina/i.test(text)) return "teach";
    if (/\b(faz|faça|fazer)\b|quero (fazer|criar|enviar|disparar|cobrar|comprar)|dispara|preparar? uma/i.test(text)) return "do";
    if (/onde (fica|encontro|acho|configuro|está|estão)|como (chego|acesso|abro|vou)|abrir|abre|me leva/i.test(text)) return "navigate";
    if (/mostr|cadê|cade|quero ver|me mostra|ver (as|os|minhas|meus|meu|minha)/i.test(text)) return "show";
    return "unknown";
  }

  /** Casa um módulo pelo label/desc/key no texto (sem inventar). */
  private static matchModule(text: string): { key: string; label: string; desc: string } | null {
    const t = text.toLowerCase();
    const meta = ModuleService.MODULE_META as Record<string, { label: string; desc: string }>;
    for (const [key, m] of Object.entries(meta)) {
      if (t.includes(key) || t.includes(m.label.toLowerCase())) return { key, label: m.label, desc: m.desc };
    }
    return null;
  }

  /** Evidência pra "mostre": mapeia o que o usuário pediu → categoria da Smart Inbox. */
  private static evidenceFor(orgId: string, user: any, text: string): { category: string; count: number } {
    const inbox = SmartInboxService.build(orgId, user);
    let category: string = "needsApproval";
    if (/risco|riscos/i.test(text)) category = "risk";
    else if (/oportunidad/i.test(text)) category = "opportunity";
    else if (/execu|andamento|rodando/i.test(text)) category = "inExecution";
    else if (/resolv|conclu|feito/i.test(text)) category = "resolved";
    else if (/decis/i.test(text)) category = "needsDecision";
    return { category, count: (inbox.counts as any)[category] || 0 };
  }

  /** Caminho governado pra "faça": resolve a política que governa a ação. */
  private static governedFor(orgId: string, text: string): { actionType: string; domain: string; label: string; policy: string; requiredRole: string | null } | null {
    const hit = DO_MAP.find((d) => d.re.test(text));
    if (!hit) return null;
    const r = ApprovalPolicyService.resolve(orgId, { domain: hit.domain, actionType: hit.actionType });
    return { actionType: hit.actionType, domain: hit.domain, label: hit.label, policy: r.policy, requiredRole: r.requiredRole };
  }

  /** Navegação pra "onde fica": reusa o manifesto (respeita plano/RBAC). */
  private static navFor(orgId: string, user: any, text: string, mod: { key: string; label: string } | null): { key: string; label: string; available: boolean } | null {
    const t = text.toLowerCase();
    for (const s of Object.values(SURFACES)) if (t.includes(s.label.toLowerCase()) || t.includes(s.key)) return { ...s, available: true };
    if (!mod) return null;
    const manifest = NavigationManifestService.forUser(orgId, user);
    const inExplore = manifest.explore.find((e) => e.key === mod.key);
    if (inExplore) return { key: mod.key, label: inExplore.label, available: true };
    // Módulo conhecido, mas fora do plano/perfil → honesto (RN-UX-4), não finge.
    return { key: mod.key, label: mod.label, available: false };
  }

  private static categoryLabel(cat: string): string {
    return ({ needsApproval: "aprovações esperando", needsDecision: "decisões pra você", risk: "riscos", opportunity: "oportunidades", inExecution: "processos em execução", resolved: "itens resolvidos" } as Record<string, string>)[cat] || "itens";
  }
}

export default ZeroTrainingHelpService;
