import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { OrdersService } from "../OrdersService.js";

const router = Router();

const logEvent = (orgId?: string, actorId?: string, targetId?: string, eventType = '', meta: any = {}) => {
  try {
    db.prepare(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch (e) { /* noop */ }
};

// GET /api/orders/settings — lê o interruptor de autonomia da IA nas vendas
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare('SELECT ai_auto_close_sales FROM organization_settings WHERE organization_id = ?').get(orgId) as any;
    res.json({ ai_auto_close_sales: !!(o && o.ai_auto_close_sales) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/orders/settings — atualiza o interruptor de autonomia
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const val = req.body?.ai_auto_close_sales ? 1 : 0;
    db.prepare('UPDATE organization_settings SET ai_auto_close_sales = ? WHERE organization_id = ?').run(val, orgId);
    logEvent(orgId, userId, undefined, 'SALES_AUTONOMY_CHANGED', { ai_auto_close_sales: val });
    res.json({ success: true, ai_auto_close_sales: !!val });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/orders?status=... — lista pedidos (com itens), opcionalmente por status
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const status = req.query.status as string | undefined;
    const rows = status
      ? db.prepare(`SELECT o.*, c.name AS contact_name, c.identifier AS contact_number
                    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
                    WHERE o.organization_id = ? AND o.status = ? ORDER BY o.created_at DESC`).all(orgId, status)
      : db.prepare(`SELECT o.*, c.name AS contact_name, c.identifier AS contact_number
                    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
                    WHERE o.organization_id = ? ORDER BY o.created_at DESC`).all(orgId);
    const items = db.prepare('SELECT * FROM order_items WHERE organization_id = ?').all(orgId) as any[];
    const byOrder = new Map<string, any[]>();
    for (const it of items) {
      if (!byOrder.has(it.order_id)) byOrder.set(it.order_id, []);
      byOrder.get(it.order_id)!.push(it);
    }
    res.json((rows as any[]).map(o => ({ ...o, items: byOrder.get(o.id) || [] })));
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/summary — resumo por status (para a aba Vendas)
router.get("/summary", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const byStatus = db.prepare(`SELECT status, count(*) as count, COALESCE(SUM(total_amount),0) as total
                                 FROM orders WHERE organization_id = ? GROUP BY status`).all(orgId);
    const revenue = db.prepare(`SELECT COALESCE(SUM(total_amount),0) as total FROM orders
                                WHERE organization_id = ? AND status IN ('pago','em_preparo','entregue','concluido')`).get(orgId) as any;
    res.json({ byStatus, revenue: revenue?.total || 0 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/:id
router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const order = OrdersService.getOrder(orgId, req.params.id);
    if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
    res.json(order);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/orders — cria pedido manualmente (gestão humana)
router.post("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const { contactId, ticketId, items, autoClose, notes } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "Informe ao menos um item." });
  try {
    const order = OrdersService.createOrder(orgId, { contactId, ticketId, items, createdBy: userId, autoClose: !!autoClose, notes });
    logEvent(orgId, userId, order.id, 'ORDER_CREATED', { total: order.total, items: order.items.length });
    res.json({ success: true, ...order });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// PATCH /api/orders/:id/status — transição de status (ajusta estoque)
router.patch("/:id/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  const { status } = req.body || {};
  if (!status || !OrdersService.isValidStatus(status)) return res.status(400).json({ error: "Status inválido." });
  try {
    OrdersService.updateStatus(orgId, req.params.id, status);
    logEvent(orgId, userId, req.params.id, 'ORDER_STATUS_CHANGED', { status });
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
