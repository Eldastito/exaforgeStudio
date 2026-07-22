import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { FinancialLedgerService } from "../FinancialLedgerService.js";

// Motor de Caixa (ADR-125) — livro-caixa global. Rota core (não é módulo
// opcional): disponível em todas as verticais.
const router = Router();

// GET /api/cash — overview: resumo (caixa/a pagar/a receber), contas, listas.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(FinancialLedgerService.overview(orgId));
});

// POST /api/cash/accounts — cria uma conta/carteira.
router.post("/accounts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.status(201).json(FinancialLedgerService.createAccount(orgId, req.body || {}));
});

// POST /api/cash/events — lança uma entrada/saída manual de caixa.
router.post("/events", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { direction, amount, eventDate, accountId, note } = req.body || {};
  const out = FinancialLedgerService.recordEvent(orgId, { direction, amount: Number(amount), eventDate, accountId, note, createdBy: req.user?.userId });
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

// POST /api/cash/payables — cadastra conta a pagar.
router.post("/payables", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = FinancialLedgerService.addPayable(orgId, { ...(req.body || {}), amount: Number(req.body?.amount), createdBy: req.user?.userId });
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

// POST /api/cash/payables/:id/pay — quita a conta → saída de caixa.
router.post("/payables/:id/pay", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = FinancialLedgerService.payPayable(orgId, req.params.id, { accountId: req.body?.accountId, date: req.body?.date, createdBy: req.user?.userId });
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

// POST /api/cash/receivables — cadastra conta a receber.
router.post("/receivables", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = FinancialLedgerService.addReceivable(orgId, { ...(req.body || {}), amount: Number(req.body?.amount), createdBy: req.user?.userId });
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

// POST /api/cash/receivables/:id/receive — baixa o recebível → entrada de caixa.
router.post("/receivables/:id/receive", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = FinancialLedgerService.receiveReceivable(orgId, req.params.id, { accountId: req.body?.accountId, date: req.body?.date, createdBy: req.user?.userId });
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

export default router;
