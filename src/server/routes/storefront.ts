import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { chat, isAIConfigured } from "../llm.js";

// ============================================================================
// LOJA VIRTUAL — rotas do DONO (autenticadas, sob /api/storefront).
// Configuração da vitrine, imagens dos produtos, modo de venda e geração do
// link público (com token de contato) que a IA envia ao cliente.
// ============================================================================

const router = Router();
const getOrgId = (req: any) => req.organizationId || req.headers["x-organization-id"] || "default_org";
const slugify = (s: string) =>
  (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// Garante uma linha de settings para a org (cria o default na primeira vez).
function ensureSettings(orgId: string): any {
  let s = db.prepare("SELECT * FROM storefront_settings WHERE organization_id = ?").get(orgId) as any;
  if (!s) {
    const org = db.prepare("SELECT business_name FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    let base = slugify(org?.business_name || "") || `loja-${orgId.slice(0, 6)}`;
    // Garante slug único.
    let slug = base, n = 1;
    while (db.prepare("SELECT 1 FROM storefront_settings WHERE slug = ?").get(slug)) slug = `${base}-${++n}`;
    db.prepare(
      `INSERT INTO storefront_settings (organization_id, slug, title, default_mode, accent_color, published)
       VALUES (?, ?, ?, 'night', '#ec4899', 0)`
    ).run(orgId, slug, org?.business_name || "Nossa Loja");
    s = db.prepare("SELECT * FROM storefront_settings WHERE organization_id = ?").get(orgId);
  }
  return s;
}

// GET /api/storefront/settings
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  res.json(ensureSettings(orgId));
});

// PUT /api/storefront/settings
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  ensureSettings(orgId);
  const b = req.body || {};
  const fields: Record<string, any> = {};
  for (const k of ["title", "subtitle", "logo_url", "banner_url", "accent_color", "default_mode", "whatsapp_number", "published"]) {
    if (b[k] !== undefined) fields[k] = k === "published" ? (b[k] ? 1 : 0) : b[k];
  }
  // Slug: valida unicidade (não pode colidir com outra org).
  if (b.slug !== undefined) {
    const slug = slugify(b.slug);
    if (!slug) return res.status(400).json({ error: "Slug inválido." });
    const clash = db.prepare("SELECT organization_id FROM storefront_settings WHERE slug = ? AND organization_id != ?").get(slug, orgId);
    if (clash) return res.status(409).json({ error: "Esse endereço (slug) já está em uso." });
    fields.slug = slug;
  }
  if (Object.keys(fields).length) {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(", ");
    db.prepare(`UPDATE storefront_settings SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
      .run(...Object.values(fields), orgId);
  }
  res.json(db.prepare("SELECT * FROM storefront_settings WHERE organization_id = ?").get(orgId));
});

// POST /api/storefront/link  { contactId?, ticketId? } -> link público com token
router.post("/link", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const s = ensureSettings(orgId);
  const token = uuidv4().replace(/-/g, "").slice(0, 16);
  db.prepare(
    `INSERT INTO storefront_links (token, organization_id, contact_id, ticket_id, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', '+30 days'))`
  ).run(token, orgId, req.body?.contactId || null, req.body?.ticketId || null);
  res.json({ token, path: `/loja/${s.slug}?c=${token}`, slug: s.slug });
});

// ============================================================================
// CUPONS de desconto da vitrine.
// ============================================================================
const couponView = (c: any) => ({
  id: c.id, code: c.code, type: c.type, value: c.value, min_order: c.min_order,
  active: !!c.active, expires_at: c.expires_at, usage_limit: c.usage_limit, used_count: c.used_count,
});

// GET /api/storefront/coupons
router.get("/coupons", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const rows = db.prepare("SELECT * FROM storefront_coupons WHERE organization_id = ? ORDER BY created_at DESC").all(orgId) as any[];
  res.json(rows.map(couponView));
});

