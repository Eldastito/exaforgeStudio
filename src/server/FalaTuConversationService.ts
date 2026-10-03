/**
 * FalaTuConversationService (ADR-203 F2.8 / PRD Fase 2 §13, §29-§30) — o FalaTu deixa de tratar cada mensagem como avulsa:
 *  (1) CONTEXTO CORRENTE: a loja que o usuário escolheu na conversa vira o padrão da pergunta ("quanto falta?" → daquela loja);
 *  (2) ROLE-AWARE: quem está preso a lojas (ADR-173) só conversa sobre as dele — o servidor barra o resto, não a UI;
 *  (3) CONTINUIDADE: "Por quê?", "E a Carioca?", "E ontem?" continuam a última resposta (a ferramenta + os argumentos dela).
 *
 * COMPÕE, não duplica: `ExecutiveQueryRouterService.detect` (a mesma detecção do FalaTu/Diretor IA), `ExecutiveQueryToolsService.run`
 * (os números vêm do sistema), `ResultsStoryService.understand` (o "Por quê?" = o "Entender" da F2.5: fato × hipótese),
 * `RetailStoreScopeService`. Sem tabela, sem LLM, sem motor novo.
 *
 * Regras:
 *  - Honesto (RN-F2-6/8): nada de chute — loja ambígua/fora do escopo, ou "Por quê?" sem resposta anterior, vira PERGUNTA ou recusa clara;
 *    "Por quê?" separa FATO de HIPÓTESE e nunca aponta causa comprovada nem culpa.
 *  - Dinheiro role-gated (§73): a ferramenta já barra; "Por quê?" de quem não é gestor devolve que o número é do gestor.
 *  - Estado da conversa = memória do processo, por (org, usuário), 20 min de validade, sem conteúdo gravado em banco (LGPD). Reiniciar o
 *    servidor ou passar 20 min "esquece" — e o FalaTu volta a tratar a frase como pergunta nova (nunca inventa o que faltou).
 */
import db from "./db.js";
import { ExecutiveQueryRouterService } from "./ExecutiveQueryRouterService.js";
import { ExecutiveQueryToolsService } from "./ExecutiveQueryToolsService.js";
import { RetailStoreScopeService } from "./RetailStoreScopeService.js";
import { ResultsStoryService } from "./ResultsStoryService.js";

export const CONVERSATION_TTL_MS = 20 * 60_000;
/** Ferramentas que aceitam `store` — as únicas em que "e a Carioca?" faz sentido. */
export const STORE_TOOLS = new Set(["meta_do_dia", "dinheiro_do_dia", "vendas_por_loja", "metas_abaixo_cota", "estoque_loja"]);
/** Ferramentas que olham a REDE inteira — fora do alcance de quem está preso a lojas. */
export const NETWORK_TOOLS = new Set(["ranking_lojas", "panorama_operacao", "ranking_vendedores", "vendedores_abaixo_meta", "divergencia_estoque", "produtos_parados"]);
/** Só estas aceitam `period`. */
const PERIOD_TOOLS = new Set(["vendas_por_loja", "metas_abaixo_cota"]);

interface Turn { tool: string; args: Record<string, any>; storeId: string | null; at: number }
const memory = new Map<string, Turn>();
const key = (orgId: string, userId: string) => `${orgId}::${userId}`;
const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
const uidOf = (user: any) => String(user?.userId || user?.id || "");

export interface ConvResult { text: string; data?: any; grounded: boolean; moneyRestricted?: boolean }

export class FalaTuConversationService {
  static remember(orgId: string, user: any, turn: { tool: string; args: Record<string, any>; storeId?: string | null }, now = Date.now()): void {
    const uid = uidOf(user); if (!uid) return;
    memory.set(key(orgId, uid), { tool: turn.tool, args: { ...turn.args }, storeId: turn.storeId ?? null, at: now });
  }
  static last(orgId: string, user: any, now = Date.now()): Turn | null {
    const t = memory.get(key(orgId, uidOf(user)));
    if (!t) return null;
    if (now - t.at > CONVERSATION_TTL_MS) { memory.delete(key(orgId, uidOf(user))); return null; }
    return t;
  }
  static forget(orgId: string, user: any): void { memory.delete(key(orgId, uidOf(user))); }
  static reset(): void { memory.clear(); }

