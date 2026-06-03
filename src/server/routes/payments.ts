import { Router } from "express";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { AuthRequest } from "../middleware/auth.js";
import { PaymentService } from "../PaymentService.js";

const router = Router();

const logEvent = (orgId?: string, actorId?: string, targetId?: string, eventType = '', meta: any = {}) => {
  try {
    db.prepare(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(uuidv4(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch (e) { /* noop */ }
};

// GET /api/payments/settings — config de recebimento (sem segredos)
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(PaymentService.getPublicSettings(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// PUT /api/payments/settings — atualiza a config de recebimento
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    PaymentService.updateSettings(orgId, req.body || {});
    logEvent(orgId, userId, undefined, 'PAYMENT_SETTINGS_UPDATED', {});
    res.json({ success: true, settings: PaymentService.getPublicSettings(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/payments/webhook-secret — gera/regenera o segredo do webhook do gateway
router.post("/webhook-secret", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const secret = PaymentService.rotateWebhookSecret(orgId);
    logEvent(orgId, userId, undefined, 'PAYMENT_WEBHOOK_SECRET_ROTATED', {});
    // Retorna o segredo UMA vez (o gateway usará na URL do webhook).
    res.json({ success: true, secret });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/payments/orders/:id/pix — gera (ou reaproveita) um PIX dinâmico do
// Mercado Pago para o pedido. Retorna copia-e-cola, QR (base64) e link.
router.post("/orders/:id/pix", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const order = db.prepare(`SELECT * FROM orders WHERE id = ? AND organization_id = ?`).get(req.params.id, orgId) as any;
    if (!order) return res.status(404).json({ error: "Pedido não encontrado" });
    const contact = order.contact_id ? db.prepare('SELECT name FROM contacts WHERE id = ?').get(order.contact_id) as any : null;
    const charge = await PaymentService.createMercadoPagoPix(orgId, {
      orderId: order.id, amount: order.total_amount, contactName: contact?.name, contactId: order.contact_id,
    });
    if (!charge) return res.status(400).json({ error: "Não foi possível gerar o PIX. Verifique o token do Mercado Pago nas configurações de pagamento." });
    res.json({ qrCode: charge.qrCode, qrCodeBase64: charge.qrCodeBase64, ticketUrl: charge.ticketUrl });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/payments/orders/:id/confirm — confirmação manual (humano viu o comprovante)
router.post("/orders/:id/confirm", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  const userId = req.user?.userId;
  if (!orgId || !userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = PaymentService.markPaid(orgId, req.params.id, { method: 'manual' });
    if (!ok) return res.status(404).json({ error: "Pedido não encontrado" });
    logEvent(orgId, userId, req.params.id, 'PAYMENT_CONFIRMED_MANUAL', {});
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
