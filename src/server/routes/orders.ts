import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { OrdersService } from "../OrdersService.js";
import { RecoveryRadarService } from "../RecoveryRadarService.js";

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
    const o = db.prepare('SELECT ai_auto_close_sales, negotiator_enabled, negotiator_max_discount, negotiator_rules FROM organization_settings WHERE organization_id = ?').get(orgId) as any;
    res.json({
      ai_auto_close_sales: !!(o && o.ai_auto_close_sales),
      negotiator_enabled: !!(o && o.negotiator_enabled),
      negotiator_max_discount: o?.negotiator_max_discount || 0,
      negotiator_rules: o?.negotiator_rules || '',
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/orders/settings — atualiza autonomia e/ou negociador
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    if (b.ai_auto_close_sales !== undefined) {
      db.prepare('UPDATE organization_settings SET ai_auto_close_sales = ? WHERE organization_id = ?').run(b.ai_auto_close_sales ? 1 : 0, orgId);
    }
    if (b.negotiator_enabled !== undefined || b.negotiator_max_discount !== undefined || b.negotiator_rules !== undefined) {
      db.prepare('UPDATE organization_settings SET negotiator_enabled = ?, negotiator_max_discount = ?, negotiator_rules = ? WHERE organization_id = ?')
        .run(b.negotiator_enabled ? 1 : 0, parseInt(String(b.negotiator_max_discount || 0), 10) || 0, b.negotiator_rules || null, orgId);
    }
    logEvent(orgId, userId, undefined, 'SALES_SETTINGS_CHANGED', {});
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Converte o parâmetro de período em uma cláusula SQL sobre created_at.
// Retorna { clause, since } onde clause já vem com "AND ..." (ou vazio).
const periodClause = (period?: string): { clause: string; since: string | null } => {
  switch (period) {
    case 'today': return { clause: ` AND o.created_at >= date('now','localtime')`, since: 'today' };
    case 'week': return { clause: ` AND o.created_at >= datetime('now','-7 days')`, since: 'week' };
    case 'month': return { clause: ` AND o.created_at >= datetime('now','-30 days')`, since: 'month' };
    default: return { clause: '', since: null };
  }
};

// GET /api/orders?status=...&period=... — lista pedidos (com itens)
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const status = req.query.status as string | undefined;
    const { clause } = periodClause(req.query.period as string | undefined);
    const params: any[] = [orgId];
    let where = `WHERE o.organization_id = ?${clause}`;
    if (status) { where += ` AND o.status = ?`; params.push(status); }
    const rows = db.prepare(`SELECT o.*, c.name AS contact_name, c.identifier AS contact_number
                    FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
                    ${where} ORDER BY o.created_at DESC`).all(...params);
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

// GET /api/orders/summary?period=... — resumo por status (para a aba Vendas)
router.get("/summary", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { clause } = periodClause(req.query.period as string | undefined);
    const byStatus = db.prepare(`SELECT o.status, count(*) as count, COALESCE(SUM(o.total_amount),0) as total
                                 FROM orders o WHERE o.organization_id = ?${clause} GROUP BY o.status`).all(orgId);
    const revenue = db.prepare(`SELECT COALESCE(SUM(o.total_amount),0) as total FROM orders o
                                WHERE o.organization_id = ?${clause} AND o.status IN ('pago','em_preparo','entregue','concluido')`).get(orgId) as any;
    res.json({ byStatus, revenue: revenue?.total || 0 });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/orders/export.csv?status=...&period=... — exporta os pedidos em CSV
router.get("/export.csv", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const status = req.query.status as string | undefined;
    const { clause } = periodClause(req.query.period as string | undefined);
    const params: any[] = [orgId];
    let where = `WHERE o.organization_id = ?${clause}`;
    if (status) { where += ` AND o.status = ?`; params.push(status); }
    const rows = db.prepare(`SELECT o.id, o.created_at, o.status, o.total_amount, o.payment_status, o.created_by,
                                    c.name AS contact_name, c.identifier AS contact_number
                             FROM orders o LEFT JOIN contacts c ON c.id = o.contact_id
                             ${where} ORDER BY o.created_at DESC`).all(...params) as any[];

    const esc = (v: any) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['ID', 'Data', 'Status', 'Pagamento', 'Origem', 'Cliente', 'Telefone', 'Total'];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        r.id, r.created_at, r.status, r.payment_status || '', r.created_by || '',
        r.contact_name || '', r.contact_number || '', Number(r.total_amount || 0).toFixed(2),
      ].map(esc).join(','));
    }
    const csv = '﻿' + lines.join('\n'); // BOM p/ Excel abrir acentos corretamente

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename=vendas-${req.query.period || 'tudo'}-${Date.now()}.csv`);
    res.send(csv);
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
    // Recovery Radar (Disney, ADR-047): quando um pedido é cancelado ou
    // devolvido, dispara evento de recuperação com playbook sugerido — a
    // recuperação é o momento memorável, não a falha.
    if (["cancelado", "devolucao", "reembolso"].includes(status)) {
      try {
        const order = db.prepare(`SELECT id, contact_id, ticket_id, total_amount, status FROM orders WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId) as any;
        if (order) {
          RecoveryRadarService.detect({
            organizationId: orgId, contactId: order.contact_id, ticketId: order.ticket_id,
            orderId: order.id, triggerType: "order_cancelled",
            context: { finalStatus: status, totalAmount: order.total_amount },
          });
        }
      } catch (e) { console.error("[RecoveryRadar] hook cancel falhou", e); }
    }
    res.json({ success: true });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

export default router;
