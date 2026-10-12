import { randomUUID } from "crypto";
import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { ensureProductSlug } from "./productSlug.js";

/**
 * InstagramCommentIntentService (ADR-207 F9, parte A) — comentário do Instagram → INTENÇÃO COMERCIAL → rascunho de resposta.
 *
 * Esta fatia só ENTENDE e AVISA; ela NÃO ENVIA nada (o envio é a F9b, por comando GOVERNADO). Regras:
 *  - Opt-in por empresa (`ig_comment_intent_enabled`, default 0). Desligado, o webhook se comporta exatamente como antes.
 *  - Comentário é TEXTO NÃO CONFIÁVEL de terceiro: classificação DETERMINÍSTICA por palavras (sem LLM), o texto nunca
 *    entra no rascunho nem em prompt, e o que fica guardado/exibido é um trecho curto e higienizado.
 *  - Contexto do produto só quando há prova: (1) o dono ligou o post (media) ao produto, ou (2) o comentário cita o nome
 *    de UM único produto do catálogo. Sem isso, o rascunho pergunta qual peça — não adivinha produto.
 *  - Preço no rascunho = preço do catálogo (fato), nunca calculado; sem promessa de estoque/prazo/desconto.
 *  - O aviso mora em `business_signals` (convenção nº 12); a tabela guarda o comentário + o rascunho, não é tabela de alerta.
 *  - Idempotente por (empresa, id do comentário): a Meta reentrega eventos. Não cria contato/CRM a partir de comentário público.
 *  - Retenção: comentários com mais de 90 dias são apagados (minimização).
 */
export type CommentIntent = "price" | "availability" | "buy" | "complaint" | "praise" | "spam" | "other";
export const COMMERCIAL_INTENTS: CommentIntent[] = ["price", "availability", "buy"];

const STATUSES = ["new", "dismissed", "answered"] as const;
const RETENTION_DAYS = 90;

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
const has = (t: string, words: string[]) => words.some((w) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(t));

export class InstagramCommentIntentService {
  // ───────── classificação (determinística) ─────────
  static classify(text: string): CommentIntent {
    const t = fold(String(text || ""));
    if (!t.trim()) return "other";
    if (/https?:\/\/|www\./.test(t) || has(t, ["ganhe seguidores", "sdv", "follow4follow", "segue de volta", "renda extra", "lucre"])) return "spam";
    if (has(t, ["golpe", "pessimo", "pessima", "reclamacao", "reclamar", "nao recebi", "enganacao", "absurdo", "procon", "horrivel", "nunca mais", "fraude"])) return "complaint";
    if (has(t, ["quanto", "valor", "valores", "preco", "precos", "custa", "custo", "r\\$"]) || /\bquanto (e|fica|custa|sai)\b/.test(t)) return "price";
    if (has(t, ["como compro", "onde compro", "onde compra", "como comprar", "onde encontro", "link", "comprar", "quero", "queria", "reservar", "encomendar", "manda", "me envia", "tem pra venda"])) return "buy";
    // "tem" sozinho ("tem tudo a ver") não é pergunta de disponibilidade: exige pista de produto (tamanho/cor/estoque ou P/M/G/número).
    if (has(t, ["tamanho", "tamanhos", "numeracao", "cor", "cores", "disponivel", "disponiveis", "estoque"]) || /\btem\b.*\b(pp|p|m|g|gg|\d{2})\b/.test(t)) return "availability";
    if (has(t, ["lindo", "linda", "amei", "maravilhoso", "maravilhosa", "perfeito", "perfeita", "top", "arrasou", "love", "lindos", "lindas"]) || /[❤😍🔥👏]/.test(String(text))) return "praise";
    return "other";
  }

