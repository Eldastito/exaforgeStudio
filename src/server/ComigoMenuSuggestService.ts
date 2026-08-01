import db from "./db.js";

/**
 * Comigo — Sugestão de menu por DESEJO (Gap B do levantamento autônomos, ADR-088 D5 nível 2).
 *
 * A fatia zero-token (ADR-117) já cobre "mais pedidos" e "quem levou X também levou Y"
 * — ranking/co-ocorrência puro. Este service cobre o outro cenário: o cliente escreve
 * um desejo em linguagem natural ("algo leve", "sem lactose", "pra 2 pessoas", "gelado")
 * e o LLM escolhe entre os itens que a loja REALMENTE vende. RAG do cardápio = enviamos
 * o snapshot compacto do catálogo (nome + preço + kind + descrição curta) e forçamos o
 * LLM a devolver SÓ ids dessa lista. Nunca inventa item, nunca cita preço fora do que
 * mandamos — se voltar um id fora do snapshot, é descartado (a UI recebe [] naquela
 * posição, jamais um produto fantasma).
 *
 * Guardas duros:
 * - Isolamento por organization_id em todas as queries e no snapshot.
 * - Sem chave OpenAI → cai pra busca literal (LIKE %desire%) no nome do item.
 * - Teto por org/dia via ai_usage_log (kind='comigo_menu_suggest'): ao estourar,
 *   idem — literal. Nunca 500 pro atendimento; sempre devolve o melhor que dá.
 * - JSON malformado ou sem items[] → literal (defesa em profundidade).
 * - Só itens ativos e com preço (mesmo filtro do Balcão), pra não sugerir o que
 *   não dá pra vender.
 *
 * Frugalidade (ADR-088 principio central): min-length 3 no desejo (evita chamadas
 * por "a" ou "ok"), temperature 0 (determinístico), max ~250 output tokens
 * (JSON com 3 ids + reason curto cabe folgado). O `chat()` já registra tokens/custo
 * em ai_usage_log automaticamente — reusamos esse log pra contar o cap do dia.
 */

import { chat as realChat, isAIConfigured } from "./llm.js";

// ── Injeção pro teste (chatFn) ─────────────────────────────────────────────
// O teste não pode bater na OpenAI real (nem sempre há chave, nem sempre há
// rede na CI, e queremos afirmar comportamento — inclusive JSON malformado).
// Padrão consagrado no repo (ex.: ComigoImpactService._internals): a service
// referencia a chatFn atual e o teste sobrescreve pelo _internals.
type ChatFn = (prompt: string, opts?: { temperature?: number; json?: boolean; system?: string }) => Promise<string>;
let chatFn: ChatFn = realChat;
let aiConfiguredFn: () => boolean = isAIConfigured;

export const _internals = {
  setChatFn(fn: ChatFn | null) { chatFn = fn || realChat; },
  setAIConfiguredFn(fn: (() => boolean) | null) { aiConfiguredFn = fn || isAIConfigured; },
};

// ── Tipos ──────────────────────────────────────────────────────────────────
export interface MenuItem {
  id: string;
  name: string;
  price: number;
  kind: string;                 // 'product' | 'service' | 'reservation'
  description?: string | null;
}
export interface SuggestedItem {
  id: string;
  name: string;
  price: number;
  reason: string;               // motivo curto vindo do LLM (ou "" no fallback literal)
}
export type SuggestSource = "llm" | "literal" | "empty";
export interface SuggestResult {
  items: SuggestedItem[];
  source: SuggestSource;
  capReached?: boolean;         // true = teto estourado, caímos pra literal por isso
}

const MAX_SUGGESTIONS = 3;

// ── Helpers internos ───────────────────────────────────────────────────────

/** Snapshot do cardápio ativo, com preço (o que dá pra vender de fato). */
function menuIndex(orgId: string): MenuItem[] {
  const rows = db.prepare(
    `SELECT id, name, type AS kind, price, description
       FROM products_services
      WHERE organization_id = ?
        AND active = 1
        AND price IS NOT NULL
      ORDER BY name ASC`
  ).all(orgId) as any[];
  return rows.map((r) => ({
    id: String(r.id),
    name: String(r.name || ""),
    price: Number(r.price) || 0,
    kind: String(r.kind || "product"),
    description: r.description ? String(r.description) : null,
  }));
}

