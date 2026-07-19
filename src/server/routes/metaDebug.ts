import { Router } from "express";
import { AuthRequest, requireMasterAdmin } from "../middleware/auth.js";
import { MetaWebhookLogService } from "../MetaWebhookLogService.js";

const router = Router();

// Console de diagnóstico Meta = ferramenta técnica da PLATAFORMA, não do
// lojista. O payload de webhook é global (todos os tenants) e pode conter PII
// do lead (nome/mensagem do DM). Por isso o acesso é restrito ao Master Admin
// — dono de uma org não pode ver webhooks de outra (ADR-098).
router.use(requireMasterAdmin);

// GET /api/meta-debug/hits — últimos hits recebidos em /api/webhooks/meta.
router.get("/hits", (req: AuthRequest, res): any => {
  try {
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50));
    res.json({ hits: MetaWebhookLogService.list(limit), summary: MetaWebhookLogService.summary() });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/meta-debug/hits/:id — apaga um hit específico (deletar por linha).
router.delete("/hits/:id", (req: AuthRequest, res): any => {
  try {
    const ok = MetaWebhookLogService.deleteOne(req.params.id);
    if (!ok) return res.status(404).json({ error: "Hit não encontrado." });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/meta-debug/hits — apaga todos os hits ("Limpar tudo").
router.delete("/hits", (req: AuthRequest, res): any => {
  try {
    const removed = MetaWebhookLogService.clearAll();
    res.json({ success: true, removed });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
