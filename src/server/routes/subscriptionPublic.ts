import { Router } from "express";
import { SubscriptionService } from "../SubscriptionService.js";

// ============================================================================
// PORTAL DE ASSINATURA — rotas PUBLICAS (sem autenticacao).
// O contato acessa via token HMAC assinado (gerado por sendPortalLink).
// Montadas em server.ts ANTES do middleware de auth.
// ============================================================================

const router = Router();

/** Resolve o contato a partir do token de portal. Retorna null se invalido. */
function resolveToken(token: string | undefined): { orgId: string; contactId: string } | null {
  if (!token || typeof token !== "string") return null;
  return SubscriptionService.contactByPortalToken(token);
}

// GET /api/public/subscription/portal?token=<token>
// Retorna a assinatura ativa + faturas do contato.
router.get("/portal", (req, res): any => {
  const ctx = resolveToken(req.query.token as string);
  if (!ctx) return res.status(401).json({ error: "Token invalido ou expirado." });

  const subscription = SubscriptionService.contactSubscription(ctx.orgId, ctx.contactId);
  if (!subscription) return res.json({ subscription: null, invoices: [] });

  const invoices = SubscriptionService.listInvoices(ctx.orgId, subscription.id);
  res.json({ subscription, invoices });
});

// POST /api/public/subscription/portal/pay?token=<token>
// Marca uma fatura como paga (confirmacao manual pelo contato).
// Body: { invoiceId }
router.post("/portal/pay", (req, res): any => {
  const ctx = resolveToken(req.query.token as string);
  if (!ctx) return res.status(401).json({ error: "Token invalido ou expirado." });

  const invoiceId = req.body?.invoiceId;
  if (!invoiceId) return res.status(400).json({ error: "Informe o invoiceId." });

  const ok = SubscriptionService.markInvoicePaid(ctx.orgId, invoiceId);
  if (!ok) return res.status(404).json({ error: "Fatura nao encontrada." });
  res.json({ success: true });
});

export default router;
