import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { NotificationService } from "../NotificationService.js";
import { PaymentService } from "../PaymentService.js";
import { GoogleAutomationService } from "../GoogleAutomationService.js";
import { ReservationService } from "../ReservationService.js";
import { ensureProductSlug } from "../productSlug.js";
import { FashionStudioService } from "../FashionStudioService.js";
import { FashionLookService } from "../FashionLookService.js";
import { RetailOnlineReserveService } from "../RetailOnlineReserveService.js";

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
    // slug preguiçoso (ADR-028): produtos criados por caminhos antigos podem
    // ainda não ter slug — a vitrine garante um na primeira renderização.
    slug: ensureProductSlug(orgId, p),
    name: p.name,
    description: p.description || "",
    price: p.price || 0,
    currency: p.currency || "BRL",
    sale_mode: p.sale_mode || "unit",
    sale_options: parseJson(p.sale_options_json, {}),
    category: p.category || null,
    featured: !!p.featured,
    available,
    images: images.map(i => i.url),
  };
}

// Resolve as coleções configuradas da loja para listas de IDs de produto,
// dentro do conjunto visível (active=1 e visível na vitrine). Retorna apenas
// coleções não-vazias. A LP renderiza cada uma como uma seção com título.
function resolveCollections(orgId: string): { id: string; title: string; productIds: string[] }[] {
  const collections = db.prepare(
    `SELECT id, title, rule, items_json FROM storefront_collections WHERE organization_id = ? ORDER BY position ASC, created_at ASC`
  ).all(orgId) as any[];
  if (collections.length === 0) return [];

  const visibleWhere = `organization_id = ? AND active = 1 AND COALESCE(storefront_visible, 1) = 1 AND type = 'product'`;
  // Conjunto de IDs visíveis (para filtrar coleções manuais).
  const visibleIds = new Set((db.prepare(
    `SELECT id FROM products_services WHERE ${visibleWhere}`
  ).all(orgId) as any[]).map(r => r.id));
  const out: { id: string; title: string; productIds: string[] }[] = [];

  for (const c of collections) {
    let ids: string[] = [];
    if (c.rule === 'manual') {
      let chosen: string[] = [];
      try { chosen = JSON.parse(c.items_json || '[]'); } catch { chosen = []; }
      ids = chosen.filter((id: string) => visibleIds.has(id)); // preserva a ordem escolhida
    } else if (c.rule === 'best_sellers') {
      ids = (db.prepare(
        `SELECT ps.id FROM products_services ps
           JOIN (
             SELECT oi.product_service_id, SUM(oi.quantity) units
             FROM order_items oi JOIN orders o ON o.id = oi.order_id
             WHERE o.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
             GROUP BY oi.product_service_id
           ) s ON s.product_service_id = ps.id
          WHERE ps.${visibleWhere}
          ORDER BY s.units DESC LIMIT 12`
      ).all(orgId, orgId) as any[]).map(r => r.id);
    } else if (c.rule === 'newest') {
      ids = (db.prepare(
        `SELECT id FROM products_services WHERE ${visibleWhere} ORDER BY created_at DESC LIMIT 12`
      ).all(orgId) as any[]).map(r => r.id);
    } else { // 'featured' (padrão)
      ids = (db.prepare(
        `SELECT id FROM products_services WHERE ${visibleWhere} AND featured = 1 ORDER BY name ASC`
      ).all(orgId) as any[]).map(r => r.id);
    }
    if (ids.length) out.push({ id: c.id, title: c.title, productIds: ids });
  }
  return out;
}

// GET /api/public/store/:slug/fashion/eligible -> catálogo elegível para o
// provador virtual (Fashion AI Studio, FAS-0 / ADR-034). 404 quando o módulo
// está desligado na loja — indistinguível de rota inexistente de propósito
// (não revela que a loja tem o recurso disponível mas desativado).
router.get("/store/:slug/fashion/eligible", async (req, res): Promise<any> => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada ou não publicada." });
  const orgId = store.organization_id;
  if (!FashionStudioService.isEnabled(orgId)) return res.status(404).json({ error: "Recurso não disponível." });

  // ADR-041: só roupa/acessório aparece no provador — classifica pendentes
  // (heurística + IA) antes de montar a lista.
  try { await FashionStudioService.ensureWearableClassified(orgId); } catch { /* best-effort */ }
  const items = FashionStudioService.eligibleItems(orgId);
  FashionStudioService.recordEvent(orgId, "FashionEligibleCatalogViewed", { itemCount: items.length });
  res.json({ enabled: true, dailyGenerationLimit: FashionStudioService.dailyGenerationLimit(orgId), items });
});