// POST /api/storefront/coupons  { code, type, value, min_order?, expires_at?, usage_limit? }
router.post("/coupons", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const b = req.body || {};
  const code = String(b.code || "").trim().toUpperCase().replace(/\s+/g, "");
  const type = b.type === "fixed" ? "fixed" : "percent";
  const value = Number(b.value);
  if (!code) return res.status(400).json({ error: "Informe o código do cupom." });
  if (!Number.isFinite(value) || value <= 0) return res.status(400).json({ error: "Valor do desconto inválido." });
  if (type === "percent" && value > 100) return res.status(400).json({ error: "Percentual não pode passar de 100%." });
  const id = uuidv4();
  try {
    db.prepare(
      `INSERT INTO storefront_coupons (id, organization_id, code, type, value, min_order, expires_at, usage_limit, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(id, orgId, code, type, value, Number(b.min_order) || 0, b.expires_at || null,
      b.usage_limit != null && b.usage_limit !== "" ? Math.max(1, parseInt(String(b.usage_limit), 10)) : null);
  } catch (e: any) {
    if (String(e.message || "").includes("UNIQUE")) return res.status(409).json({ error: "Já existe um cupom com esse código." });
    return res.status(500).json({ error: e.message });
  }
  res.json(couponView(db.prepare("SELECT * FROM storefront_coupons WHERE id = ?").get(id)));
});

// PUT /api/storefront/coupons/:id  -> edita (ativar/desativar, valor, etc.)
router.put("/coupons/:id", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const c = db.prepare("SELECT id FROM storefront_coupons WHERE id = ? AND organization_id = ?").get(req.params.id, orgId);
  if (!c) return res.status(404).json({ error: "Cupom não encontrado." });
  const b = req.body || {};
  const sets: string[] = []; const vals: any[] = [];
  if (b.active !== undefined) { sets.push("active = ?"); vals.push(b.active ? 1 : 0); }
  if (b.value !== undefined) { sets.push("value = ?"); vals.push(Number(b.value) || 0); }
  if (b.min_order !== undefined) { sets.push("min_order = ?"); vals.push(Number(b.min_order) || 0); }
  if (b.expires_at !== undefined) { sets.push("expires_at = ?"); vals.push(b.expires_at || null); }
  if (b.usage_limit !== undefined) { sets.push("usage_limit = ?"); vals.push(b.usage_limit != null && b.usage_limit !== "" ? Math.max(1, parseInt(String(b.usage_limit), 10)) : null); }
  if (sets.length) db.prepare(`UPDATE storefront_coupons SET ${sets.join(", ")} WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
  res.json({ success: true });
});

// DELETE /api/storefront/coupons/:id
router.delete("/coupons/:id", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  db.prepare("DELETE FROM storefront_coupons WHERE id = ? AND organization_id = ?").run(req.params.id, orgId);
  res.json({ success: true });
});

