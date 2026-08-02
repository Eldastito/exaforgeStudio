/**
 * Retail Floor — API (ADR-150). Montada em /api/retail-floor, gated pelo módulo
 * `retail_floor` (ModuleService.MODULE_BY_ROUTE["retail-floor"]). Fatia 1:
 * contexto por escopo + settings. Fatia 2: turno + lista da vez (posição
 * derivada). As fatias seguintes acrescentam atendimento, scan, conciliação e
 * analytics.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RetailFloorService, RetailFloorSettingsService } from "../RetailFloorService.js";
import { RetailFloorShiftService, RetailFloorQueueService } from "../RetailFloorShiftService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;

// Converte o erro padronizado de escopo (RN-150-005) em 403; o resto é 400.
const fail = (res: any, e: any) => {
  const msg = e?.message || "Requisição inválida";
  res.status(msg === "store_scope_denied" ? 403 : 400).json({ error: msg });
};

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

// ---- Fatia 2: turno + lista da vez ----

// Abre o turno da loja (gestor da loja — RN-150-005).
router.post("/shifts", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json(RetailFloorShiftService.open(req.organizationId!, storeId, req.user));
  } catch (e: any) { fail(res, e); }
});

// Fecha o turno (gestor da loja).
router.post("/shifts/:id/close", (req: AuthRequest, res) => {
  try {
    res.json(RetailFloorShiftService.close(req.organizationId!, req.params.id, req.user));
  } catch (e: any) { fail(res, e); }
});

// Turno aberto da loja + lista da vez ordenada (qualquer papel — é o Kanban).
router.get("/shifts/current", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.query.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    const shift = RetailFloorShiftService.currentForStore(req.organizationId!, storeId);
    if (!shift) return res.json({ shift: null, queue: null });
    res.json({ shift, queue: RetailFloorQueueService.ordered(req.organizationId!, shift.id) });
  } catch (e: any) { fail(res, e); }
});

// Entra na lista da vez (o próprio vendedor; gestor pode adicionar terceiro).
router.post("/queue/join", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json(RetailFloorQueueService.join(req.organizationId!, { storeId, sellerId: req.body?.sellerId || null }, req.user));
  } catch (e: any) { fail(res, e); }
});

// Muda status na fila (próprio: waiting|break|unavailable|offline; gestor: + skipped).
router.post("/queue/:sellerId/status", (req: AuthRequest, res) => {
  try {
    const storeId = String(req.body?.storeId || "");
    if (!storeId) return res.status(400).json({ error: "storeId é obrigatório" });
    res.json(RetailFloorQueueService.setStatus(req.organizationId!, { storeId, sellerId: req.params.sellerId, status: String(req.body?.status || "") }, req.user));
  } catch (e: any) { fail(res, e); }
});

export default router;