// GET /api/public/store/:slug/looks -> galeria de looks (lookbook) da vitrine:
// os looks publicados com a foto do avatar vestindo (ADR-104 Bloco 3).
router.get("/store/:slug/looks", async (req, res): Promise<any> => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada ou não publicada." });
  const { StorefrontLookGenerationService } = await import("../StorefrontLookGenerationService.js");
  res.json({ looks: StorefrontLookGenerationService.publicLookbook(store.organization_id) });
});

// GET /api/public/store/:slug  -> configurações da loja + produtos visíveis
router.get("/store/:slug", (req, res): any => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada ou não publicada." });

  const orgId = store.organization_id;
  const products = db.prepare(
    `SELECT * FROM products_services
      WHERE organization_id = ? AND active = 1 AND COALESCE(storefront_visible, 1) = 1
        AND type = 'product'
      ORDER BY COALESCE(storefront_position, 999999) ASC, name ASC`
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
    collections: resolveCollections(orgId),
    resources: ReservationService.listResources(orgId),
  });
});

// GET /api/public/store/:slug/reservations/availability?resource=&start=&end=&units=
router.get("/store/:slug/reservations/availability", (req, res): any => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada." });
  const { resource, start, end } = req.query as any;
  const units = parseInt(String(req.query.units || "1"), 10) || 1;
  if (!resource || !start || !end) return res.status(400).json({ error: "Informe resource, start e end." });
  res.json(ReservationService.availability(store.organization_id, String(resource), String(start), String(end), units));
});

