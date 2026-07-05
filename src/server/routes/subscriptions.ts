import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { SubscriptionService } from "../SubscriptionService.js";
import db from "../db.js";

const router = Router();
const orgOf = (req: AuthRequest) => req.organizationId;

// ---- Planos ----
router.get("/plans", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SubscriptionService.listPlans(orgId));
});
router.post("/plans", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!String(req.body?.name || "").trim()) return res.status(400).json({ error: "Informe o nome do plano." });
  res.json({ success: true, ...SubscriptionService.createPlan(orgId, req.body) });
});
router.patch("/plans/:id", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  SubscriptionService.updatePlan(orgId, req.params.id, req.body || {});
  res.json({ success: true });
});

// ---- Assinaturas ----
router.get("/", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SubscriptionService.list(orgId));
});
router.post("/", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  if (!b.planId || !b.contactId) return res.status(400).json({ error: "Informe o plano e o contato." });
  try {
    res.json({ success: true, ...SubscriptionService.subscribe(orgId, { planId: b.planId, contactId: b.contactId, startDate: b.startDate, createdBy: "owner" }) });
  } catch (e: any) {
    const map: Record<string, string> = { plan_not_found: "Plano não encontrado.", invalid_date: "Data inválida." };
    res.status(400).json({ error: map[e.message] || "Falha ao criar a assinatura." });
  }
});
router.patch("/:id/status", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { SubscriptionService.setStatus(orgId, req.params.id, String(req.body?.status || "")); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ error: "Status inválido." }); }
});

// Troca de plano com proration.
router.patch("/:id/plan", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!req.body?.planId) return res.status(400).json({ error: "Informe o novo plano (planId)." });
  const result = SubscriptionService.changePlan(orgId, req.params.id, req.body.planId);
  if (!result) return res.status(404).json({ error: "Assinatura ou plano não encontrado." });
  res.json({ success: true, ...result });
});

// Envia link do portal de autoatendimento ao contato via WhatsApp.
router.post("/:id/portal-link", async (req: AuthRequest, res): Promise<any> => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const sub = db.prepare("SELECT contact_id FROM subscriptions WHERE id = ? AND organization_id = ?").get(req.params.id, orgId) as any;
  if (!sub) return res.status(404).json({ error: "Assinatura não encontrada." });
  const sent = await SubscriptionService.sendPortalLink(orgId, sub.contact_id);
  res.json({ success: sent });
});

// ---- Faturas ----
router.get("/invoices", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(SubscriptionService.listInvoices(orgId, (req.query.subscription as string) || undefined));
});
// Gera a fatura do ciclo (cobrar agora).
router.post("/:id/invoice", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = SubscriptionService.generateInvoice(orgId, req.params.id);
  if (!r) return res.status(400).json({ error: "Não foi possível gerar a fatura." });
  res.json({ success: true, ...r });
});
router.post("/invoices/:id/paid", (req: AuthRequest, res): any => {
  const orgId = orgOf(req); if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  SubscriptionService.markInvoicePaid(orgId, req.params.id);
  res.json({ success: true });
});

export default router;
