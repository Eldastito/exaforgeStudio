import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { InventoryService } from "../InventoryService.js";

const router = Router();

// ---- Variações de produto (tamanho/cor/tipo) ----

// GET /api/products/:id/variants
router.get("/:id/variants", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const variants = db.prepare(`
      SELECT pv.*, inv.quantity_available, inv.quantity_reserved
      FROM product_variants pv
      LEFT JOIN inventory_items inv ON inv.variant_id = pv.id
      WHERE pv.organization_id = ? AND pv.product_service_id = ?
      ORDER BY pv.created_at ASC
    `).all(orgId, req.params.id) as any[];
    res.json(variants.map(v => ({ ...v, sellable: Math.max(0, (v.quantity_available || 0) - (v.quantity_reserved || 0)) })));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/products/:id/variants — cria variação (e marca o produto com has_variants)
router.post("/:id/variants", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const { name, size, color, variant_type, sku, price, initial_stock } = req.body || {};
  const label = name || [size, color, variant_type].filter(Boolean).join(' / ');
  if (!label) return res.status(400).json({ error: "Informe ao menos tamanho/cor/tipo ou um nome." });
  try {
    const product = db.prepare('SELECT id FROM products_services WHERE id = ? AND organization_id = ?').get(req.params.id, orgId) as any;
    if (!product) return res.status(404).json({ error: "Produto não encontrado" });
    const vid = uuidv4();
    db.prepare(`INSERT INTO product_variants (id, organization_id, product_service_id, name, sku, size, color, variant_type, price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(vid, orgId, req.params.id, label, sku || null, size || null, color || null, variant_type || null, price ?? null);
    db.prepare(`UPDATE products_services SET has_variants = 1, stock_control_enabled = 1 WHERE id = ?`).run(req.params.id);
    if (initial_stock) InventoryService.setQuantity(orgId, req.params.id, parseInt(String(initial_stock), 10) || 0, vid);
    res.json({ success: true, id: vid });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ---- Movimentações de estoque (entrada/saída/ajuste/transferência) ----

// GET /api/products/:id/movements
router.get("/:id/movements", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(InventoryService.listMovements(orgId, req.params.id)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/products/:id/movements — registra entrada/saída/ajuste/transferência
router.post("/:id/movements", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const { type, quantity, unit_cost, origin, note, variant_id } = req.body || {};
  if (!['entrada', 'saida', 'ajuste', 'transferencia'].includes(type)) return res.status(400).json({ error: "Tipo de movimentação inválido." });
  try {
    const movId = InventoryService.recordMovement(orgId, {
      productId: req.params.id, variantId: variant_id || null, type,
      quantity: parseInt(String(quantity), 10) || 0, unitCost: parseFloat(String(unit_cost)) || 0,
      origin, note, createdBy: userId,
    });
    db.prepare(`UPDATE products_services SET stock_control_enabled = 1 WHERE id = ? AND organization_id = ?`).run(req.params.id, orgId);
    logAuthEvent(orgId, userId, req.params.id, 'STOCK_MOVEMENT', { type, quantity, origin });
    res.json({ success: true, id: movId });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

const logAuthEvent = (orgId: string | undefined, actorId: string | undefined, targetId: string | undefined, eventType: string, meta: any = {}) => {
  try {
    db.prepare(`
      INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(uuidv4(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch(e) {
    console.error("Failed to log auth event", e);
  }
};

// GET /api/products — produtos com estoque ao vivo (disponível e vendável)
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const products = db.prepare(`
      SELECT ps.*,
        COALESCE(prod.quantity_available, agg.qa) AS quantity_available,
        COALESCE(prod.quantity_reserved, agg.qr) AS quantity_reserved,
        prod.low_stock_threshold AS low_stock_threshold
      FROM products_services ps
      LEFT JOIN inventory_items prod ON prod.product_service_id = ps.id AND prod.variant_id IS NULL
      LEFT JOIN (
        SELECT product_service_id, SUM(quantity_available) qa, SUM(quantity_reserved) qr
        FROM inventory_items WHERE variant_id IS NOT NULL GROUP BY product_service_id
      ) agg ON agg.product_service_id = ps.id
      WHERE ps.organization_id = ?
      ORDER BY ps.created_at DESC
    `).all(orgId) as any[];
    res.json(products.map(p => ({
      ...p,
      sellable: p.stock_control_enabled ? Math.max(0, (p.quantity_available || 0) - (p.quantity_reserved || 0)) : null,
    })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const { type, name, description, price, stock_control_enabled, duration_minutes, min_price } = req.body;
  const id = uuidv4();

  try {
    db.prepare(`
      INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled, duration_minutes, min_price)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, orgId, type || 'product', name, description || '', price || 0, stock_control_enabled ? 1 : 0, duration_minutes || null, (min_price !== undefined && min_price !== '' ? Number(min_price) : null));

    if (stock_control_enabled) {
      db.prepare(`
         INSERT INTO inventory_items (id, organization_id, product_service_id, quantity_available, low_stock_threshold)
         VALUES (?, ?, ?, ?, ?)
      `).run(uuidv4(), orgId, id, req.body.initial_stock || 0, req.body.low_stock_threshold || 0);
    }

    logAuthEvent(orgId, userId, id, 'PRODUCT_CREATED', { name, type });

    res.json({ success: true, id });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /api/products/:id — edita produto e/ou ajusta estoque em mãos
router.patch("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const product = db.prepare('SELECT * FROM products_services WHERE id = ? AND organization_id = ?').get(req.params.id, orgId) as any;
    if (!product) return res.status(404).json({ error: "Produto não encontrado" });

    const { name, description, price, active, type, stock_control_enabled, quantity, low_stock_threshold, min_price } = req.body;
    const updates: string[] = [];
    const vals: any[] = [];
    if (name !== undefined) { updates.push("name = ?"); vals.push(name); }
    if (description !== undefined) { updates.push("description = ?"); vals.push(description); }
    if (price !== undefined) { updates.push("price = ?"); vals.push(price); }
    if (active !== undefined) { updates.push("active = ?"); vals.push(active ? 1 : 0); }
    if (type !== undefined) { updates.push("type = ?"); vals.push(type); }
    if (stock_control_enabled !== undefined) { updates.push("stock_control_enabled = ?"); vals.push(stock_control_enabled ? 1 : 0); }
    if (min_price !== undefined) { updates.push("min_price = ?"); vals.push(min_price === '' || min_price === null ? null : Number(min_price)); }
    if (updates.length) {
      db.prepare(`UPDATE products_services SET ${updates.join(', ')} WHERE id = ? AND organization_id = ?`).run(...vals, req.params.id, orgId);
    }

    // Ajuste de estoque em mãos (define a quantidade absoluta)
    if (quantity !== undefined && Number.isFinite(Number(quantity))) {
      InventoryService.setQuantity(orgId, req.params.id, Math.max(0, parseInt(String(quantity), 10)));
    }
    if (low_stock_threshold !== undefined) {
      db.prepare('UPDATE inventory_items SET low_stock_threshold = ? WHERE organization_id = ? AND product_service_id = ?')
        .run(parseInt(String(low_stock_threshold), 10) || 0, orgId, req.params.id);
    }

    logAuthEvent(orgId, userId, req.params.id, 'PRODUCT_UPDATED', {});
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /:id — exclui o produto/serviço do catálogo (e da vitrine). Remove os
// dados ligados ao produto (estoque, variações, imagens, movimentações), mas
// PRESERVA o histórico de pedidos (order_items guardam o nome no snapshot).
router.delete("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    const product = db.prepare('SELECT id, name FROM products_services WHERE id = ? AND organization_id = ?').get(req.params.id, orgId) as any;
    if (!product) return res.status(404).json({ error: "Produto não encontrado" });

    const wipe = db.transaction((id: string) => {
      db.prepare('DELETE FROM inventory_items WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM product_variants WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM stock_movements WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM product_images WHERE organization_id = ? AND product_service_id = ?').run(orgId, id);
      db.prepare('DELETE FROM products_services WHERE id = ? AND organization_id = ?').run(id, orgId);
    });
    wipe(req.params.id);

    logAuthEvent(orgId, userId, req.params.id, 'PRODUCT_DELETED', { name: product.name });
    res.json({ success: true });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/products/import — importação em massa via CSV (texto colado)
// Formato esperado (cabeçalho): nome,preco,quantidade,descricao,tipo
router.post("/import", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });

  const csv = String(req.body?.csv || "");
  if (!csv.trim()) return res.status(400).json({ error: "CSV vazio." });

  try {
    const lines = csv.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) return res.status(400).json({ error: "CSV sem linhas de dados." });

    // Detecta o separador (vírgula ou ponto-e-vírgula) e mapeia o cabeçalho.
    const sep = (lines[0].match(/;/g)?.length || 0) > (lines[0].match(/,/g)?.length || 0) ? ';' : ',';
    const header = lines[0].split(sep).map(h => h.trim().toLowerCase());
    const idx = (names: string[]) => names.map(n => header.indexOf(n)).find(i => i >= 0) ?? -1;
    const iName = idx(['nome', 'name', 'produto']);
    const iPrice = idx(['preco', 'preço', 'price', 'valor']);
    const iQty = idx(['quantidade', 'qtd', 'estoque', 'quantity', 'stock']);
    const iDesc = idx(['descricao', 'descrição', 'description', 'desc']);
    const iType = idx(['tipo', 'type']);
    if (iName < 0) return res.status(400).json({ error: "Cabeçalho precisa ter a coluna 'nome'." });

    let created = 0, updated = 0;
    const parsePrice = (s: string) => parseFloat(String(s || '0').replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.')) || 0;

    const tx = db.transaction(() => {
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(sep);
        const name = (cols[iName] || '').trim();
        if (!name) continue;
        const price = iPrice >= 0 ? parsePrice(cols[iPrice]) : 0;
        const qty = iQty >= 0 ? (parseInt(String(cols[iQty]).replace(/[^\d-]/g, ''), 10) || 0) : 0;
        const desc = iDesc >= 0 ? (cols[iDesc] || '').trim() : '';
        const type = iType >= 0 ? (cols[iType] || 'product').trim() : 'product';
        const stockControlled = iQty >= 0;

        // Upsert por nome (dentro da organização).
        const existing = db.prepare('SELECT id FROM products_services WHERE organization_id = ? AND name = ?').get(orgId, name) as any;
        if (existing) {
          db.prepare('UPDATE products_services SET price = ?, description = ?, type = ?, stock_control_enabled = ? WHERE id = ?')
            .run(price, desc, type, stockControlled ? 1 : 0, existing.id);
          if (stockControlled) InventoryService.setQuantity(orgId, existing.id, qty);
          updated++;
        } else {
          const pid = uuidv4();
          db.prepare('INSERT INTO products_services (id, organization_id, type, name, description, price, stock_control_enabled) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(pid, orgId, type, name, desc, price, stockControlled ? 1 : 0);
          if (stockControlled) InventoryService.setQuantity(orgId, pid, qty);
          created++;
        }
      }
    });
    tx();

    logAuthEvent(orgId, userId, undefined, 'PRODUCTS_IMPORTED', { created, updated });
    res.json({ success: true, created, updated });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