  /** A loja é acessível a este usuário? (dono / sem atribuição = todas.) */
  static canAccessStore(orgId: string, user: any, storeId: string): boolean {
    return RetailStoreScopeService.canAccessStore(orgId, uidOf(user), String(user?.role || ""), storeId);
  }
  static storeById(orgId: string, storeId: string): { id: string; name: string } | null {
    return (db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, storeId) as any) || null;
  }

  /**
   * Passo ÚNICO antes do fluxo normal do FalaTu: aplica o ESCOPO por papel e o CONTEXTO da loja a uma pergunta que a detecção
   * determinística reconhece. null = nada a fazer (segue o fluxo de sempre — 0-regressão).
   */
  static scoped(orgId: string, user: any, question: string, opts: { contextStoreId?: string | null; canSeeMoney?: boolean; now?: number } = {}): ConvResult | null {
    const pick = ExecutiveQueryRouterService.detect(orgId, question);
    // Chegou aqui = NÃO foi continuação (o followUp roda antes): é assunto novo. "Por quê?" não pode puxar a loja de antes.
    if (!pick) { this.forget(orgId, user); return null; }
    if (!STORE_TOOLS.has(pick.tool)) this.forget(orgId, user);
    const uid = uidOf(user), role = String(user?.role || "");
    const scope = RetailStoreScopeService.allowed(orgId, uid, role);
    const explicit = ExecutiveQueryRouterService.findStoreInText(orgId, question);
    const wantsNetwork = /\b(rede|todas as lojas|todas lojas|geral)\b/.test(norm(question));
    const ctx = opts.contextStoreId ? this.storeById(orgId, opts.contextStoreId) : null;
    if (ctx && !this.canAccessStore(orgId, user, ctx.id)) return { text: "Você não tem acesso a essa loja.", grounded: true };

    // ── ROLE-AWARE: quem está preso a lojas ──
    if (!scope.unrestricted) {
      const names = scope.storeIds.map((id) => this.storeById(orgId, id)?.name).filter(Boolean) as string[];
      if (NETWORK_TOOLS.has(pick.tool)) return { text: "Esse comparativo entre lojas é do dono ou do gestor da rede. Eu posso responder sobre " + (names.length === 1 ? `a ${names[0]}` : names.join(" e ")) + ".", grounded: true };
      if (explicit && !scope.storeIds.includes(explicit.id)) return { text: `Você tem acesso só a ${names.join(" e ")}. Não posso falar da ${explicit.name}.`, grounded: true };
      if (STORE_TOOLS.has(pick.tool) && !explicit) {
        const target = ctx || (scope.storeIds.length === 1 ? this.storeById(orgId, scope.storeIds[0]) : null);
        if (!target) return { text: `De qual loja? ${names.join(" ou ")}.`, grounded: true };
        return this.runTool(orgId, user, pick.tool, { ...pick.args, store: target.name }, target.id, opts);
      }
      return null;   // pergunta que não é de loja (ex.: conversa geral) segue o fluxo normal
    }

    // ── CONTEXTO CORRENTE (dono/gestor da rede): a loja escolhida vira o padrão, salvo se a pergunta cita outra loja ou a rede ──
    if (ctx && STORE_TOOLS.has(pick.tool) && !explicit && !wantsNetwork && !pick.args.store) {
      return this.runTool(orgId, user, pick.tool, { ...pick.args, store: ctx.name }, ctx.id, opts);
    }
    // sem mudança: só LEMBRA a ferramenta para a continuidade (a resposta segue pelo fluxo normal)
    if (STORE_TOOLS.has(pick.tool)) this.remember(orgId, user, { tool: pick.tool, args: pick.args, storeId: explicit?.id ?? ctx?.id ?? null }, opts.now);
    return null;
  }

  /** "Por quê?" / "E a Carioca?" / "E ontem?" — continua a última resposta. null = não é continuação (ou não há o que continuar). */
  static followUp(orgId: string, user: any, question: string, opts: { canSeeMoney?: boolean; now?: number } = {}): ConvResult | null {
    const q = norm(question);
    if (!q || q.length > 60) return null;
    const last = this.last(orgId, user, opts.now);
    if (!last) return null;

    // POR QUÊ — o "Entender" da F2.5 (fato × hipótese) da loja da última resposta.
    if (/^(por ?que|pq|por qual motivo|como assim|me explica|explica)( isso)?$/.test(q)) {
      if (!last.storeId) return { text: "De qual loja você quer entender o motivo? Diga o nome da loja.", grounded: true };
      if (!this.canAccessStore(orgId, user, last.storeId)) return { text: "Você não tem acesso a essa loja.", grounded: true };
      const u = ResultsStoryService.understand(orgId, user, last.storeId);
      if (!u) return null;
      if (u.restricted) return { text: "Os números da loja são do gestor. Peça a ele para abrir o Entender dessa loja.", grounded: true, moneyRestricted: true };
      const lines: string[] = [];
      if (u.periods) lines.push(`${u.storeName} — dia: ${u.periods.day.venda.text} de ${u.periods.day.cota.text} · mês: ${u.periods.month.venda.text} de ${u.periods.month.cota.text}.`);
      if (u.team.length) {
        lines.push("Quem mais caiu nos últimos 30 dias:");
        for (const t of u.team) {
          lines.push(`• ${t.name}${t.salesDeltaPct !== null ? ` (vendas ${t.salesDeltaPct}%)` : ""}`);
          for (const f of t.findings.slice(0, 3)) lines.push(`   ${f.kind === "hypothesis" ? "Hipótese: " : ""}${f.text}`);
        }
      } else lines.push("Nenhuma pessoa da equipe com queda de vendas mensurável nos últimos 30 dias.");
      lines.push("Fato é número do sistema; hipótese é leitura possível dele, não causa comprovada.");
      return { text: lines.join("\n"), data: { understand: u }, grounded: true };
    }

    // E A <LOJA>? — mesma ferramenta, outra loja.
    const m = q.match(/^e\s+(?:(?:a|o|na|no|em|para|pra|da|do)\s+)?(.+)$/);
    if (m && STORE_TOOLS.has(last.tool)) {
      const term = m[1].trim();
      const period = this.periodWord(term);
      if (period && PERIOD_TOOLS.has(last.tool)) return this.runTool(orgId, user, last.tool, { ...last.args, period }, last.storeId, opts, { keepStore: true });
      const hit = ExecutiveQueryRouterService.findStoreInText(orgId, m[1]);
      if (hit) {
        if (!this.canAccessStore(orgId, user, hit.id)) return { text: `Você não tem acesso à ${hit.name}.`, grounded: true };
        return this.runTool(orgId, user, last.tool, { ...last.args, store: hit.name }, hit.id, opts);
      }
    }
    return null;
  }

  private static periodWord(term: string): string | null {
    if (/^(hoje)$/.test(term)) return "hoje";
    if (/^(ontem)$/.test(term)) return "ontem";
    if (/^(na |nesta |esta )?semana$/.test(term)) return "semana";
    if (/^(no |neste |este )?mes$/.test(term)) return "mes";
    return null;
  }

  private static runTool(orgId: string, user: any, tool: string, args: Record<string, any>, storeId: string | null, opts: { canSeeMoney?: boolean; now?: number }, o: { keepStore?: boolean } = {}): ConvResult {
    const res = ExecutiveQueryToolsService.run(orgId, tool, args, { canSeeMoney: opts.canSeeMoney });
    if (res.clarify) return { text: res.clarify, grounded: true };
    if (!res.ok || !res.summary) {
      if (res.error === "forbidden_money") return { text: "Essa informação de dinheiro é restrita ao dono, sócios, administradores e gerentes.", grounded: true, moneyRestricted: true };
      return { text: "Não consegui responder isso agora.", grounded: true };
    }
    this.remember(orgId, user, { tool, args, storeId: o.keepStore ? storeId : (storeId ?? null) }, opts.now);
    return { text: res.summary, data: res.data, grounded: true };
  }
}

export default FalaTuConversationService;
