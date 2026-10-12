import db from "./db.js";
import { randomInt, randomUUID } from "crypto";
import { StorefrontAttributionService } from "./StorefrontAttributionService.js";
import { ensureProductSlug } from "./productSlug.js";

/**
 * Link curto de campanha da Loja Virtual (ADR-207 F5): `/loja/:slug/go/:codigo`.
 *
 * O link longo da F1 (`?zf_source=instagram&zf_campaign=...`) é feio e quebra quando alguém o digita. O dono
 * (ou a IA) gera um código curto; ao clicar, o cliente é redirecionado para a vitrine (ou para um produto)
 * COM a atribuição da F1 já anexada — a atribuição continua sendo a da F1 (mesmo sanitize, mesmo funil),
 * este serviço só cuida de gerar/guardar/resolver o atalho. Não é um 2º mecanismo de atribuição (ADR-168 §37).
 *
 * REGRAS (testadas):
 *  - O slug da LOJA nunca muda por campanha; o código é só um atalho. Link arquivado nunca dá 404 pro
 *    cliente: cai na vitrine SEM atribuição (link já espalhado não pode quebrar a compra).
 *  - Produto do link: resolvido no clique (slug atual) e só se ainda existir/estiver ativo na MESMA org.
 *  - "Visto no Instagram": só link `featured` de canal instagram COM produto, e só produto hoje visível na vitrine
 *    — nada inventado, nada de produto escondido/inativo.
 *  - Números por link são DERIVADOS do funil da F1 (visitas/pedidos/pago = fato); sem visita → conversão null.
 *  - Tudo por organização; código único por organização; sem PII no link (a sanitização da F1 vale).
 */

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"; // sem 0/o/1/i/l: legível por voz e à mão
const CODE_LEN = 7;
const MAX_ACTIVE = 300;
const SHELF_LIMIT = 12;

export interface ShortLinkInput { source?: string; campaign?: string; content?: string; ref?: string; productId?: string | null; label?: string; featured?: boolean }

