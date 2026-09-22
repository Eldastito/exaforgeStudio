/**
 * ExecutiveQueryRouterService — F2 do plano "Diretor IA com ferramentas de
 * consulta aterradas" (docs/prd/PLANO-DIRETOR-IA-FERRAMENTAS.md).
 *
 * Liga a PERGUNTA do gestor ao cardápio da F1 (`ExecutiveQueryToolsService`):
 *   1. Roteador DETERMINÍSTICO por palavra-chave (RN-DIR-5 — antes de gastar
 *      LLM): detecta ferramenta, período e loja citada no texto.
 *   2. Sem match determinístico → `chat(json)` escolhe do cardápio (prompt
 *      PEQUENO — a conta OpenAI tem TPM 30k; o cardápio inteiro cabe em ~1k
 *      tokens). O modelo só devolve `{tool, args}` — nunca SQL (RN-DIR-1).
 *   3. Executa a ferramenta (org da sessão, §73 já embutido no cardápio/run).
 *   4. Resposta final: `chat()` curto com SÓ pergunta+fatos da ferramenta
 *      (RN-DIR-6); LLM indisponível → devolve os fatos crus (honesto, roda
 *      em CI sem chave).
 *   5. Nada casou / ferramenta falhou → `null`: o caller segue no fluxo ATUAL
 *      do panorama (RN-DIR-7, 0-regressão).
 *
 * PERGUNTA ANALÍTICA ("por que caíram?") não roteia de propósito — análise de
 * causa é do panorama; a ferramenta responde CONSULTA (quanto/quem/quando).
 * `llmFn` é injetável pros testes rodarem offline.
 */
import db from "./db.js";
import { chat } from "./llm.js";
import { logAuthEvent } from "./auditLog.js";
import { ExecutiveQueryToolsService, type ExecutiveToolResult } from "./ExecutiveQueryToolsService.js";

