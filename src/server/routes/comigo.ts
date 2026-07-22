import { Router } from "express";
import db from "../db.js";
import { randomUUID } from "crypto";
import { AuthRequest } from "../middleware/auth.js";
import { ComigoPricingService } from "../ComigoPricingService.js";

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

// ── Motor de Precificação (ADR-111 D3, PR #2) ───────────────────────────────
const audit = (orgId?: string, actorId?: string, targetId?: string, eventType = '', meta: any = {}) => {
  try {
    db.prepare(`INSERT INTO auth_audit_logs (id, organization_id, actor_user_id, target_user_id, event_type, metadata_json) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), orgId || null, actorId || null, targetId || null, eventType, JSON.stringify(meta));
  } catch (e) { /* noop */ }
};
const VALID_KINDS = ["revenda", "fabricacao", "servico"];
const VALID_COST_KINDS = ["insumo", "indireto", "tempo"];

// GET /api/comigo/recipes — lista as fichas técnicas da organização.
router.get("/recipes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const rows = db.prepare("SELECT * FROM comigo_recipes WHERE organization_id = ? ORDER BY updated_at DESC").all(orgId);
  res.json({ recipes: rows });
});

// POST /api/comigo/recipes — cria uma ficha técnica.
router.post("/recipes", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { name, kind, product_id, yield_qty, labor_minutes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: "name_required" });
  const k = VALID_KINDS.includes(kind) ? kind : "revenda";
  const id = randomUUID();
  db.prepare(
    `INSERT INTO comigo_recipes (id, organization_id, product_id, name, kind, yield_qty, labor_minutes) VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(id, orgId, product_id || null, String(name).trim(), k, yield_qty ?? null, labor_minutes ?? null);
  audit(orgId, req.user?.userId, id, "comigo_recipe_create", { name, kind: k });
  res.status(201).json({ id });
});

// GET /api/comigo/recipes/:id — ficha + custos + custo/preço/dica já calculados.
router.get("/recipes/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const found = ComigoPricingService.getRecipeWithCosts(orgId, req.params.id);
  if (!found) return res.status(404).json({ error: "not_found" });
  const margin = req.query.margin != null ? Number(req.query.margin) : 0.3;
  const priced = ComigoPricingService.computeForRecipe(orgId, req.params.id, margin);
  res.json({ recipe: found.recipe, costs: found.costs, ...priced });
});

// PATCH /api/comigo/recipes/:id — atualiza campos da ficha.
router.patch("/recipes/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const exists = db.prepare("SELECT id FROM comigo_recipes WHERE organization_id = ? AND id = ?").get(orgId, req.params.id);
  if (!exists) return res.status(404).json({ error: "not_found" });
  const { name, kind, yield_qty, labor_minutes } = req.body || {};
  const sets: string[] = []; const vals: any[] = [];
  if (name != null) { sets.push("name = ?"); vals.push(String(name).trim()); }
  if (kind != null && VALID_KINDS.includes(kind)) { sets.push("kind = ?"); vals.push(kind); }
  if (yield_qty !== undefined) { sets.push("yield_qty = ?"); vals.push(yield_qty); }
  if (labor_minutes !== undefined) { sets.push("labor_minutes = ?"); vals.push(labor_minutes); }
  if (!sets.length) return res.json({ ok: true });
  sets.push("updated_at = CURRENT_TIMESTAMP");
  vals.push(orgId, req.params.id);
  db.prepare(`UPDATE comigo_recipes SET ${sets.join(", ")} WHERE organization_id = ? AND id = ?`).run(...vals);
  audit(orgId, req.user?.userId, req.params.id, "comigo_recipe_update", {});
  res.json({ ok: true });
});