/** Nº de chamadas LLM `comigo_menu_suggest` desta org NAS ÚLTIMAS 24H. */
function llmCallsLast24h(orgId: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM ai_usage_log
      WHERE organization_id = ?
        AND kind = 'comigo_menu_suggest'
        AND created_at >= datetime('now', '-1 day')`
  ).get(orgId) as any;
  return Number(row?.c) || 0;
}

/** Teto por org do organization_settings (default 50). Guarda contra NaN/negativo. */
function dailyCap(orgId: string): number {
  const row = db.prepare(
    `SELECT comigo_menu_suggest_daily_cap AS cap FROM organization_settings WHERE organization_id = ?`
  ).get(orgId) as any;
  const cap = Number(row?.cap);
  return Number.isFinite(cap) && cap >= 0 ? cap : 50;
}

/**
 * Busca literal de fallback: normaliza (lowercase, remove acentos), divide o
 * desejo em tokens de 3+ chars e ranqueia itens por nº de tokens presentes no
 * nome/descrição. Não é IA — é o mínimo que funciona sem chave/sem teto.
 */
function literalSearch(orgId: string, desire: string): SuggestedItem[] {
  const menu = menuIndex(orgId);
  if (menu.length === 0) return [];
  const norm = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  const tokens = norm(desire).split(/[^a-z0-9]+/).filter((t) => t.length >= 3);
  if (tokens.length === 0) return [];
  const scored = menu.map((it) => {
    const hay = `${norm(it.name)} ${norm(it.description || "")}`;
    const score = tokens.reduce((s, t) => s + (hay.includes(t) ? 1 : 0), 0);
    return { it, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_SUGGESTIONS).map(({ it }) => ({
    id: it.id, name: it.name, price: it.price, reason: "",
  }));
}

/**
 * Constrói o prompt: mandamos o cardápio como JSON linha-a-linha e forçamos o
 * LLM a devolver um objeto com `items:[{id,reason}]` — reason curto (<80 chars),
 * ids EXCLUSIVAMENTE do menu enviado. `strict:true` no system prompt reforça
 * a proibição de inventar (tratado depois pela validação de id de qualquer forma).
 */
function buildPrompt(desire: string, menu: MenuItem[]): { system: string; user: string } {
  const system = [
    "Você é um garçom que sugere pratos do CARDÁPIO REAL de uma loja brasileira.",
    "Regras rígidas:",
    "1) Só sugerir itens que estão na LISTA DE CARDÁPIO fornecida. NUNCA invente.",
    "2) O campo `id` da sua resposta DEVE ser EXATAMENTE um id da lista — qualquer id fora é descartado.",
    "3) Devolva no MÁXIMO 3 itens, ordenados do mais aderente ao menos.",
    "4) `reason` = motivo curto (até 80 caracteres) em português, dizendo por que atende ao desejo.",
    "5) Se NADA no cardápio atender bem, devolva `items: []` — não force sugestão ruim.",
    "6) NÃO cite preços em `reason` (o cliente vê o preço na tela).",
    'Responda SOMENTE um JSON com o shape: {"items":[{"id":"...","reason":"..."}]}',
  ].join("\n");
  // Snapshot compacto — 1 item por linha. Descrição truncada evita inflar tokens.
  const catalog = menu.map((it) => JSON.stringify({
    id: it.id,
    name: it.name,
    kind: it.kind,
    ...(it.description ? { description: it.description.slice(0, 120) } : {}),
  })).join("\n");
  const user = [
    `DESEJO DO CLIENTE: ${desire}`,
    "",
    "CARDÁPIO DISPONÍVEL (só use estes ids):",
    catalog,
  ].join("\n");
  return { system, user };
}

/** Parse defensivo — qualquer erro/formato inválido devolve []. */
function parseLLMResponse(raw: string): Array<{ id: string; reason: string }> {
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j?.items) ? j.items : [];
    return arr
      .filter((x: any) => x && typeof x.id === "string")
      .map((x: any) => ({ id: String(x.id), reason: String(x.reason || "").slice(0, 200) }))
      .slice(0, MAX_SUGGESTIONS);
  } catch { return []; }
}

// ── API pública ────────────────────────────────────────────────────────────

export class ComigoMenuSuggestService {
  /**
   * Interpreta o desejo do cliente e devolve até 3 itens do menu real da loja.
   * SEMPRE responde — se o LLM não puder rodar, cai pra busca literal; se nada
   * casar, `{items:[], source:'empty'}`. Nunca lança pra rota do atendimento.
   */
  static async interpret(orgId: string, desire: string): Promise<SuggestResult> {
    const d = String(desire || "").trim();
    if (d.length < 3) return { items: [], source: "empty" };

    // Sem menu ativo, nada a sugerir (evita chamada de LLM inútil).
    const menu = menuIndex(orgId);
    if (menu.length === 0) return { items: [], source: "empty" };

    // Sem chave de IA → literal direto (não conta contra o cap).
    if (!aiConfiguredFn()) {
      const items = literalSearch(orgId, d);
      return { items, source: items.length > 0 ? "literal" : "empty" };
    }

    // Cap por org/dia — se estourou, literal (marca capReached pra UI mostrar).
    const cap = dailyCap(orgId);
    const usedToday = llmCallsLast24h(orgId);
    if (cap > 0 && usedToday >= cap) {
      const items = literalSearch(orgId, d);
      return { items, source: items.length > 0 ? "literal" : "empty", capReached: true };
    }

    // Chamada ao LLM. O chatFn já registra em ai_usage_log via recordUsage() do
    // llm.ts — mas o `kind` gravado é 'chat', não 'comigo_menu_suggest'. Pra
    // contar o cap, gravamos NÓS mesmos um sinal com esse kind (0 tokens: já
    // foram contabilizados no 'chat', não queremos dupla contagem de custo).
    const { system, user } = buildPrompt(d, menu);
    let raw = "";
    try {
      raw = await chatFn(user, { system, json: true, temperature: 0 });
    } catch {
      // LLM caiu (rate limit, rede, timeout) → literal, não penaliza o cap.
      const items = literalSearch(orgId, d);
      return { items, source: items.length > 0 ? "literal" : "empty" };
    }

    // Registra o "hit" pro cap. IMPORTANTE: usa 0 tokens/custo pra não somar
    // duas vezes (o `chatFn` já lançou o custo real como kind='chat').
    try {
      const { randomUUID } = await import("crypto");
      db.prepare(
        `INSERT INTO ai_usage_log (id, organization_id, model, kind, input_tokens, output_tokens, total_tokens, cost_usd, cost_brl)
         VALUES (?, ?, 'meter', 'comigo_menu_suggest', 0, 0, 0, 0, 0)`
      ).run(randomUUID(), orgId);
    } catch { /* medição nunca pode quebrar o atendimento */ }

    const parsed = parseLLMResponse(raw);
    if (parsed.length === 0) {
      const items = literalSearch(orgId, d);
      return { items, source: items.length > 0 ? "literal" : "empty" };
    }

    // Valida ids contra o snapshot — descarta qualquer id fantasma.
    const byId = new Map(menu.map((m) => [m.id, m]));
    const items: SuggestedItem[] = [];
    for (const p of parsed) {
      const m = byId.get(p.id);
      if (!m) continue;
      items.push({ id: m.id, name: m.name, price: m.price, reason: p.reason });
      if (items.length >= MAX_SUGGESTIONS) break;
    }
    if (items.length === 0) {
      // LLM devolveu só ids inválidos — literal como último recurso.
      const lit = literalSearch(orgId, d);
      return { items: lit, source: lit.length > 0 ? "literal" : "empty" };
    }
    return { items, source: "llm" };
  }

  /** Exposto pros testes/UIs verem quantas chamadas do dia sobraram. */
  static status(orgId: string): { cap: number; used: number; remaining: number; aiConfigured: boolean } {
    const cap = dailyCap(orgId);
    const used = llmCallsLast24h(orgId);
    return { cap, used, remaining: Math.max(0, cap - used), aiConfigured: aiConfiguredFn() };
  }
}

export default ComigoMenuSuggestService;