  /** Higieniza o texto de terceiro: sem controles/quebras, espaço normalizado, trecho curto. */
  static snippet(text: unknown, max = 140): string {
    return String(text ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
  }

  // ───────── configuração ─────────
  static enabled(orgId: string): boolean {
    try { return (db.prepare("SELECT ig_comment_intent_enabled e FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.e === 1; } catch { return false; }
  }
  static setEnabled(orgId: string, on: boolean): { enabled: boolean } {
    db.prepare("UPDATE organization_settings SET ig_comment_intent_enabled = ? WHERE organization_id = ?").run(on ? 1 : 0, orgId);
    return { enabled: this.enabled(orgId) };
  }

  // ───────── post → produto (ligação do dono) ─────────
  static linkMedia(orgId: string, mediaId: string, productId: string | null): { linked: boolean } {
    const m = this.snippet(mediaId, 80);
    if (!m) throw new Error("Informe o post (id da mídia).");
    if (productId == null) {
      db.prepare("DELETE FROM instagram_media_products WHERE organization_id = ? AND media_id = ?").run(orgId, m);
      return { linked: false };
    }
    const p = db.prepare("SELECT id FROM products_services WHERE id = ? AND organization_id = ? AND active = 1").get(productId, orgId);
    if (!p) throw new Error("Produto não encontrado nesta empresa.");
    db.prepare(`INSERT INTO instagram_media_products (organization_id, media_id, product_id) VALUES (?, ?, ?)
                ON CONFLICT(organization_id, media_id) DO UPDATE SET product_id = excluded.product_id`).run(orgId, m, productId);
    return { linked: true };
  }

  /** Produto do contexto: ligação do dono vence; senão, nome citado SE for único. Sem prova → null. */
  static productFor(orgId: string, mediaId: string | null, text: string): { id: string; name: string; price: number | null; via: "media" | "text" } | null {
    const row = (id: string) => db.prepare("SELECT id, name, price FROM products_services WHERE id = ? AND organization_id = ? AND active = 1 AND COALESCE(storefront_visible,1) = 1").get(id, orgId) as any;
    if (mediaId) {
      const l = db.prepare("SELECT product_id FROM instagram_media_products WHERE organization_id = ? AND media_id = ?").get(orgId, mediaId) as any;
      const p = l ? row(l.product_id) : null;
      if (p) return { id: p.id, name: p.name, price: p.price != null ? Number(p.price) : null, via: "media" };
    }
    const t = fold(text);
    const hits = (db.prepare("SELECT id, name, price FROM products_services WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible,1) = 1").all(orgId) as any[])
      .filter((p) => { const n = fold(String(p.name || "")).trim(); return n.length >= 4 && t.includes(n); });
    if (hits.length === 1) return { id: hits[0].id, name: hits[0].name, price: hits[0].price != null ? Number(hits[0].price) : null, via: "text" };
    return null;
  }

  // ───────── rascunho (sem texto do comentário, sem promessa) ─────────
  static draft(orgId: string, intent: CommentIntent, product: { id: string; name: string; price: number | null } | null): { text: string | null; needsHuman: boolean } {
    if (intent === "spam" || intent === "other") return { text: null, needsHuman: false };
    if (intent === "complaint") return { text: null, needsHuman: true };      // reclamação: nunca resposta automática
    if (intent === "praise") return { text: "Obrigado pelo carinho! 💛", needsHuman: false };
    if (!product) return { text: "Oi! Qual peça você quer? Me conta que eu te ajudo por aqui. 😊", needsHuman: false };
    const store = db.prepare("SELECT slug FROM storefront_settings WHERE organization_id = ? AND published = 1").get(orgId) as any;
    let link = "";
    if (store?.slug) {
      const base = (process.env.APP_URL || "").replace(/\/$/, "");
      link = ` ${base}/loja/${encodeURIComponent(store.slug)}/produto/${encodeURIComponent(ensureProductSlug(orgId, { id: product.id, name: product.name, slug: (db.prepare("SELECT slug FROM products_services WHERE id = ? AND organization_id = ?").get(product.id, orgId) as any)?.slug ?? null }))}?zf_source=instagram&zf_content=comentario`;
    }
    const price = intent === "price" && product.price != null && product.price > 0 ? ` Ele está R$ ${product.price.toFixed(2).replace(".", ",")} na vitrine.` : "";
    const ask = intent === "availability" ? " Veja tamanhos e disponibilidade aqui:" : intent === "buy" ? " Você compra por aqui:" : " Veja os detalhes aqui:";
    return { text: `Oi! Sobre o ${product.name}.${price}${link ? ask + link : " Me chama no Direct que eu te ajudo."}`, needsHuman: false };
  }

  // ───────── entrada (webhook) ─────────
  /**
   * Trata UM evento `changes[]` do webhook do Instagram. Devolve true SÓ quando o evento foi tratado aqui (desvia do
   * fluxo de DM); false = o caller segue o caminho de sempre, sem mudança. Nunca lança.
   */
  static ingestChange(businessId: string, change: any): boolean {
    try {
      if (!change || change.field !== "comments" || !businessId) return false;
      const ch = db.prepare("SELECT organization_id FROM channels WHERE identifier = ? AND provider = 'instagram'").get(String(businessId)) as any;
      if (!ch?.organization_id) return false;
      const orgId = ch.organization_id as string;
      if (!this.enabled(orgId)) return false;
      const v = change.value || {};
      const commentId = this.snippet(v.id, 80);
      if (!commentId) return true;                                           // desligado pro DM: comentário sem id não vira conversa
      if (String(v.from?.id || "") === String(businessId)) return true;      // comentário da própria conta: ignora
      this.record(orgId, { commentId, mediaId: v.media?.id ? this.snippet(v.media.id, 80) : null, fromId: this.snippet(v.from?.id, 80), fromUsername: this.snippet(v.from?.username, 60), text: String(v.text ?? "") });
      return true;
    } catch { return false; }
  }

  static record(orgId: string, c: { commentId: string; mediaId: string | null; fromId: string; fromUsername: string; text: string }) {
    const exists = db.prepare("SELECT id FROM instagram_comment_intents WHERE organization_id = ? AND comment_id = ?").get(orgId, c.commentId);
    if (exists) return { deduped: true as const };
    const intent = this.classify(c.text);
    const product = COMMERCIAL_INTENTS.includes(intent) || intent === "praise" ? this.productFor(orgId, c.mediaId, c.text) : null;
    const d = this.draft(orgId, intent, product);
    const id = randomUUID();
    db.prepare(`INSERT INTO instagram_comment_intents (id, organization_id, comment_id, media_id, from_id, from_username, snippet, intent, product_id, product_via, draft_reply, needs_human, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')`)
      .run(id, orgId, c.commentId, c.mediaId, c.fromId || null, c.fromUsername || null, this.snippet(c.text), intent, product?.id ?? null, product?.via ?? null, d.text, d.needsHuman ? 1 : 0);
    if (COMMERCIAL_INTENTS.includes(intent) || intent === "complaint") {
      try {
        BusinessSignalService.publish(orgId, {
          domain: "social", signalType: intent === "complaint" ? "instagram_comment_complaint" : "instagram_comment_commercial",
          severity: intent === "complaint" ? "risk" : "attention", basis: "hypothesis", confidence: 0.6,
          sourceService: "InstagramCommentIntentService", sourceEntityType: "instagram_comment", sourceEntityId: id,
          subjectType: "instagram_comment", subjectId: id,
          evidence: {
            intent, product: product?.name ?? null, productVia: product?.via ?? null, fromUsername: c.fromUsername || null,
            snippet: this.snippet(c.text, 100), hasDraft: !!d.text,
            note: intent === "complaint" ? "Reclamação pública — responder com uma pessoa, sem resposta automática" : "Possível interesse de compra (palavras do comentário, não é confirmação) — revisar o rascunho e responder",
          },
          dedupeKey: `ig.comment|${id}`,
          expiresAt: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 19).replace("T", " "),
        } as any);
      } catch { /* o aviso é best-effort */ }
    }
    this.purgeOld(orgId);
    return { deduped: false as const, id, intent };
  }

  // ───────── leitura / ação do dono ─────────
  static list(orgId: string, opts: { status?: string; intent?: string; limit?: number } = {}) {
    const lim = Math.min(Math.max(Math.trunc(Number(opts.limit) || 50), 1), 200);
    let sql = `SELECT i.id, i.comment_id AS commentId, i.media_id AS mediaId, i.from_username AS fromUsername, i.snippet, i.intent, i.product_id AS productId,
                      p.name AS productName, i.product_via AS productVia, i.draft_reply AS draftReply, i.needs_human AS needsHuman, i.status, i.created_at AS createdAt,
                      i.replied_public_at AS repliedPublicAt, i.replied_private_at AS repliedPrivateAt
                 FROM instagram_comment_intents i LEFT JOIN products_services p ON p.id = i.product_id AND p.organization_id = i.organization_id
                WHERE i.organization_id = ?`;
    const params: any[] = [orgId];
    if (opts.status && (STATUSES as readonly string[]).includes(opts.status)) { sql += " AND i.status = ?"; params.push(opts.status); }
    if (opts.intent) { sql += " AND i.intent = ?"; params.push(opts.intent); }
    sql += " ORDER BY i.created_at DESC, i.rowid DESC LIMIT ?"; params.push(lim);
    // Respostas já propostas (aguardando/aprovadas) por comentário — para a tela mostrar "aguardando aprovação" em vez de propor de novo.
    const pend = new Map<string, Array<{ actionId: string; kind: string; status: string }>>();
    for (const a of db.prepare("SELECT id, status, command_payload_json FROM decision_actions WHERE organization_id = ? AND action_type = 'instagram_comment_reply' AND status IN ('awaiting_approval','approved')").all(orgId) as any[]) {
      try { const p = JSON.parse(a.command_payload_json || "{}"); if (p.intentId) (pend.get(p.intentId) || pend.set(p.intentId, []).get(p.intentId)!).push({ actionId: a.id, kind: p.kind, status: a.status }); } catch { /* noop */ }
    }
    const rows = (db.prepare(sql).all(...params) as any[]).map((r) => ({ ...r, needsHuman: r.needsHuman === 1, pendingReplies: pend.get(r.id) || [] }));
    const counts = db.prepare("SELECT intent, COUNT(*) n FROM instagram_comment_intents WHERE organization_id = ? AND status = 'new' GROUP BY intent").all(orgId) as any[];
    return { comments: rows, openByIntent: Object.fromEntries(counts.map((c) => [c.intent, c.n])), note: "Intenção por palavras do comentário (hipótese, não confirmação). O envio só acontece por resposta aprovada por uma pessoa." };
  }

  static dismiss(orgId: string, id: string): boolean {
    const r = db.prepare("UPDATE instagram_comment_intents SET status = 'dismissed' WHERE id = ? AND organization_id = ? AND status = 'new'").run(id, orgId);
    if (r.changes > 0) { try { BusinessSignalService.resolveByDedupe(orgId, `ig.comment|${id}`); } catch { /* noop */ } }
    return r.changes > 0;
  }

  static purgeOld(orgId: string): number {
    try { return db.prepare("DELETE FROM instagram_comment_intents WHERE organization_id = ? AND created_at < datetime('now', ?)").run(orgId, `-${RETENTION_DAYS} days`).changes; } catch { return 0; }
  }
}

export default InstagramCommentIntentService;
