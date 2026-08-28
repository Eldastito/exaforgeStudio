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

// ── F2: RFP — templates de orçamento ──

// GET /api/bsp/rfp/template — template atual (com fallback default)
router.get("/rfp/template", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(BusinessSkillsPackService.getQuoteTemplate(req.organizationId));
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// PUT /api/bsp/rfp/template { header?, greeting?, footer?, conditions?, signature? }
router.put("/rfp/template", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    // Aceita null pra "reset ao default"
    const template = b === null ? null : {
      header: typeof b.header === "string" ? b.header : undefined,
      greeting: typeof b.greeting === "string" ? b.greeting : undefined,
      footer: typeof b.footer === "string" ? b.footer : undefined,
      conditions: Array.isArray(b.conditions)
        ? b.conditions.filter((c: any) => typeof c === "string") : undefined,
      signature: typeof b.signature === "string" ? b.signature : undefined,
    };
    // Remove chaves undefined pra evitar sobrescrever com "nada"
    const cleaned: any = {};
    for (const [k, v] of Object.entries(template || {})) {
      if (v !== undefined) cleaned[k] = v;
    }
    const updated = BusinessSkillsPackService.updateOrgConfig(req.organizationId, {
      quote_template: Object.keys(cleaned).length > 0 ? cleaned : null,
    });
    res.json(updated.quote_template ?? BusinessSkillsPackService.getQuoteTemplate(req.organizationId));
  } catch (e: any) {
    if (e instanceof BusinessSkillsPackError) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// POST /api/bsp/rfp/create { items, contactId?, ticketId?, contactName?, orgName?, templateOverrides? }
router.post("/rfp/create", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    const result = BusinessSkillsPackService.createQuoteFromTemplate({
      orgId: req.organizationId,
      items: Array.isArray(b.items) ? b.items : [],
      contactId: typeof b.contactId === "string" ? b.contactId : undefined,
      ticketId: typeof b.ticketId === "string" ? b.ticketId : undefined,
      contactName: typeof b.contactName === "string" ? b.contactName : undefined,
      orgName: typeof b.orgName === "string" ? b.orgName : undefined,
      createdBy: (req as any).user?.id || undefined,
      templateOverrides: b.templateOverrides && typeof b.templateOverrides === "object" ? b.templateOverrides : undefined,
    });
    res.status(201).json(result);
  } catch (e: any) {
    if (e instanceof BusinessSkillsPackError) {
      const s = e.code === "quote_failed" ? 422 : 400;
      return res.status(s).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// ── F3: Local Marketing — enrichment contact↔competitor ──

// POST /api/bsp/local-marketing/enrich — dispara o batch de matching
router.post("/local-marketing/enrich", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(BusinessSkillsPackService.enrichContactsWithCompetitor(req.organizationId));
  } catch (e: any) {
    if (e instanceof BusinessSkillsPackError) {
      return res.status(400).json({ error: e.message, code: e.code });
    }
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// GET /api/bsp/local-marketing/matches?limit=200 — lista matches cacheados
router.get("/local-marketing/matches", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const limit = req.query.limit ? Number(req.query.limit) : undefined;
    res.json({
      matches: BusinessSkillsPackService.listContactCompetitorMatches(req.organizationId, { limit }),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

// GET /api/bsp/rfp/metrics/by-agent?days=30 — métricas por vendedor (RN-BSP-05)
router.get("/rfp/metrics/by-agent", (req: AuthRequest, res): any => {
  if (!req.organizationId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const days = req.query.days ? Number(req.query.days) : undefined;
    res.json({
      metrics: BusinessSkillsPackService.salesMetricsByAgent(req.organizationId, { days }),
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "internal_error" });
  }
});

export default router;
