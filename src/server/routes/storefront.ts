import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";

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