const norm = (s: string) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const clean = (s: string) => norm(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export class ExecutiveQueryRouterService {
  /** Injetável pros testes (offline). Assinatura do chat() real. */
  static llmFn: (prompt: string, opts?: { temperature?: number; json?: boolean }) => Promise<string> = chat;

  /**
   * Tenta responder a pergunta por FERRAMENTA. Devolve o texto da resposta
   * (ou o `clarify` da ferramenta) — ou `null` pro caller cair no panorama.
   */
  static async answer(orgId: string, question: string, opts: { canSeeMoney?: boolean; actorId?: string | null } = {}): Promise<string | null> {
    const q = String(question || "").trim();
    if (!orgId || !q) return null;
    const canSeeMoney = opts.canSeeMoney !== false;
    const actorId = opts.actorId ?? null;
    try {
      let pick = this.detect(orgId, q);
      if (!pick) pick = await this.llmSelect(orgId, q, { canSeeMoney });
      if (!pick) {
        // F5: pergunta que PARECE consulta de negócio mas nenhuma ferramenta
        // cobriu vira BACKLOG (o dono vê o que foi perguntado e não respondido,
        // em vez de eu adivinhar a próxima ferramenta). Pergunta analítica
        // ("por que…") não conta — é do panorama, não é lacuna de ferramenta.
        this.recordMiss(orgId, q, actorId);
        return null;
      }

      const res = ExecutiveQueryToolsService.run(orgId, pick.tool, pick.args, { canSeeMoney });
      if (res.clarify) return res.clarify;
      // §73: pergunta de dinheiro de papel restrito NÃO roteia — cai no
      // panorama, que já sabe redigir (0-regressão, nunca erro seco pro humano).
      if (!res.ok || !res.summary) return null;
      return await this.phrase(q, res);
    } catch (e) {
      console.error("[DiretorRouter] Falha no roteamento (fallback panorama):", e);
      return null;
    }
  }

  // ── 1) Detecção determinística ────────────────────────────────────────────
  static detect(orgId: string, question: string): { tool: string; args: Record<string, any> } | null {
    const ql = norm(question);
    // Análise de causa é do panorama (contexto amplo), não de ferramenta.
    if (/(por ?que|explique|analis|caiu|cairam|motivo|diagnostic)/.test(ql)) return null;

    const period = this.findPeriod(ql);
    // Loja: casa contra as lojas reais; senão, o termo cru após "loja/filial"
    // vai pra ferramenta (que resolve — ou devolve clarify, nunca chuta).
    const store = this.findStoreInText(orgId, question);
    const storeTerm = store?.name || this.extractStoreTerm(question);

    // Abaixo da cota/meta: relatório de dias negativos por loja (default mês).
    // Vem ANTES de metas_progresso senão "abaixo da meta" cairia lá.
    if (/(cota|meta|quota)/.test(ql) && /(abaixo|fora|deficit|d[eé]ficit|negativ|nao? bat|não bat|nao? atin|não atin|nao? bateu|não bateu|faltou|furou)/.test(ql)) {
      return { tool: "metas_abaixo_cota", args: { store: storeTerm, period: period || "mes" } };
    }
    if (/\bmetas?\b/.test(ql)) return { tool: "metas_progresso", args: {} };
    // F4: finanças / comissão / catálogo.
    if (/(a\s*receber|receb[ií]ve|vencid|fiado)/.test(ql)) return { tool: "a_receber", args: {} };
    if (/(caixa|saldo|quanto tenho em caixa|dinheiro em caixa|a pagar|financeiro)/.test(ql)) return { tool: "caixa_resumo", args: {} };
    if (/(comiss[aã]o|comissoes|comiss[oõ]es)/.test(ql)) return { tool: "comissao_estimada", args: { period: period || "mes" } };
    if (/(pre[çc]o|quanto custa|valor d[eoa]|catalogo|cat[aá]logo)/.test(ql)) {
      const product = this.extractCatalogTerm(question);
      if (product) return { tool: "catalogo_produto", args: { product } };
    }
    if (/fechament/.test(ql) && /(pendente|divergen|status|enviou|enviaram|mandou|mandaram|faltou enviar|quem)/.test(ql)) {
      return { tool: "fechamentos_status", args: { date: period || "ontem" } };
    }
    if (/\bestoque\b/.test(ql)) {
      const product = this.extractProductTerm(orgId, question, store?.name);
      if (!product) return null; // termo confuso → deixa o LLM extrair
      return { tool: "estoque_loja", args: { product, store: storeTerm } };
    }
    if (/(venda|vendas|vendeu|vendemos|faturou|faturamento|fechou o dia)/.test(ql)) {
      return { tool: "vendas_por_loja", args: { store: storeTerm, period: period || "ontem" } };
    }
    return null;
  }

  /** "preço da camisa polo" / "quanto custa o vestido" → termo do produto. */
  private static extractCatalogTerm(question: string): string | undefined {
    const q = norm(question);
    const m = q.match(/(?:pre[çc]o|valor)\s+d[eoa]s?\s+(.+)/) || q.match(/quanto\s+custa\s+(?:o|a|os|as)?\s*(.+)/) || q.match(/cat[aá]logo\s+(?:de|da|do)?\s*(.+)/);
    if (!m) return undefined;
    const term = m[1].replace(/[?!.]/g, " ").replace(/\s+/g, " ").trim();
    return term.length >= 2 ? term : undefined;
  }

  /** Termo cru após "loja/filial" quando nenhuma loja real casou no texto. */
  private static extractStoreTerm(question: string): string | undefined {
    const m = norm(question).match(/(?:loja|filial)\s+([a-z0-9. ]{2,40})/);
    if (!m) return undefined;
    const term = m[1].split(/\b(?:de|do|da|ontem|hoje|anteontem|semana|mes)\b/)[0].replace(/[?!.]/g, " ").trim();
    return term.length >= 2 ? term : undefined;
  }

  /** Palavra de período no texto → chave aceita pelo resolvePeriod da F1. */
  static findPeriod(ql: string): string | null {
    if (/anteontem/.test(ql)) return "anteontem";
    if (/ontem/.test(ql)) return "ontem";
    if (/hoje/.test(ql)) return "hoje";
    if (/semana passada/.test(ql)) return "semana_passada";
    if (/(nesta|essa|esta|na) semana|últim[oa]s? 7|ultimos? 7|\bsemana\b/.test(ql)) return "semana";
    if (/m[eê]s passado/.test(ql)) return "mes_passado";
    if (/(neste|nesse|este|no) m[eê]s|\bm[eê]s\b/.test(ql)) return "mes";
    return null;
  }

  /** Loja citada no texto: nome contido, ou todos os tokens (≥3 chars) presentes. */
  static findStoreInText(orgId: string, question: string): { id: string; name: string } | null {
    try {
      const qc = ` ${clean(question)} `;
      const stores = db.prepare(`SELECT id, name FROM retail_stores WHERE organization_id = ? AND active = 1`).all(orgId) as any[];
      const hits = stores.filter((s) => {
        const n = clean(s.name);
        if (qc.includes(` ${n} `)) return true;
        const toks = n.split(" ").filter((t) => t.length >= 3);
        return toks.length > 0 && toks.every((t) => qc.includes(` ${t}`) || qc.includes(`${t} `) || qc.includes(t));
      });
      return hits.length === 1 ? { id: hits[0].id, name: hits[0].name } : null;
    } catch { return null; }
  }

  /** "estoque da camisa ref 123 na carioca" → "camisa ref 123" (tira loja/filler). */
  private static extractProductTerm(orgId: string, question: string, storeName?: string): string | null {
    const m = norm(question).match(/estoque\s+(?:de|da|do|das|dos)?\s*(.+)/);
    if (!m) return null;
    let term = m[1];
    if (storeName) term = term.replace(new RegExp(`(na|no|em|da|do)?\\s*(loja\\s*)?${norm(storeName).replace(/[^a-z0-9 ]/g, ".?")}`, "g"), " ");
    term = term.replace(/[?!.]/g, " ").replace(/\b(na|no|em|da|do|de|loja|lojas|rede|toda|todas)\b/g, " ").replace(/\s+/g, " ").trim();
    return term.length >= 3 ? term : null;
  }

  // ── 2) Seleção por LLM (prompt pequeno, só {tool,args}) ──────────────────
  private static async llmSelect(orgId: string, question: string, opts: { canSeeMoney: boolean }): Promise<{ tool: string; args: Record<string, any> } | null> {
    const tools = ExecutiveQueryToolsService.list({ canSeeMoney: opts.canSeeMoney });
    if (!tools.length) return null;
    const cardapio = tools.map((t) => `- ${t.name}: ${t.description}\n  args: ${t.args.map((a) => `${a.name}${a.required ? "*" : ""} (${a.description})`).join("; ") || "nenhum"}`).join("\n");
    const prompt = `Você roteia a pergunta de um gestor pra UMA ferramenta de consulta do sistema, ou nenhuma.
Regras: escolha SÓ ferramentas da lista; nunca invente ferramenta nem argumentos que a pergunta não dá; pergunta analítica ("por que…"), pedido de ação ou assunto fora da lista → tool null.

FERRAMENTAS:
${cardapio}

PERGUNTA: "${question.slice(0, 300)}"

Responda SÓ JSON: {"tool": "<nome ou null>", "args": {…}}`;
    try {
      const raw = await this.llmFn(prompt, { temperature: 0, json: true });
      const parsed = JSON.parse(raw);
      const name = typeof parsed?.tool === "string" ? parsed.tool : null;
      if (!name || !tools.some((t) => t.name === name)) return null;
      const args = parsed.args && typeof parsed.args === "object" ? parsed.args : {};
      return { tool: name, args };
    } catch { return null; }
  }

  // ── F5: lacunas viram backlog ─────────────────────────────────────────────
  /** Minimiza a pergunta pro log (LGPD): tira telefone, CPF, cartão, e-mail. */
  static minimizeQuestion(q: string): string {
    return String(q || "")
      .replace(/\b\d{11,}\b/g, "[num]")                         // telefone/CPF colados
      .replace(/\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g, "[cpf]")     // CPF formatado
      .replace(/\b(?:\d[ .-]?){13,19}\b/g, "[cartao]")          // cartão
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]")          // e-mail
      .replace(/\s+/g, " ").trim().slice(0, 200);
  }

  /**
   * Só registra miss se a pergunta CHEIRA a consulta de negócio (evita poluir o
   * backlog com saudação/analítica/conversa fiada). Best-effort — nunca lança.
   */
  private static recordMiss(orgId: string, question: string, actorId: string | null): void {
    try {
      const ql = norm(question);
      if (ql.length < 8) return;
      if (/(por ?que|explique|analis|motivo|diagnostic)/.test(ql)) return; // é do panorama
      const looksBusiness = /(vend|fatur|estoque|cota|meta|caixa|saldo|receber|pagar|comiss|pre[çc]o|ticket|cliente|produto|loja|filial|fechament|quant|ranking|top |melhor|pior|desempenh|resultado|lucro|margem|receita)/.test(ql);
      if (!looksBusiness) return;
      logAuthEvent(orgId, actorId, null, "DIRETOR_QUERY_MISS", { q: this.minimizeQuestion(question) });
    } catch { /* backlog é best-effort */ }
  }

  /**
   * Backlog das próximas ferramentas: perguntas de consulta que nenhuma
   * ferramenta cobriu, agrupadas por texto minimizado, mais recentes primeiro.
   * Read model (RN-004) sobre o audit — sem tabela nova.
   */
  static gaps(orgId: string, opts: { limit?: number; sinceDays?: number } = {}): { totalMisses: number; items: { question: string; count: number; lastAt: string }[] } {
    const limit = Math.min(Math.max(1, opts.limit || 50), 200);
    const sinceDays = Math.min(Math.max(1, opts.sinceDays || 90), 365);
    try {
      const rows = db.prepare(
        `SELECT metadata_json, created_at FROM auth_audit_logs
          WHERE organization_id = ? AND event_type = 'DIRETOR_QUERY_MISS'
            AND created_at >= datetime('now', ?)
          ORDER BY created_at DESC LIMIT 2000`
      ).all(orgId, `-${sinceDays} days`) as any[];
      const agg = new Map<string, { question: string; count: number; lastAt: string }>();
      for (const r of rows) {
        let q = "";
        try { q = String(JSON.parse(r.metadata_json || "{}")?.q || ""); } catch { /* ignore */ }
        if (!q) continue;
        const key = q.toLowerCase();
        const cur = agg.get(key);
        if (cur) cur.count++;
        else agg.set(key, { question: q, count: 1, lastAt: r.created_at });
      }
      const items = [...agg.values()].sort((a, b) => b.count - a.count || (a.lastAt < b.lastAt ? 1 : -1)).slice(0, limit);
      return { totalMisses: rows.length, items };
    } catch { return { totalMisses: 0, items: [] }; }
  }

  // ── 4) Resposta final (curta; sem LLM → fatos crus, nunca trava) ─────────
  private static async phrase(question: string, res: ExecutiveToolResult): Promise<string> {
    const facts = String(res.summary || "");
    try {
      const prompt = `Responda a pergunta do gestor em PT-BR, curto e direto, usando SOMENTE os fatos abaixo. NUNCA invente número nem prometa "verificar depois". Se os fatos dizem que não há dado, diga isso claramente.

FATOS (do sistema):
${facts}

PERGUNTA: "${question.slice(0, 300)}"`;
      const out = (await this.llmFn(prompt, { temperature: 0.2 })).trim();
      return out || facts;
    } catch { return facts; }
  }
}
