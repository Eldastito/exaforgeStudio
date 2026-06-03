import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { NotificationService } from "../NotificationService.js";

// ============================================================================
// LOJA VIRTUAL — rotas PÚBLICAS (sem autenticação).
// Montadas em server.ts ANTES do middleware de auth. O cliente acessa a vitrine
// por /loja/:slug; o front consome estes endpoints. Nada aqui expõe dados de
// outras organizações: tudo é resolvido a partir do slug público.
// ============================================================================

const router = Router();

const parseJson = (s: any, fallback: any) => {
  try { return s ? JSON.parse(s) : fallback; } catch { return fallback; }
};

// Avalia um cupom para um subtotal. Retorna o desconto e o motivo se inválido.
// Usado tanto na validação (carrinho) quanto na criação do pedido.
function evaluateCoupon(orgId: string, rawCode: string, subtotal: number): { valid: boolean; discount: number; message: string; coupon?: any } {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { valid: false, discount: 0, message: "Informe um cupom." };
  const c = db.prepare("SELECT * FROM storefront_coupons WHERE organization_id = ? AND code = ?").get(orgId, code) as any;
  if (!c || !c.active) return { valid: false, discount: 0, message: "Cupom inválido." };
  if (c.expires_at && new Date(c.expires_at).getTime() < Date.now()) return { valid: false, discount: 0, message: "Cupom expirado." };
  if (c.usage_limit != null && c.used_count >= c.usage_limit) return { valid: false, discount: 0, message: "Cupom esgotado." };
  if (subtotal < (c.min_order || 0)) return { valid: false, discount: 0, message: `Pedido mínimo de R$ ${Number(c.min_order).toFixed(2)} para este cupom.` };
  let discount = c.type === "percent" ? subtotal * (Number(c.value) / 100) : Number(c.value);
  discount = Math.min(discount, subtotal); // nunca maior que o subtotal
  discount = Math.round(discount * 100) / 100;
  return { valid: true, discount, message: "", coupon: c };
}

// Resolve a loja publicada a partir do slug. Retorna null se não existir/publicada.
function resolveStore(slug: string): any {
  const store = db.prepare(
    `SELECT s.*, o.business_name, o.phone AS org_phone, o.logo_url AS org_logo
       FROM storefront_settings s
       LEFT JOIN organization_settings o ON o.organization_id = s.organization_id
      WHERE s.slug = ? AND s.published = 1`
  ).get(slug) as any;
  return store || null;
}

// Monta o payload de um produto para a vitrine (imagens + modo de venda + estoque).
function productPayload(orgId: string, p: any): any {
  const images = db.prepare(
    `SELECT url FROM product_images WHERE product_service_id = ? ORDER BY position ASC, created_at ASC`
  ).all(p.id) as any[];

  let available = true;
  if (p.stock_control_enabled) {
    const inv = db.prepare(
      `SELECT COALESCE(SUM(quantity_available - quantity_reserved), 0) AS sellable
         FROM inventory_items WHERE product_service_id = ?`
    ).get(p.id) as any;
    available = (inv?.sellable ?? 0) > 0;
  }

  return {
    id: p.id,
    name: p.name,
    description: p.description || "",
    price: p.price || 0,
    currency: p.currency || "BRL",
    sale_mode: p.sale_mode || "unit",
    sale_options: parseJson(p.sale_options_json, {}),
    featured: !!p.featured,
    available,
    images: images.map(i => i.url),
  };
}

// GET /api/public/store/:slug  -> configurações da loja + produtos visíveis
router.get("/store/:slug", (req, res): any => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada ou não publicada." });

  const orgId = store.organization_id;
  const products = db.prepare(
    `SELECT * FROM products_services
      WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible, 1) = 1
        AND type = 'product'
      ORDER BY featured DESC, name ASC`
  ).all(orgId) as any[];

  // Valida o token de contato (se veio) — só para registrar de quem é o acesso.
  let linkedContact: any = null;
  const token = (req.query.c as string) || "";
  if (token) {
    const link = db.prepare(
      `SELECT contact_id FROM storefront_links WHERE token = ? AND organization_id = ?`
    ).get(token, orgId) as any;
    if (link?.contact_id) {
      const c = db.prepare(`SELECT name FROM contacts WHERE id = ?`).get(link.contact_id) as any;
      if (c) linkedContact = { name: c.name || "" };
    }
  }

  res.json({
    store: {
      slug: store.slug,
      title: store.title || store.business_name || "Nossa Loja",
      subtitle: store.subtitle || "",
      logo_url: store.logo_url || store.org_logo || "",
      banner_url: store.banner_url || "",
      accent_color: store.accent_color || "#ec4899",
      default_mode: store.default_mode === "day" ? "day" : "night",
    },
    customer: linkedContact,
    products: products.map(p => productPayload(orgId, p)),
  });
});

