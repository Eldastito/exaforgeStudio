import { Router } from "express";
import db from "../db.js";
import { AuthRequest } from "../middleware/auth.js";
import { SkillRegistry } from "../skills.js";
import { ModuleService } from "../ModuleService.js";

const router = Router();

// GET /api/skills — catálogo de skills da org (instaladas + disponíveis).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const o = db.prepare("SELECT vertical FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
    res.json(SkillRegistry.catalog(orgId, o?.vertical));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/skills/:key/toggle — instala/desinstala (liga/desliga o módulo).
router.post("/:key/toggle", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const key = req.params.key;
    const current = new Set(ModuleService.enabledModules(orgId) || []);
    const install = req.body?.install !== false ? !current.has(key) : false;
    if (install) current.add(key); else current.delete(key);
    const saved = ModuleService.setModules(orgId, [...current]);
    res.json({ success: true, installed: saved.includes(key), enabledModules: saved });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
