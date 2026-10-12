import db from "./db.js";
import { ContentLeadAttributionService } from "./ContentLeadAttributionService.js";
import { ContentRevenueAttributionService } from "./ContentRevenueAttributionService.js";

/**
 * StorefrontAttributionService — ADR-207 F1: ATRIBUIÇÃO social → Loja Virtual ZapFlow.
 *
 * O link que o ZapFlow (ou o dono) põe no Instagram/Direct/bio carrega, na própria URL da loja
 * (`/loja/:slug[/produto/:p]`), quatro parâmetros opcionais: `zf_source` (canal), `zf_campaign`,
 * `zf_content` e `zf_ref` (o fio `correlation_id` da campanha/conteúdo — ADR-158). A vitrine os
 * guarda no navegador e os repete na visita e no pedido; aqui eles são validados e gravados.
 *
 * NÃO é um 2º mecanismo de atribuição (ADR-168 §37): o fio `zf_ref` liga o contato do pedido ao
 * conteúdo pelo `ContentLeadAttributionService` que já existe; o funil abaixo é só um read-model
 * DERIVADO por query (RN-004) de `storefront_events` + `orders`. Slug da loja NUNCA muda por campanha.
 *
 * REGRAS (testadas):
 *  - Aditivo e best-effort: sem parâmetros → comportamento idêntico ao anterior; falha aqui nunca
 *    derruba visita nem pedido.
 *  - Entrada pública = não confiável: só [A-Za-z0-9_.:-], tamanho curto, canal fora da lista vira
 *    "other"; sem PII (nada de e-mail/telefone/nome no link).
 *  - Vínculo de lead só com contato VÁLIDO da própria org (o token do link), nunca com id do body.
 *  - Receita só do que foi PAGO (fato); pedido ainda aguardando pagamento é contado à parte e
 *    NUNCA somado. Sem visitas → conversão null (nunca 0%). Margem só com TODO custo conhecido.
 *  - Atribuição declarada pelo link ≠ prova de causa: o funil diz "atribuído pelo link".
 */

const KNOWN_SOURCES = new Set(["instagram", "facebook", "whatsapp", "tiktok", "youtube", "linkedin", "x", "email", "google", "qrcode", "bio", "direct", "store"]);
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
const PAID_STATUSES = ["pago", "em_preparo", "entregue", "concluido"];

export interface Attribution { source: string | null; campaign: string | null; content: string | null; ref: string | null }

const clean = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const t = v.trim().slice(0, max);
  return t && SAFE.test(t) ? t : null;
};

export class StorefrontAttributionService {
  /** Normaliza o que veio do navegador. Tudo inválido → null (sem atribuição). */
  static sanitize(raw: any): Attribution | null {
    if (!raw || typeof raw !== "object") return null;
    let source = clean(raw.source, 30)?.toLowerCase() ?? null;
    if (source && !KNOWN_SOURCES.has(source)) source = "other";
    const a: Attribution = { source, campaign: clean(raw.campaign, 60), content: clean(raw.content, 60), ref: clean(raw.ref, 80) };
    return a.source || a.campaign || a.content || a.ref ? a : null;
  }