// POST /api/public/store/:slug/coupon  { code, subtotal } -> valida o cupom
router.post("/store/:slug/coupon", (req, res): any => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada." });
  const r = evaluateCoupon(store.organization_id, req.body?.code || "", Number(req.body?.subtotal || 0));
  res.json({
    valid: r.valid, discount: r.discount, message: r.message,
    code: String(req.body?.code || "").trim().toUpperCase(),
    type: r.coupon?.type, value: r.coupon?.value,
  });
});

// POST /api/public/store/:slug/order
// Body: { token?, customer?: {name, phone}, items: [{ productId, quantity, option }] }
//   option: { type:'size', value:'M' } | { type:'weight', grams:500 } | { type:'volume', ml:500 } | null
// Cria um pedido 'aguardando_pagamento'. Vincula ao contato se houver token.
router.post("/store/:slug/order", (req, res): any => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada." });
  const orgId = store.organization_id;

  const body = req.body || {};
  const rawItems: any[] = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return res.status(400).json({ error: "Carrinho vazio." });

  // Resolve contato pelo token (preferido) ou cria/usa pelos dados informados.
  let contactId: string | null = null;
  let ticketId: string | null = null;
  if (body.token) {
    const link = db.prepare(
      `SELECT contact_id, ticket_id FROM storefront_links WHERE token = ? AND organization_id = ?`
    ).get(body.token, orgId) as any;
    if (link) { contactId = link.contact_id || null; ticketId = link.ticket_id || null; }
  }

  try {
    const orderId = uuidv4();
    const resolved: { id: string; pid: string | null; name: string; price: number; qty: number; label: string | null; total: number }[] = [];

    for (const it of rawItems) {
      const p = db.prepare(
        `SELECT * FROM products_services WHERE id = ? AND organization_id = ? AND active = 1`
      ).get(it.productId, orgId) as any;
      if (!p) continue;

      const mode = p.sale_mode || "unit";
      const qty = Math.max(1, Number(it.quantity) || 1);
      const opt = it.option || null;
      let unitPrice = p.price || 0;
      let label: string | null = null;
      let nameSnapshot = p.name;
      let linkProduct = true;

      if (mode === "weight" && opt?.grams) {
        // price é por kg. Não vincula estoque (quantidade fracionada).
        const grams = Math.max(1, Number(opt.grams) || 0);
        unitPrice = (p.price || 0) * (grams / 1000);
        label = grams >= 1000 ? `${(grams / 1000).toFixed(grams % 1000 === 0 ? 0 : 2)} kg` : `${grams} g`;
        nameSnapshot = `${p.name} — ${label}`;
        linkProduct = false;
      } else if (mode === "volume" && opt?.ml) {
        const ml = Math.max(1, Number(opt.ml) || 0);
        unitPrice = (p.price || 0) * (ml / 1000);
        label = ml >= 1000 ? `${(ml / 1000).toFixed(ml % 1000 === 0 ? 0 : 2)} L` : `${ml} ml`;
        nameSnapshot = `${p.name} — ${label}`;
        linkProduct = false;
      } else if (mode === "size" && opt?.value) {
        label = String(opt.value);
        nameSnapshot = `${p.name} (${label})`;
      }

      resolved.push({
        id: uuidv4(), pid: linkProduct ? p.id : null, name: nameSnapshot,
        price: unitPrice, qty, label, total: unitPrice * qty,
      });
    }

    if (resolved.length === 0) return res.status(400).json({ error: "Nenhum item válido." });
    const subtotal = resolved.reduce((s, r) => s + r.total, 0);

    // Cupom (opcional): revalida no servidor e aplica o desconto.
    let discount = 0;
    let couponCode: string | null = null;
    let couponId: string | null = null;
    if (body.coupon) {
      const cr = evaluateCoupon(orgId, body.coupon, subtotal);
      if (cr.valid && cr.coupon) { discount = cr.discount; couponCode = cr.coupon.code; couponId = cr.coupon.id; }
    }
    const total = Math.max(0, Math.round((subtotal - discount) * 100) / 100);

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO orders (id, organization_id, contact_id, ticket_id, status, total_amount, discount_amount, coupon_code, created_by, notes)
         VALUES (?, ?, ?, ?, 'aguardando_pagamento', ?, ?, ?, 'storefront', ?)`
      ).run(orderId, orgId, contactId, ticketId, total, discount, couponCode, body.customer?.name ? `Cliente: ${body.customer.name}${body.customer.phone ? ` (${body.customer.phone})` : ""}` : null);

      const stmt = db.prepare(
        `INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total, variant_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of resolved) {
        stmt.run(r.id, orderId, orgId, r.pid, r.name, r.price, r.qty, r.total, r.label);
      }
      if (couponId) db.prepare("UPDATE storefront_coupons SET used_count = used_count + 1 WHERE id = ?").run(couponId);
    });
    tx();

    const brl = (v: number) => `R$ ${Number(v).toFixed(2)}`;
    const lines = resolved.map(r => `• ${r.qty}× ${r.name} — ${brl(r.total)}`).join("\n");
    // Bloco de totais: mostra desconto quando há cupom.
    const totalsBlock = discount > 0
      ? `Subtotal: ${brl(subtotal)}\nDesconto (${couponCode}): -${brl(discount)}\nTotal: ${brl(total)}`
      : `Total: ${brl(total)}`;

    // O pedido CAI NO ATENDIMENTO: notifica a equipe (sino) e, se há contato
    // vinculado (via token), registra o pedido na conversa do Kanban ao vivo.
    // Best-effort: nunca quebra a resposta ao cliente.
    try {
      const custName = body.customer?.name || (contactId
        ? (db.prepare("SELECT name FROM contacts WHERE id = ?").get(contactId) as any)?.name
        : null) || "Cliente da vitrine";
      NotificationService.storeOrder(orgId, custName, total);

      const io = NotificationService.io;
      if (io) io.to(`org:${orgId}`).emit("order_created", { orderId, status: "aguardando_pagamento", total, contactId });

      if (contactId) {
        // Acha (ou cria) um ticket aberto do contato e injeta a nota do pedido.
        let ticket = db.prepare(
          "SELECT id FROM tickets WHERE contact_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1"
        ).get(contactId) as any;
        if (!ticket) {
          const tid = uuidv4();
          db.prepare(
            "INSERT INTO tickets (id, organization_id, contact_id, status, stage, ai_paused) VALUES (?, ?, ?, 'open', 'aguardando_pagamento', 0)"
          ).run(tid, orgId, contactId);
          ticket = { id: tid };
        }
        if (ticketId == null) db.prepare("UPDATE orders SET ticket_id = ? WHERE id = ?").run(ticket.id, orderId);

        const noteText = `🛒 *Novo pedido pela vitrine*\n${lines}\n\n${totalsBlock}\n(pedido #${orderId.slice(0, 8)})`;
        const msgId = uuidv4();
        db.prepare(
          "INSERT INTO messages (id, organization_id, ticket_id, sender_type, content) VALUES (?, ?, ?, 'bot', ?)"
        ).run(msgId, orgId, ticket.id, noteText);
        if (io) {
          io.to(`org:${orgId}`).emit("new_message", {
            id: msgId, ticketId: ticket.id, contactId,
            text: noteText, sender: "bot", timestamp: new Date().toISOString(),
          });
        }
      }
    } catch (e) { /* notificação/ticket é best-effort */ }

    // Link de WhatsApp para o cliente finalizar (a IA/loja cobra por lá).
    const phone = (store.whatsapp_number || store.org_phone || "").replace(/\D/g, "");
    const msg = `Olá! Quero finalizar meu pedido da loja:\n\n${lines}\n\n${totalsBlock}\n(pedido #${orderId.slice(0, 8)})`;
    const whatsappUrl = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(msg)}` : null;

    res.json({ ok: true, orderId, total, whatsappUrl });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao criar pedido." });
  }
});

export default router;
