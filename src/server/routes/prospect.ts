import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ProspectService } from "../ProspectService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// ── ICP ──────────────────────────────────────────────────────────────────
router.get("/icps", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.listIcps(orgId));
});

router.post("/icps", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.createIcp(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/icps/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.updateIcp(orgId, req.params.id, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/icps/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = ProspectService.archiveIcp(orgId, req.params.id);
  if (!ok) return res.status(400).json({ error: "ICP não encontrado." });
  res.json({ success: true });
});

// ── Campanhas (rascunho) ─────────────────────────────────────────────────
router.get("/campaigns", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.listCampaigns(orgId));
});

router.post("/campaigns", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.createCampaign(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.patch("/campaigns/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.updateCampaign(orgId, req.params.id, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Importação (CSV) + contas/contatos ───────────────────────────────────
// POST /api/prospect/import { campaignId?, sourceRef?, records: [...] }
router.post("/import", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.importRecords(orgId, req.body || {}, actor(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/accounts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ProspectService.listAccounts(orgId, { campaignId: req.query.campaignId as string, q: req.query.q as string }));
});

router.get("/accounts/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const a = ProspectService.getAccount(orgId, req.params.id);
  if (!a) return res.status(404).json({ error: "Conta não encontrada." });
  res.json(a);
});

router.post("/accounts/:id/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = ProspectService.updateAccountStatus(orgId, req.params.id, String(req.body?.status || ""));
    if (!ok) return res.status(400).json({ error: "Conta não encontrada." });
    res.json({ success: true });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Evidências ───────────────────────────────────────────────────────────
router.post("/accounts/:id/signals", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.addSignal(orgId, req.params.id, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.delete("/accounts/:id/signals/:sid", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.removeSignal(orgId, req.params.id, req.params.sid)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Hipóteses de dor (IA) ────────────────────────────────────────────────
router.post("/accounts/:id/hypotheses", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(await ProspectService.generateHypotheses(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/accounts/:id/hypotheses/:hid/status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.setHypothesisStatus(orgId, req.params.id, req.params.hid, String(req.body?.status || ""))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ── Score (recalcula sob demanda) ────────────────────────────────────────
router.post("/accounts/:id/score", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ProspectService.computeScore(orgId, req.params.id)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