  /** Visita/clique da vitrine COM atribuição (a rota de evento chama no lugar do INSERT antigo quando há atribuição). */
  static recordEvent(orgId: string, id: string, type: string, productId: string | null, attr: Attribution | null): void {
    db.prepare(
      "INSERT INTO storefront_events (id, organization_id, type, product_id, attr_source, attr_campaign, attr_content, attr_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(id, orgId, type, productId, attr?.source ?? null, attr?.campaign ?? null, attr?.content ?? null, attr?.ref ?? null);
  }

  /** Grava a atribuição no pedido e, se há contato válido + fio, liga o lead ao conteúdo. Best-effort. */
  static attachToOrder(orgId: string, orderId: string, attr: Attribution | null, contactId: string | null): { stored: boolean; leadLinked: boolean } {
    if (!attr) return { stored: false, leadLinked: false };
    let stored = false, leadLinked = false;
    try {
      const r = db.prepare("UPDATE orders SET attr_source = ?, attr_campaign = ?, attr_content = ?, attr_ref = ? WHERE id = ? AND organization_id = ?")
        .run(attr.source, attr.campaign, attr.content, attr.ref, orderId, orgId);
      stored = r.changes > 0;
    } catch { /* best-effort */ }
    if (stored && attr.ref && contactId) {
      try { leadLinked = ContentLeadAttributionService.attribute(orgId, { correlationId: attr.ref, contactId, source: "storefront" }).attributed; } catch { /* contato inválido: não vincula */ }
    }
    return { stored, leadLinked };
  }

  /**
   * Funil por canal/campanha/conteúdo: visitas → cliques → pedidos → pagos → receita (fato).
   * Read-only, derivado. Dinheiro: a ROTA é do dono/administrador.
   */
  static funnel(orgId: string, opts: { days?: number } = {}) {
    const days = Math.min(Math.max(Math.trunc(Number(opts.days) || 30), 1), 365);
    const since = `-${days} days`;
    type Row = { source: string | null; campaign: string | null; content: string | null; views: number; productClicks: number; orders: number; paidOrders: number; awaitingOrders: number; revenuePaid: number; revenueAwaiting: number; marginPaid: number | null; conversionPct: number | null };
    const key = (s: any, c: any, ct: any) => `${s ?? ""}|${c ?? ""}|${ct ?? ""}`;
    const rows = new Map<string, Row>();
    const get = (s: any, c: any, ct: any): Row => {
      const k = key(s, c, ct);
      let r = rows.get(k);
      if (!r) { r = { source: s ?? null, campaign: c ?? null, content: ct ?? null, views: 0, productClicks: 0, orders: 0, paidOrders: 0, awaitingOrders: 0, revenuePaid: 0, revenueAwaiting: 0, marginPaid: null, conversionPct: null }; rows.set(k, r); }
      return r;
    };

    for (const e of db.prepare(
      `SELECT attr_source s, attr_campaign c, attr_content ct, type, COUNT(*) n FROM storefront_events
        WHERE organization_id = ? AND created_at >= datetime('now', ?) GROUP BY attr_source, attr_campaign, attr_content, type`
    ).all(orgId, since) as any[]) {
      const r = get(e.s, e.c, e.ct);
      if (e.type === "view") r.views += e.n; else if (e.type === "product_click") r.productClicks += e.n;
    }

    const marginKnown = new Map<string, { sum: number; allKnown: boolean; any: boolean }>();
    for (const o of db.prepare(
      `SELECT id, status, payment_status, total_amount, attr_source s, attr_campaign c, attr_content ct FROM orders
        WHERE organization_id = ? AND created_by = 'storefront' AND created_at >= datetime('now', ?) AND status NOT IN ('cancelado','reembolso','devolucao')`
    ).all(orgId, since) as any[]) {
      const r = get(o.s, o.c, o.ct);
      r.orders += 1;
      const paid = o.payment_status === "paid" || PAID_STATUSES.includes(o.status);
      if (paid) {
        r.paidOrders += 1; r.revenuePaid += Number(o.total_amount || 0);
        const k = key(o.s, o.c, o.ct);
        const m = marginKnown.get(k) || { sum: 0, allKnown: true, any: false };
        const mo = ContentRevenueAttributionService.marginForOrder(orgId, o.id);
        m.any = true;
        if (mo.margin == null) m.allKnown = false; else m.sum += mo.margin;
        marginKnown.set(k, m);
      } else { r.awaitingOrders += 1; r.revenueAwaiting += Number(o.total_amount || 0); }
    }

    const out = [...rows.values()].map((r) => {
      const m = marginKnown.get(key(r.source, r.campaign, r.content));
      r.marginPaid = m && m.any && m.allKnown ? Math.round(m.sum * 100) / 100 : null;   // custo desconhecido → null (não inventa lucro)
      r.conversionPct = r.views > 0 ? Math.round((r.paidOrders / r.views) * 1000) / 10 : null;
      r.revenuePaid = Math.round(r.revenuePaid * 100) / 100; r.revenueAwaiting = Math.round(r.revenueAwaiting * 100) / 100;
      return r;
    });
    const attributed = out.filter((r) => r.source || r.campaign || r.content).sort((a, b) => b.revenuePaid - a.revenuePaid || b.orders - a.orders);
    const none = out.find((r) => !r.source && !r.campaign && !r.content) || null;
    return {
      days, basis: "declared_by_link" as const,
      note: "Atribuição declarada pelo link que o cliente clicou; é a origem informada, não prova de causa.",
      attributed, unattributed: none,
    };
  }
}

export default StorefrontAttributionService;
