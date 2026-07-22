import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";

// ZappFlow Comigo — módulo `copiloto` do plano Autônomo (ADR-111/112/113).
// PR #1: registro do módulo + schema. Este router expõe só o /overview
// (usado pela ComigoView para confirmar que o módulo está ligado e mostrar os
// contadores da caderneta). Balcão, precificação e caderneta entram nos PRs
// seguintes. O gate de módulo (ModuleService.MODULE_BY_ROUTE['comigo'] =
// 'copiloto') já barra a rota inteira quando o módulo está desligado.
const router = Router();

// GET /api/comigo/overview — estado do módulo para o dono: nº de fichas,
// pedidos em aberto e o saldo total em fiado (a receber). Somente leitura.
router.get("/overview", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const recipes = (db.prepare("SELECT COUNT(*) c FROM comigo_recipes WHERE organization_id = ?").get(orgId) as any)?.c || 0;
    const openOrders = (db.prepare("SELECT COUNT(*) c FROM comigo_orders WHERE organization_id = ? AND status = 'open'").get(orgId) as any)?.c || 0;
    // Saldo em fiado (a receber) = Σ debt − Σ payment no razão do fiado.
    const debt = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind = 'debt'").get(orgId) as any)?.s || 0;
    const paid = (db.prepare("SELECT COALESCE(SUM(amount),0) s FROM comigo_fiado_ledger WHERE organization_id = ? AND kind = 'payment'").get(orgId) as any)?.s || 0;
    const blacklisted = (db.prepare("SELECT COUNT(*) c FROM comigo_customer_credit WHERE organization_id = ? AND blacklisted = 1").get(orgId) as any)?.c || 0;
    res.json({
      recipes,
      openOrders,
      fiadoReceivable: Math.max(0, debt - paid),
      blacklisted,
    });
  } catch (e: any) {
    res.status(500).json({ error: "overview_failed", detail: String(e?.message || e) });
  }
});

export default router;