// POST /api/public/store/:slug/reservation — cria reserva pela vitrine (+ sinal).
router.post("/store/:slug/reservation", async (req, res): Promise<any> => {
  const store = resolveStore(req.params.slug);
  if (!store) return res.status(404).json({ error: "Loja não encontrada." });
  const orgId = store.organization_id;
  const body = req.body || {};
  if (!body.resourceId || !body.start || !body.end) return res.status(400).json({ error: "Dados incompletos." });

  // Contato pelo token (se o cliente veio pelo link), senão segue sem contato.
  let contactId: string | null = null; let ticketId: string | null = null;
  if (body.token) {
    const link = db.prepare(`SELECT contact_id, ticket_id FROM storefront_links WHERE token = ? AND organization_id = ?`).get(body.token, orgId) as any;
    if (link) { contactId = link.contact_id || null; ticketId = link.ticket_id || null; }
  }
  const cust = body.customer || {};
  if (!contactId && !String(cust.name || "").trim()) return res.status(400).json({ error: "Informe seu nome." });

  try {
    const resource = ReservationService.getResource(orgId, String(body.resourceId));
    if (!resource) return res.status(400).json({ error: "Recurso não encontrado." });
    const units = Math.max(1, Number(body.units) || 1);
    const start = new Date(body.start).toISOString();
    const end = new Date(body.end).toISOString();
    const av = ReservationService.availability(orgId, resource.id, start, end, units);
    if (!av.ok) return res.status(400).json({ error: "Período inválido." });
    if (!av.bookable) return res.status(409).json({ error: `Sem disponibilidade (${av.livres} de ${av.capacity} livre(s)).` });

    const r = ReservationService.create(orgId, {
      resourceId: resource.id, contactId: contactId || undefined, ticketId: ticketId || undefined,
      startAt: start, endAt: end, units, guests: body.guests, createdBy: "storefront",
    });
    // Guarda dados do cliente na reserva (e e-mail no contato, se houver).
    const note = [cust.name && `Cliente: ${cust.name}`, cust.phone && `Tel: ${cust.phone}`, cust.email && `E-mail: ${cust.email}`].filter(Boolean).join(" · ");
    if (note) { try { db.prepare("UPDATE reservations SET notes = ? WHERE id = ?").run(note, r.id); } catch {} }
    if (contactId && String(cust.email || "").trim()) { try { db.prepare("UPDATE contacts SET email = ? WHERE id = ?").run(String(cust.email).trim(), contactId); } catch {} }

    const resv = db.prepare("SELECT total_amount, deposit_amount FROM reservations WHERE id = ?").get(r.id) as any;
    const total = Number(resv?.total_amount || 0);
    const deposit = Number(resv?.deposit_amount || 0);

    try { NotificationService.io?.to(`org:${orgId}`).emit("reservation_created", { id: r.id, contactId }); } catch {}

    // Sinal: monta o bloco de pagamento (igual ao do pedido).
    let payment: any = { method: "none" };
    if (deposit > 0) {
      try {
        const pset = PaymentService.getSettings(orgId);
        if (pset?.pay_enabled) {
          const provider = pset.pay_provider || "pix_manual";
          if (provider === "mercadopago") {
            const charge = await PaymentService.createReservationPix(orgId, { reservationId: r.id, amount: deposit, contactName: cust.name || "Cliente", contactId: contactId || undefined });
            if (charge) payment = { method: "mercadopago", pix: { qrCode: charge.qrCode, qrCodeBase64: charge.qrCodeBase64, ticketUrl: charge.ticketUrl } };
          } else if (provider === "pix_manual" && pset.pay_pix_key) {
            payment = { method: "pix_manual", manual: { key: pset.pay_pix_key, name: pset.pay_pix_name || "", instructions: pset.pay_instructions || "" } };
          }
        }
      } catch (e) { /* best-effort */ }
    }
    res.json({ ok: true, reservationId: r.id, total, deposit, payment });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha ao reservar." });
  }
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

// POST /api/public/store/:slug/event  { type, productId? } -> registra visita/clique
// Usado para o relatório da vitrine. Best-effort, nunca quebra a navegação.
router.post("/store/:slug/event", (req, res): any => {
  try {
    const store = resolveStore(req.params.slug);
    if (!store) return res.status(204).end();
    const type = String(req.body?.type || "");
    if (!["view", "product_click"].includes(type)) return res.status(204).end();
    const productId = type === "product_click" ? (req.body?.productId || null) : null;
    db.prepare(
      "INSERT INTO storefront_events (id, organization_id, type, product_id) VALUES (?, ?, ?, ?)"
    ).run(uuidv4(), store.organization_id, type, productId);
  } catch (e) { /* best-effort */ }
  res.status(204).end();
});

// POST /api/public/store/:slug/order
// Body: { token?, customer?: {name, phone}, items: [{ productId, quantity, option }] }
//   option: { type:'size', value:'M' } | { type:'weight', grams:500 } | { type:'volume', ml:500 } | null
// Cria um pedido 'aguardando_pagamento'. Vincula ao contato se houver token.
router.post("/store/:slug/order", async (req, res): Promise<any> => {
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

    // Atribuição comercial pedido<->look (Fashion AI Studio FAS-4, RF-027):
    // valida que o look é DESTA organização antes de gravar — um id forjado
    // no body nunca vira atribuição.
    const fashionLookId = FashionLookService.lookIdForOrder(orgId, body.fashionLookId);

    // Notas do pedido: nome/telefone (se anônimo informou) + "CPF na nota"
    // (opcional, ADR-096 — nunca bloqueante; a parte fiscal é do cupom da
    // impressora do lojista, a loja não emite NF-e no piloto).
    const cpfNota = String(body.customer?.cpf || "").replace(/[^\d]/g, "").slice(0, 14);
    const noteParts = [
      body.customer?.name ? `Cliente: ${body.customer.name}${body.customer.phone ? ` (${body.customer.phone})` : ""}` : null,
      cpfNota ? `CPF na nota: ${cpfNota}` : null,
    ].filter(Boolean);
    const orderNotes = noteParts.length ? noteParts.join(" · ") : null;

    // Loja Virtual → PDV (ADR-143 Fase 0): quando a reserva e-commerce está ligada
    // e há uma filial online definida, o storefront vende SÓ da reserva daquela
    // loja — sem oversell — e registra a baixa pendente no PDV. store_id no pedido.
    const onlineStoreId = RetailOnlineReserveService.isEnabled(orgId) ? RetailOnlineReserveService.getOnlineStoreId(orgId) : null;

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO orders (id, organization_id, contact_id, ticket_id, status, total_amount, discount_amount, coupon_code, created_by, notes, fashion_look_id, store_id)
         VALUES (?, ?, ?, ?, 'aguardando_pagamento', ?, ?, ?, 'storefront', ?, ?, ?)`
      ).run(orderId, orgId, contactId, ticketId, total, discount, couponCode, orderNotes, fashionLookId, onlineStoreId);
      if (fashionLookId) {
        FashionStudioService.recordEvent(orgId, "FashionOrderPlaced", { orderId, total }, null, fashionLookId);
      }

      const stmt = db.prepare(
        `INSERT INTO order_items (id, order_id, organization_id, product_service_id, name_snapshot, unit_price, quantity, line_total, variant_label)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const r of resolved) {
        stmt.run(r.id, orderId, orgId, r.pid, r.name, r.price, r.qty, r.total, r.label);
      }
      if (couponId) db.prepare("UPDATE storefront_coupons SET used_count = used_count + 1 WHERE id = ?").run(couponId);

      // Reserva/baixa online: bloqueia se a reserva não cobrir (o throw desfaz o
      // pedido inteiro). Itens sem produto vinculado (peso/volume) não entram.
      if (onlineStoreId) {
        const r = RetailOnlineReserveService.recordSale(orgId, {
          orderId, storeId: onlineStoreId,
          items: resolved.filter((x) => x.pid).map((x) => ({ productId: x.pid as string, variantId: null, qty: x.qty })),
        });
        if (r.ok === false) {
          const names = (r.blocked || []).map((b) => resolved.find((x) => x.pid === b.productId)?.name || b.productId).join(", ");
          throw new Error(`ONLINE_OUT_OF_STOCK:${names}`);
        }
      }
    });
    tx();
    // E-mail informado no checkout: guarda no contato (se houver) para confirmações.
    const customerEmail = (body.customer?.email || "").trim();
    if (customerEmail && contactId) {
      try { db.prepare("UPDATE contacts SET email = ? WHERE id = ?").run(customerEmail, contactId); } catch (e) { /* noop */ }
    }
    // Automações Google: planilha de vendas + confirmação por e-mail (best-effort).
    GoogleAutomationService.logOrder(orgId, orderId).catch(() => {});
    GoogleAutomationService.confirmOrder(orgId, orderId, customerEmail).catch(() => {});

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

    // Link de WhatsApp para o cliente finalizar (vira opção SECUNDÁRIA).
    const phone = (store.whatsapp_number || store.org_phone || "").replace(/\D/g, "");
    const msg = `Olá! Quero finalizar meu pedido da loja:\n\n${lines}\n\n${totalsBlock}\n(pedido #${orderId.slice(0, 8)})`;
    const whatsappUrl = phone ? `https://wa.me/${phone}?text=${encodeURIComponent(msg)}` : null;

    // PAGAMENTO NA PRÓPRIA LOJA: encurta a jornada — o cliente paga aqui, sem ir
    // ao WhatsApp. Mercado Pago = PIX dinâmico (QR + copia-e-cola, confirma sozinho
    // via webhook); pix_manual = chave do lojista. Best-effort.
    let payment: any = { method: "none" };
    try {
      const pset = PaymentService.getSettings(orgId);
      if (pset?.pay_enabled) {
        const provider = pset.pay_provider || "pix_manual";
        if (provider === "mercadopago") {
          const custName = body.customer?.name || "Cliente";
          const charge = await PaymentService.createMercadoPagoPix(orgId, {
            orderId, amount: total, contactName: custName, contactId: contactId || undefined,
          });
          if (charge) {
            payment = { method: "mercadopago", pix: { qrCode: charge.qrCode, qrCodeBase64: charge.qrCodeBase64, ticketUrl: charge.ticketUrl } };
          }
        } else if (provider === "pix_manual" && pset.pay_pix_key) {
          payment = { method: "pix_manual", manual: { key: pset.pay_pix_key, name: pset.pay_pix_name || "", instructions: pset.pay_instructions || "" } };
        }
      }
    } catch (e) { /* pagamento é best-effort; cai no WhatsApp se falhar */ }

    res.json({ ok: true, orderId, total, whatsappUrl, payment });
  } catch (e: any) {
    const msg = String(e?.message || "");
    if (msg.startsWith("ONLINE_OUT_OF_STOCK:")) {
      return res.status(409).json({ error: `Sem estoque disponível na loja para: ${msg.slice("ONLINE_OUT_OF_STOCK:".length)}.`, code: "out_of_stock" });
    }
    res.status(500).json({ error: e.message || "Falha ao criar pedido." });
  }
});

export default router;
