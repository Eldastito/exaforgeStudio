/**
 * Rotas REST do Business Skills Pack (Track C do PRD-PEL-01).
 * F1 escopo: pricing suggest + org config CRUD.
 * F2 vai adicionar quote template + createQuoteFromTemplate.
 * F4 vai adicionar gate de plano (RN-BSP-08).
 */
import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { BusinessSkillsPackService, BusinessSkillsPackError } from "../BusinessSkillsPackService.js";

const router = Router();

// GET /api/bsp/pricing/suggest?cost=X&vertical=Y&markup=Z&targetMargin=W
router.get("/pricing/suggest", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const cost = Number(req.query.cost);
    if (!isFinite(cost)) {
      return res.status(400).json({ error: "cost é obrigatório e deve ser número", code: "invalid_cost" });
    }
    const vertical = typeof req.query.vertical === "string" ? req.query.vertical : undefined;
    const markup = req.query.markup ? Number(req.query.markup) : undefined;
    const targetMargin = req.query.targetMargin ? Number(req.query.targetMargin) : undefined;

    res.json(BusinessSkillsPackService.suggestPrice({
      orgId: req.organizationId,
      cost,
      vertical,
      markup_percent: markup,
      target_margin: targetMargin,
    }));
  } catch (e: any) {
    if (e instanceof BusinessSkillsPackError) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// GET /api/bsp/config — config atual da org
router.get("/config", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const cfg = BusinessSkillsPackService.getOrgConfig(req.organizationId);
    res.json(cfg ?? { organization_id: req.organizationId, pricing_prefs: null, quote_template: null, outreach_pack: null, enabled_dimensions: ["pricing", "rfp", "local_marketing"] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// PATCH /api/bsp/config { pricing_prefs?, quote_template?, outreach_pack?, enabled_dimensions? }
router.patch("/config", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    const patch: any = {};
    if (Object.prototype.hasOwnProperty.call(b, "pricing_prefs")) patch.pricing_prefs = b.pricing_prefs;
    if (Object.prototype.hasOwnProperty.call(b, "quote_template")) patch.quote_template = b.quote_template;
    if (Object.prototype.hasOwnProperty.call(b, "outreach_pack")) patch.outreach_pack = b.outreach_pack;
    if (Object.prototype.hasOwnProperty.call(b, "enabled_dimensions")) patch.enabled_dimensions = b.enabled_dimensions;

    const updated = BusinessSkillsPackService.updateOrgConfig(req.organizationId, patch);
    res.json(updated);
  } catch (e: any) {
    if (e instanceof BusinessSkillsPackError) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

export default router;