// DELETE /api/comigo/recipes/:id — remove a ficha e seus custos.
router.delete("/recipes/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const exists = db.prepare("SELECT id FROM comigo_recipes WHERE organization_id = ? AND id = ?").get(orgId, req.params.id);
  if (!exists) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM comigo_recipe_costs WHERE recipe_id = ?").run(req.params.id);
  db.prepare("DELETE FROM comigo_recipes WHERE organization_id = ? AND id = ?").run(orgId, req.params.id);
  audit(orgId, req.user?.userId, req.params.id, "comigo_recipe_delete", {});
  res.json({ ok: true });
});

// POST /api/comigo/recipes/:id/costs — adiciona um item de custo à ficha.
router.post("/recipes/:id/costs", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const recipe = db.prepare("SELECT id FROM comigo_recipes WHERE organization_id = ? AND id = ?").get(orgId, req.params.id);
  if (!recipe) return res.status(404).json({ error: "not_found" });
  const { label, kind, amount, is_estimate } = req.body || {};
  if (!label || !String(label).trim()) return res.status(400).json({ error: "label_required" });
  const k = VALID_COST_KINDS.includes(kind) ? kind : "insumo";
  const id = randomUUID();
  db.prepare(
    `INSERT INTO comigo_recipe_costs (id, recipe_id, label, kind, amount, is_estimate) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.params.id, String(label).trim(), k, Number(amount) || 0, is_estimate === false || is_estimate === 0 ? 0 : 1);
  res.status(201).json({ id });
});

// DELETE /api/comigo/recipes/:id/costs/:costId — remove um custo da ficha.
router.delete("/recipes/:id/costs/:costId", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const recipe = db.prepare("SELECT id FROM comigo_recipes WHERE organization_id = ? AND id = ?").get(orgId, req.params.id);
  if (!recipe) return res.status(404).json({ error: "not_found" });
  db.prepare("DELETE FROM comigo_recipe_costs WHERE recipe_id = ? AND id = ?").run(req.params.id, req.params.costId);
  res.json({ ok: true });
});

// POST /api/comigo/recipes/:id/calibrate — loop estimativa->realidade (ADR-088 D6).
router.post("/recipes/:id/calibrate", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { actualYield, wasteQty, note } = req.body || {};
  if (actualYield == null || !(Number(actualYield) > 0)) return res.status(400).json({ error: "actual_yield_required" });
  const out = ComigoPricingService.applyCalibration(orgId, req.params.id, Number(actualYield), Number(wasteQty) || 0, note, req.user?.userId);
  if (!out) return res.status(404).json({ error: "not_found" });
  audit(orgId, req.user?.userId, req.params.id, "comigo_recipe_calibrate", { actualYield, wasteQty });
  res.json(out);
});

// GET /api/comigo/settings — valor da hora + limites do fiado.
router.get("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const o = db.prepare("SELECT comigo_hour_value, comigo_fiado_default_limit, comigo_fiado_reminder_enabled FROM organization_settings WHERE organization_id = ?").get(orgId) as any || {};
  res.json({
    hourValue: Number(o.comigo_hour_value) || 0,
    fiadoDefaultLimit: Number(o.comigo_fiado_default_limit) || 0,
    fiadoReminderEnabled: !!o.comigo_fiado_reminder_enabled,
  });
});

// PUT /api/comigo/settings — atualiza o "quanto vale sua hora" e limites.
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { hourValue, fiadoDefaultLimit, fiadoReminderEnabled } = req.body || {};
  const sets: string[] = []; const vals: any[] = [];
  if (hourValue !== undefined) { sets.push("comigo_hour_value = ?"); vals.push(Number(hourValue) || 0); }
  if (fiadoDefaultLimit !== undefined) { sets.push("comigo_fiado_default_limit = ?"); vals.push(Number(fiadoDefaultLimit) || 0); }
  if (fiadoReminderEnabled !== undefined) { sets.push("comigo_fiado_reminder_enabled = ?"); vals.push(fiadoReminderEnabled ? 1 : 0); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(orgId);
  db.prepare(`UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`).run(...vals);
  res.json({ ok: true });
});

export default router;
