/**
 * Retail Floor — API (ADR-150). Montada em /api/retail-floor, gated pelo módulo
 * `retail_floor` (ModuleService.MODULE_BY_ROUTE["retail-floor"]). Fatia 1:
 * contexto por escopo + settings. As fatias seguintes acrescentam turno, fila,
 * atendimento, scan, conciliação e analytics.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RetailFloorService, RetailFloorSettingsService } from "../RetailFloorService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// Contexto do usuário no módulo (qualquer papel — o escopo é resolvido dentro).
router.get("/context", (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorService.context(req.organizationId!, req.user));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Erro ao montar contexto" });
  }
});

// Settings da org (globais ao módulo) — só owner/admin configuram.
router.get("/settings", requireRole("owner", "admin"), (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorSettingsService.get(req.organizationId!));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Erro ao ler settings" });
  }
});

router.put("/settings", requireRole("owner", "admin"), (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorSettingsService.update(req.organizationId!, req.body || {}, actor(req)));
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "Settings inválidas" });
  }
});

export default router;