// O dono digita "Promo Verão!"; a sanitização da F1 (só [A-Za-z0-9_.:-]) descartaria o valor inteiro em silêncio.
// O gerador normaliza ANTES (acento fora, espaço vira hífen, minúsculas em campanha/conteúdo — "Promo" e "promo" seriam
// duas linhas no funil) para o que ele digitou virar o que aparece no relatório. O `ref` é um id de correlação: mantém a caixa.
const norm = (v: unknown, lower = false): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().replace(/\s+/g, "-").replace(/[^A-Za-z0-9_.:-]/g, "").replace(/^[^A-Za-z0-9]+/, "");
  return t ? (lower ? t.toLowerCase() : t) : undefined;
};
const newCode = () => Array.from({ length: CODE_LEN }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
const shape = (r: any) => ({
  id: r.id, code: r.code, source: r.source, campaign: r.campaign, content: r.content, ref: r.ref,
  productId: r.product_id || null, label: r.label || null, featured: !!r.featured, active: !!r.active, createdAt: r.created_at,
});

export class StorefrontShortLinkService {
  /** Gera o atalho. Origem obrigatória (sem ela não há o que atribuir); produto, se citado, tem que ser desta org e estar ativo. */
  static create(orgId: string, input: ShortLinkInput, actorId?: string) {
    const attr = StorefrontAttributionService.sanitize({ source: norm(input.source), campaign: norm(input.campaign, true), content: norm(input.content, true), ref: norm(input.ref) });
    if (!attr?.source) throw new Error("Escolha de onde o link vai ser usado (Instagram, WhatsApp...).");
    let productId: string | null = null;
    if (input.productId) {
      const p = db.prepare("SELECT id FROM products_services WHERE id = ? AND organization_id = ? AND active = 1 AND type = 'product'").get(input.productId, orgId) as any;
      if (!p) throw new Error("Produto não encontrado.");
      productId = p.id;
    }
    const featured = !!input.featured;
    if (featured && (attr.source !== "instagram" || !productId)) throw new Error("A vitrine \"Visto no Instagram\" só aceita link do Instagram com um produto.");
    const active = (db.prepare("SELECT COUNT(*) c FROM storefront_short_links WHERE organization_id = ? AND active = 1").get(orgId) as any).c as number;
    if (active >= MAX_ACTIVE) throw new Error("Limite de links ativos atingido. Arquive os que não usa mais.");
    const label = typeof input.label === "string" ? input.label.trim().slice(0, 80) || null : null;
    for (let i = 0; i < 8; i++) {
      const id = randomUUID(), code = newCode();
      try {
        db.prepare(
          `INSERT INTO storefront_short_links (id, organization_id, code, source, campaign, content, ref, product_id, label, featured, active, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
        ).run(id, orgId, code, attr.source, attr.campaign, attr.content, attr.ref, productId, label, featured ? 1 : 0, actorId || null);
        return shape(db.prepare("SELECT * FROM storefront_short_links WHERE id = ?").get(id));
      } catch (e: any) {
        if (!String(e?.code || e?.message).includes("UNIQUE")) throw e; // colisão de código: tenta outro
      }
    }
    throw new Error("Não foi possível gerar um código agora. Tente de novo.");
  }

  /** Links da empresa com os números derivados do funil da F1 (período em dias). Dinheiro: a ROTA é do dono/admin. */
  static list(orgId: string, opts: { days?: number; includeArchived?: boolean } = {}) {
    const rows = db.prepare(
      `SELECT l.*, p.name AS product_name FROM storefront_short_links l
         LEFT JOIN products_services p ON p.id = l.product_id AND p.organization_id = l.organization_id
        WHERE l.organization_id = ? ${opts.includeArchived ? "" : "AND l.active = 1"} ORDER BY l.created_at DESC`
    ).all(orgId) as any[];
    const funnel = StorefrontAttributionService.funnel(orgId, { days: opts.days }) as any;
    const frows: any[] = Array.isArray(funnel?.attributed) ? funnel.attributed : [];
    return rows.map((r) => {
      const f = frows.find((x) => (x.source ?? null) === r.source && (x.campaign ?? null) === (r.campaign ?? null) && (x.content ?? null) === (r.content ?? null));
      return {
        ...shape(r), productName: r.product_name || null,
        // Os mesmos números do funil da F1 para a mesma origem+campanha+conteúdo (links iguais somam juntos). null = sem dado.
        results: f ? { views: f.views, orders: f.orders, paidOrders: f.paidOrders, revenuePaid: f.revenuePaid, conversionPct: f.conversionPct } : null,
      };
    });
  }

  /** Arquiva (nunca apaga): o código continua existindo e cai na vitrine sem atribuição. */
  static archive(orgId: string, id: string): boolean {
    return db.prepare("UPDATE storefront_short_links SET active = 0, featured = 0 WHERE id = ? AND organization_id = ?").run(id, orgId).changes > 0;
  }

  /** Liga/desliga a presença na vitrine "Visto no Instagram" (regra de elegibilidade igual à da criação). */
  static setFeatured(orgId: string, id: string, featured: boolean): boolean {
    const l = db.prepare("SELECT source, product_id, active FROM storefront_short_links WHERE id = ? AND organization_id = ?").get(id, orgId) as any;
    if (!l) return false;
    if (featured && (!l.active || l.source !== "instagram" || !l.product_id)) throw new Error("A vitrine \"Visto no Instagram\" só aceita link ativo do Instagram com um produto.");
    return db.prepare("UPDATE storefront_short_links SET featured = ? WHERE id = ? AND organization_id = ?").run(featured ? 1 : 0, id, orgId).changes > 0;
  }

  /**
   * Resolve o clique: para onde redirecionar. Loja inexistente/não publicada → null (404 normal da SPA).
   * Código desconhecido/arquivado/produto sumido → vitrine pura, SEM atribuição.
   */
  static resolve(slug: string, code: string): { path: string; attributed: boolean } | null {
    const store = db.prepare("SELECT organization_id, slug FROM storefront_settings WHERE slug = ? AND published = 1").get(slug) as any;
    if (!store) return null;
    const home = `/loja/${encodeURIComponent(store.slug)}`;
    const l = db.prepare("SELECT * FROM storefront_short_links WHERE organization_id = ? AND code = ? AND active = 1").get(store.organization_id, String(code || "").toLowerCase()) as any;
    if (!l) return { path: home, attributed: false };
    let base = home;
    if (l.product_id) {
      const p = db.prepare("SELECT id, name, slug FROM products_services WHERE id = ? AND organization_id = ? AND active = 1 AND COALESCE(storefront_visible,1) = 1").get(l.product_id, store.organization_id) as any;
      if (p) base = `${home}/produto/${encodeURIComponent(ensureProductSlug(store.organization_id, p))}`;
    }
    const q = new URLSearchParams();
    q.set("zf_source", l.source);
    if (l.campaign) q.set("zf_campaign", l.campaign);
    if (l.content) q.set("zf_content", l.content);
    if (l.ref) q.set("zf_ref", l.ref);
    return { path: `${base}?${q.toString()}`, attributed: true };
  }

  /** Prateleira pública "Visto no Instagram": produtos de link Instagram marcado, hoje visíveis, mais recente primeiro. */
  static shelf(orgId: string): { id: string; title: string; productIds: string[] } | null {
    const rows = db.prepare(
      `SELECT l.product_id FROM storefront_short_links l
         JOIN products_services p ON p.id = l.product_id AND p.organization_id = l.organization_id
        WHERE l.organization_id = ? AND l.active = 1 AND l.featured = 1 AND l.source = 'instagram'
          AND p.active = 1 AND p.type = 'product' AND COALESCE(p.storefront_visible,1) = 1
        ORDER BY l.created_at DESC`
    ).all(orgId) as any[];
    const ids: string[] = [];
    for (const r of rows) if (!ids.includes(r.product_id)) ids.push(r.product_id);
    return ids.length ? { id: "visto-no-instagram", title: "Visto no Instagram", productIds: ids.slice(0, SHELF_LIMIT) } : null;
  }
}

export default StorefrontShortLinkService;
