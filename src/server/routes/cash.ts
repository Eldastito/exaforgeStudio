import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { FinancialLedgerService } from "../FinancialLedgerService.js";
import { CashForecastService } from "../CashForecastService.js";
import { CashActionService } from "../CashActionService.js";

// Motor de Caixa (ADR-125) — livro-caixa global. Rota core (não é módulo
// opcional): disponível em todas as verticais.
const router = Router();

// GET /api/cash — overview: resumo (caixa/a pagar/a receber), contas, listas.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(FinancialLedgerService.overview(orgId));
});

// GET /api/cash/forecast — projeção de 13 semanas + ruptura + confiança.
router.get("/forecast", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const minCash = Number(req.query?.minCash) || 0;
  res.json(CashForecastService.forecast(orgId, { minCash }));
});

// POST /api/cash/forecast/snapshot — persiste o snapshot do cenário provável.
router.post("/forecast/snapshot", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(CashForecastService.snapshot(orgId, Number(req.body?.minCash) || 0));
});

// GET /api/cash/actions — sugestões p/ cobrir a ruptura + Impact Ledger.
router.get("/actions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(CashActionService.overview(orgId, Number(req.query?.minCash) || 0));
});

// POST /api/cash/actions — registra uma ação aceita pelo lojista.
router.post("/actions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = CashActionService.create(orgId, { ...(req.body || {}), createdBy: req.user?.userId });
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

// POST /api/cash/actions/:id/complete — conclui com o impacto medido.
router.post("/actions/:id/complete", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = CashActionService.complete(orgId, req.params.id, Number(req.body?.resultAmount) || 0);
  if (!out.ok) return res.status(404).json(out);
  res.json(out);
});

// POST /api/cash/actions/:id/dismiss — descarta a ação.
router.post("/actions/:id/dismiss", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(CashActionService.dismiss(orgId, req.params.id));
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