// GET /api/storefront/analytics?days=30 -> relatório da vitrine
// Visitas, produtos mais clicados, pedidos, receita e taxa de conversão.
router.get("/analytics", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const days = Math.min(Math.max(parseInt(String(req.query.days ?? 30), 10) || 30, 1), 365);
  const since = `-${days} days`;
  try {
    const visits = (db.prepare(
      "SELECT COUNT(*) AS c FROM storefront_events WHERE organization_id = ? AND type = 'view' AND created_at >= datetime('now', ?)"
    ).get(orgId, since) as any)?.c || 0;

    const orderAgg = db.prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_amount), 0) AS revenue,
              COALESCE(SUM(CASE WHEN payment_status = 'paid' THEN total_amount ELSE 0 END), 0) AS paid_revenue
         FROM orders
        WHERE organization_id = ? AND created_by = 'storefront' AND created_at >= datetime('now', ?)`
    ).get(orgId, since) as any;

    const topProducts = (db.prepare(
      `SELECT e.product_id AS id, ps.name AS name, COUNT(*) AS clicks
         FROM storefront_events e
         LEFT JOIN products_services ps ON ps.id = e.product_id
        WHERE e.organization_id = ? AND e.type = 'product_click' AND e.product_id IS NOT NULL
          AND e.created_at >= datetime('now', ?)
        GROUP BY e.product_id
        ORDER BY clicks DESC LIMIT 8`
    ).all(orgId, since) as any[]).map(r => ({ id: r.id, name: r.name || '(produto removido)', clicks: r.clicks }));

    const orders = orderAgg?.orders || 0;
    const conversion = visits > 0 ? Math.round((orders / visits) * 1000) / 10 : 0; // %

    res.json({
      days, visits, orders,
      revenue: orderAgg?.revenue || 0,
      paidRevenue: orderAgg?.paid_revenue || 0,
      conversion, // % (pedidos / visitas)
      topProducts,
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/storefront/products  -> produtos com imagens + config de vitrine (p/ o dono)
router.get("/products", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const products = db.prepare(
    "SELECT * FROM products_services WHERE organization_id = ? AND type = 'product' ORDER BY name ASC"
  ).all(orgId) as any[];
  const imgsByProduct: Record<string, any[]> = {};
  for (const img of db.prepare("SELECT * FROM product_images WHERE organization_id = ? ORDER BY position ASC", ).all(orgId) as any[]) {
    (imgsByProduct[img.product_service_id] ||= []).push({ id: img.id, url: img.url, position: img.position });
  }
  res.json(products.map(p => ({
    id: p.id, name: p.name, price: p.price, currency: p.currency,
    sale_mode: p.sale_mode || "unit",
    sale_options: (() => { try { return p.sale_options_json ? JSON.parse(p.sale_options_json) : {}; } catch { return {}; } })(),
    storefront_visible: p.storefront_visible == null ? 1 : p.storefront_visible,
    featured: !!p.featured,
    images: imgsByProduct[p.id] || [],
  })));
});

// POST /api/storefront/ai/featured -> curadoria de DESTAQUES pela IA.
// Analisa vendas (unidades/receita) e margem (preço - preço mínimo) e sugere
// quais produtos destacar na vitrine. Com a IA configurada, ela cura a lista e
// justifica; sem IA, cai num ranking determinístico (mais vendidos / maior
// margem). Se { apply: true }, aplica o destaque (featured) imediatamente.
router.post("/ai/featured", async (req: AuthRequest, res): Promise<any> => {
  const orgId = getOrgId(req);
  const apply = !!req.body?.apply;
  const max = Math.min(Math.max(parseInt(String(req.body?.max ?? 4), 10) || 4, 1), 8);

  try {
    // Métricas por produto visível na vitrine.
    const rows = db.prepare(`
      SELECT ps.id, ps.name, ps.price, ps.min_price,
        COALESCE(s.units, 0) AS units, COALESCE(s.revenue, 0) AS revenue
      FROM products_services ps
      LEFT JOIN (
        SELECT oi.product_service_id, SUM(oi.quantity) AS units, SUM(oi.line_total) AS revenue
        FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido')
        GROUP BY oi.product_service_id
      ) s ON s.product_service_id = ps.id
      WHERE ps.organization_id = ? AND ps.type = 'product' AND ps.active = 1
        AND COALESCE(ps.storefront_visible, 1) = 1
    `).all(orgId, orgId) as any[];

    if (rows.length === 0) return res.json({ suggestions: [], applied: false, reason: "Nenhum produto visível na vitrine." });

    const withMargin = rows.map(r => ({
      ...r,
      margin: (r.min_price != null && r.price != null) ? Number(r.price) - Number(r.min_price) : null,
    }));

    let suggestions: { id: string; name: string; reason: string }[] = [];

    if (isAIConfigured() && rows.length > 1) {
      const lines = withMargin.map(r =>
        `- id:${r.id} | ${r.name} | preço R$ ${Number(r.price || 0).toFixed(2)} | vendidos ${r.units} | receita R$ ${Number(r.revenue || 0).toFixed(2)}${r.margin != null ? ` | margem R$ ${r.margin.toFixed(2)}` : ''}`
      ).join("\n");
      const system = "Você é um curador de vitrine de e-commerce brasileiro. Escolhe os produtos a destacar na home da loja, equilibrando campeões de venda e itens de boa margem, mantendo variedade. Responda SOMENTE em JSON.";
      const prompt = `Produtos disponíveis (com métricas):\n${lines}\n\nEscolha até ${max} produtos para DESTACAR na vitrine. Para cada um, dê um motivo curto (ex.: "mais vendido", "ótima margem", "boa saída e ticket alto"). Responda apenas o JSON: {"featured":[{"id":"...","reason":"..."}]}`;
      try {
        const raw = await chat(prompt, { json: true, temperature: 0.4, system });
        const parsed = JSON.parse(raw);
        const valid = new Set(rows.map(r => r.id));
        suggestions = (parsed.featured || [])
          .filter((f: any) => f && valid.has(f.id))
          .slice(0, max)
          .map((f: any) => ({ id: f.id, name: rows.find(r => r.id === f.id)?.name || "", reason: String(f.reason || "destaque sugerido").slice(0, 80) }));
      } catch (e) { suggestions = []; }
    }

    // Fallback determinístico (sem IA ou se a IA não retornou nada): ranqueia por
    // unidades vendidas e, em empate, por margem/receita.
    if (suggestions.length === 0) {
      suggestions = [...withMargin]
        .sort((a, b) => (b.units - a.units) || ((b.margin ?? 0) - (a.margin ?? 0)) || (b.revenue - a.revenue))
        .slice(0, max)
        .map(r => ({
          id: r.id, name: r.name,
          reason: r.units > 0 ? `${r.units} vendido(s)` : (r.margin != null ? `boa margem` : `produto em destaque`),
        }));
    }

    if (apply) {
      const ids = new Set(suggestions.map(s => s.id));
      const setFeatured = db.transaction(() => {
        for (const r of rows) {
          db.prepare("UPDATE products_services SET featured = ? WHERE id = ? AND organization_id = ?")
            .run(ids.has(r.id) ? 1 : 0, r.id, orgId);
        }
      });
      setFeatured();
    }

    res.json({ suggestions, applied: apply });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ============================================================================
// COLEÇÕES da vitrine (curadoria pela IA): agrupam produtos por regra dinâmica
// (destaques / mais vendidos / novidades) e aparecem como seções na LP.
// ============================================================================
const COLLECTION_RULES = new Set(["featured", "best_sellers", "newest"]);

// GET /api/storefront/collections -> lista as coleções configuradas
router.get("/collections", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const rows = db.prepare(
    "SELECT id, title, rule, position, items_json FROM storefront_collections WHERE organization_id = ? ORDER BY position ASC, created_at ASC"
  ).all(orgId) as any[];
  res.json(rows.map(r => ({
    id: r.id, title: r.title, rule: r.rule, position: r.position,
    productIds: r.rule === 'manual' ? (() => { try { return JSON.parse(r.items_json || '[]'); } catch { return []; } })() : undefined,
  })));
});

// POST /api/storefront/collections -> cria uma coleção MANUAL (produtos a dedo)
router.post("/collections", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const title = String(req.body?.title || "").trim().slice(0, 40);
  if (!title) return res.status(400).json({ error: "Informe o nome da coleção." });
  const ids: string[] = Array.isArray(req.body?.productIds) ? req.body.productIds.filter((x: any) => typeof x === 'string') : [];
  const pos = ((db.prepare("SELECT MAX(position) AS m FROM storefront_collections WHERE organization_id = ?").get(orgId) as any)?.m ?? -1) + 1;
  const id = uuidv4();
  db.prepare("INSERT INTO storefront_collections (id, organization_id, title, rule, position, items_json) VALUES (?, ?, ?, 'manual', ?, ?)")
    .run(id, orgId, title, pos, JSON.stringify(ids));
  res.json({ id, title, rule: 'manual', productIds: ids });
});

// PUT /api/storefront/collections/:id -> edita uma coleção manual (título/produtos)
router.put("/collections/:id", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const c = db.prepare("SELECT id, rule FROM storefront_collections WHERE id = ? AND organization_id = ?").get(req.params.id, orgId) as any;
  if (!c) return res.status(404).json({ error: "Coleção não encontrada." });
  const sets: string[] = []; const vals: any[] = [];
  if (req.body?.title !== undefined) { sets.push("title = ?"); vals.push(String(req.body.title).trim().slice(0, 40)); }
  if (req.body?.productIds !== undefined && c.rule === 'manual') {
    const ids = Array.isArray(req.body.productIds) ? req.body.productIds.filter((x: any) => typeof x === 'string') : [];
    sets.push("items_json = ?"); vals.push(JSON.stringify(ids));
  }
  if (sets.length) db.prepare(`UPDATE storefront_collections SET ${sets.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
  res.json({ success: true });
});

// DELETE /api/storefront/collections/:id -> remove uma coleção
router.delete("/collections/:id", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  db.prepare("DELETE FROM storefront_collections WHERE id = ? AND organization_id = ?").run(req.params.id, orgId);
  res.json({ success: true });
});

// POST /api/storefront/ai/collections -> a IA monta as coleções da vitrine.
// Substitui o conjunto atual. Com a IA, ela escolhe e nomeia as coleções a
// partir do catálogo e dos sinais (destaques/vendas); sem IA, usa um conjunto
// padrão coerente.
router.post("/ai/collections", async (req: AuthRequest, res): Promise<any> => {
  const orgId = getOrgId(req);
  try {
    const hasFeatured = !!(db.prepare(
      "SELECT 1 FROM products_services WHERE organization_id = ? AND type='product' AND active=1 AND COALESCE(storefront_visible,1)=1 AND featured=1 LIMIT 1"
    ).get(orgId));
    const hasSales = !!(db.prepare(
      `SELECT 1 FROM order_items oi JOIN orders o ON o.id = oi.order_id
        WHERE o.organization_id = ? AND o.status IN ('pago','em_preparo','entregue','concluido') LIMIT 1`
    ).get(orgId));
    const names = (db.prepare(
      "SELECT name FROM products_services WHERE organization_id = ? AND type='product' AND active=1 AND COALESCE(storefront_visible,1)=1 ORDER BY created_at DESC LIMIT 40"
    ).all(orgId) as any[]).map(r => r.name);

    if (names.length === 0) return res.json({ collections: [], reason: "Nenhum produto visível na vitrine." });

    let chosen: { title: string; rule: string }[] = [];

    if (isAIConfigured()) {
      const allowed: string[] = ["newest", ...(hasFeatured ? ["featured"] : []), ...(hasSales ? ["best_sellers"] : [])];
      const system = "Você organiza a home de uma loja virtual brasileira em coleções (seções). Use APENAS as regras permitidas. Crie títulos curtos e atraentes em português. Responda SOMENTE em JSON.";
      const prompt = `Produtos da loja: ${names.join(", ")}.
Regras de coleção permitidas (id -> significado): ${allowed.map(r => r === 'featured' ? 'featured (produtos em destaque)' : r === 'best_sellers' ? 'best_sellers (mais vendidos)' : 'newest (novidades/recém-adicionados)').join("; ")}.
Monte de 2 a 3 coleções para a vitrine, cada uma com uma regra da lista (sem repetir regra) e um título curto. Responda apenas o JSON: {"collections":[{"title":"...","rule":"..."}]}`;
      try {
        const parsed = JSON.parse(await chat(prompt, { json: true, temperature: 0.5, system }));
        const seen = new Set<string>();
        chosen = (parsed.collections || [])
          .filter((c: any) => c && COLLECTION_RULES.has(c.rule) && allowed.includes(c.rule) && !seen.has(c.rule) && (seen.add(c.rule) || true))
          .slice(0, 3)
          .map((c: any) => ({ title: String(c.title || "").trim().slice(0, 40) || defaultTitle(c.rule), rule: c.rule }));
      } catch (e) { chosen = []; }
    }

    // Fallback determinístico (sem IA ou retorno inválido).
    if (chosen.length === 0) {
      if (hasFeatured) chosen.push({ title: "Destaques", rule: "featured" });
      if (hasSales) chosen.push({ title: "Mais vendidos", rule: "best_sellers" });
      chosen.push({ title: "Novidades", rule: "newest" });
    }

    // Substitui o conjunto atual de coleções.
    const replace = db.transaction(() => {
      // Mantém as coleções MANUAIS do dono; só substitui as automáticas.
      db.prepare("DELETE FROM storefront_collections WHERE organization_id = ? AND rule != 'manual'").run(orgId);
      chosen.forEach((c, i) => {
        db.prepare("INSERT INTO storefront_collections (id, organization_id, title, rule, position) VALUES (?, ?, ?, ?, ?)")
          .run(uuidv4(), orgId, c.title, c.rule, i);
      });
    });
    replace();

    res.json({ collections: chosen });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

function defaultTitle(rule: string): string {
  return rule === "featured" ? "Destaques" : rule === "best_sellers" ? "Mais vendidos" : "Novidades";
}

// PUT /api/storefront/products/:id -> atualiza modo de venda / visibilidade / destaque
router.put("/products/:id", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const p = db.prepare("SELECT id FROM products_services WHERE id = ? AND organization_id = ?").get(req.params.id, orgId);
  if (!p) return res.status(404).json({ error: "Produto não encontrado." });
  const b = req.body || {};
  const fields: Record<string, any> = {};
  if (b.sale_mode !== undefined) fields.sale_mode = ["unit", "size", "weight", "volume"].includes(b.sale_mode) ? b.sale_mode : "unit";
  if (b.sale_options !== undefined) fields.sale_options_json = JSON.stringify(b.sale_options || {});
  if (b.storefront_visible !== undefined) fields.storefront_visible = b.storefront_visible ? 1 : 0;
  if (b.featured !== undefined) fields.featured = b.featured ? 1 : 0;
  if (Object.keys(fields).length) {
    const sets = Object.keys(fields).map(k => `${k} = ?`).join(", ");
    db.prepare(`UPDATE products_services SET ${sets} WHERE id = ? AND organization_id = ?`)
      .run(...Object.values(fields), req.params.id, orgId);
  }
  res.json({ ok: true });
});

// POST /api/storefront/products/:id/images  { url }
router.post("/products/:id/images", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  const p = db.prepare("SELECT id FROM products_services WHERE id = ? AND organization_id = ?").get(req.params.id, orgId);
  if (!p) return res.status(404).json({ error: "Produto não encontrado." });
  const url = (req.body?.url || "").trim();
  if (!url) return res.status(400).json({ error: "URL da imagem é obrigatória." });
  const count = (db.prepare("SELECT COUNT(*) AS c FROM product_images WHERE product_service_id = ?").get(req.params.id) as any)?.c || 0;
  const id = uuidv4();
  db.prepare(
    "INSERT INTO product_images (id, organization_id, product_service_id, url, position) VALUES (?, ?, ?, ?, ?)"
  ).run(id, orgId, req.params.id, url, count);
  res.json({ id, url, position: count });
});

// DELETE /api/storefront/products/:id/images/:imageId
router.delete("/products/:id/images/:imageId", (req: AuthRequest, res): any => {
  const orgId = getOrgId(req);
  db.prepare("DELETE FROM product_images WHERE id = ? AND organization_id = ? AND product_service_id = ?")
    .run(req.params.imageId, orgId, req.params.id);
  res.json({ ok: true });
});

export default router;
