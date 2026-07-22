import { Router } from "express";
import db from "../db.js";
import { randomUUID } from "crypto";
import { AuthRequest } from "../middleware/auth.js";
import { ComigoPricingService } from "../ComigoPricingService.js";
import { BalcaoService } from "../BalcaoService.js";
import { ComigoCollectionService } from "../ComigoCollectionService.js";
import { ComigoHealthService, Period } from "../ComigoHealthService.js";
import { ComigoSuggestionService } from "../ComigoSuggestionService.js";
import { ComigoPixService } from "../ComigoPixService.js";
import { ComigoMesaService } from "../ComigoMesaService.js";

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
  const o = db.prepare("SELECT comigo_hour_value, comigo_fiado_default_limit, comigo_fiado_reminder_enabled, comigo_fixed_costs_monthly FROM organization_settings WHERE organization_id = ?").get(orgId) as any || {};
  res.json({
    hourValue: Number(o.comigo_hour_value) || 0,
    fiadoDefaultLimit: Number(o.comigo_fiado_default_limit) || 0,
    fiadoReminderEnabled: !!o.comigo_fiado_reminder_enabled,
    fixedCostsMonthly: Number(o.comigo_fixed_costs_monthly) || 0,
  });
});

// PUT /api/comigo/settings — atualiza o "quanto vale sua hora" e limites.
router.put("/settings", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { hourValue, fiadoDefaultLimit, fiadoReminderEnabled, fixedCostsMonthly } = req.body || {};
  const sets: string[] = []; const vals: any[] = [];
  if (hourValue !== undefined) { sets.push("comigo_hour_value = ?"); vals.push(Number(hourValue) || 0); }
  if (fiadoDefaultLimit !== undefined) { sets.push("comigo_fiado_default_limit = ?"); vals.push(Number(fiadoDefaultLimit) || 0); }
  if (fiadoReminderEnabled !== undefined) { sets.push("comigo_fiado_reminder_enabled = ?"); vals.push(fiadoReminderEnabled ? 1 : 0); }
  if (fixedCostsMonthly !== undefined) { sets.push("comigo_fixed_costs_monthly = ?"); vals.push(Number(fixedCostsMonthly) || 0); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(orgId);
  db.prepare(`UPDATE organization_settings SET ${sets.join(", ")} WHERE organization_id = ?`).run(...vals);
  res.json({ ok: true });
});

// ── Balcão PDV + fiado (ADR-111 D4 / ADR-112 / ADR-113, PR #3) ───────────────

// POST /api/comigo/orders — abre um pedido na fila do Balcão.
router.post("/orders", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { sessionAlias, contactId, consumo } = req.body || {};
  const id = BalcaoService.openOrder(orgId, { sessionAlias, contactId, consumo });
  res.status(201).json({ id });
});

// GET /api/comigo/orders?status=open — fila do Balcão.
router.get("/orders", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const status = String(req.query.status || "open");
  const rows = db.prepare("SELECT * FROM comigo_orders WHERE organization_id = ? AND status = ? ORDER BY created_at ASC").all(orgId, status);
  res.json({ orders: rows });
});

// GET /api/comigo/orders/:id — pedido + itens.
router.get("/orders/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const order = db.prepare("SELECT * FROM comigo_orders WHERE organization_id = ? AND id = ?").get(orgId, req.params.id) as any;
  if (!order) return res.status(404).json({ error: "not_found" });
  const items = db.prepare("SELECT * FROM comigo_order_items WHERE order_id = ?").all(req.params.id);
  res.json({ order, items });
});

// POST /api/comigo/orders/:id/items — adiciona item (por toque).
router.post("/orders/:id/items", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { productId, name, qty, unitPrice, unitCostSnapshot } = req.body || {};
  if (!name || unitPrice == null) return res.status(400).json({ error: "name_and_price_required" });
  try {
    const itemId = BalcaoService.addItem(orgId, req.params.id, { productId, name, qty, unitPrice, unitCostSnapshot });
    res.status(201).json({ id: itemId });
  } catch (e: any) {
    res.status(e?.message === "order_not_found" ? 404 : 409).json({ error: e?.message || "add_item_failed" });
  }
});

// POST /api/comigo/orders/:id/pay — cobra (dinheiro / Pix "recebi" / fiado).
// Fiado com estouro de limite ou cliente block_all devolve needsOverride=true.
router.post("/orders/:id/pay", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { paidVia, customer, override } = req.body || {};
  if (!["cash", "pix_manual", "fiado"].includes(paidVia)) return res.status(400).json({ error: "invalid_paid_via" });
  try {
    const out = BalcaoService.pay(orgId, req.params.id, { paidVia, customer, override: !!override, actorId: req.user?.userId });
    if (!out.ok) return res.status(out.needsOverride ? 409 : 422).json(out);
    audit(orgId, req.user?.userId, req.params.id, "comigo_order_pay", { paidVia, override: !!override });
    res.json(out);
  } catch (e: any) {
    res.status(e?.message === "order_not_found" ? 404 : 409).json({ error: e?.message || "pay_failed" });
  }
});

// POST /api/comigo/orders/:id/pix-dynamic — gera a cobrança Pix dinâmica (ADR-118).
router.post("/orders/:id/pix-dynamic", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const out = ComigoPixService.createCharge(orgId, req.params.id);
  if (!out.ok) return res.status(out.error === "order_not_found" ? 404 : 409).json(out);
  audit(orgId, req.user?.userId, req.params.id, "comigo_pix_create", { txid: out.txid });
  res.json(out);
});

// GET /api/comigo/orders/:id/pix-status — polling da confirmação do Pix dinâmico.
router.get("/orders/:id/pix-status", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json(ComigoPixService.statusOf(orgId, req.params.id));
});

// POST /api/comigo/orders/:id/cancel — cancela o pedido em aberto.
router.post("/orders/:id/cancel", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const r = db.prepare("UPDATE comigo_orders SET status = 'canceled' WHERE organization_id = ? AND id = ? AND status = 'open'").run(orgId, req.params.id);
  if (!r.changes) return res.status(404).json({ error: "not_found_or_not_open" });
  res.json({ ok: true });
});

// GET /api/comigo/fiado — clientes com saldo/limite/lista negra (a Caderneta).
// Inclui `blacklistSuggested` (ADR-113 D1): a IA SUGERE após N dias de dívida
// vencida; quem marca é o dono. `daysOverdue` = idade da dívida mais antiga.
router.get("/fiado", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const suggestDays = Number((db.prepare("SELECT comigo_blacklist_suggest_days FROM organization_settings WHERE organization_id = ?").get(orgId) as any)?.comigo_blacklist_suggest_days) || 20;
  const rows = db.prepare(`
    SELECT cc.contact_id, ct.name, ct.identifier AS phone, cc.credit_limit, cc.blacklisted, cc.block_all_sales,
           COALESCE((SELECT SUM(CASE WHEN kind='debt' THEN amount ELSE -amount END) FROM comigo_fiado_ledger l WHERE l.organization_id = cc.organization_id AND l.contact_id = cc.contact_id), 0) AS balance,
           (SELECT MIN(created_at) FROM comigo_fiado_ledger l WHERE l.organization_id = cc.organization_id AND l.contact_id = cc.contact_id AND l.kind='debt') AS oldest_debt,
           (SELECT COUNT(*) FROM comigo_fiado_reminders r WHERE r.organization_id = cc.organization_id AND r.contact_id = cc.contact_id) AS reminders
    FROM comigo_customer_credit cc LEFT JOIN contacts ct ON ct.id = cc.contact_id
    WHERE cc.organization_id = ? ORDER BY balance DESC
  `).all(orgId) as any[];
  const customers = rows.map((r) => {
    const daysOverdue = r.oldest_debt ? Math.floor((Date.now() - new Date(r.oldest_debt + "Z").getTime()) / 86400000) : 0;
    return { ...r, daysOverdue, blacklistSuggested: !r.blacklisted && r.balance > 0 && daysOverdue >= suggestDays };
  });
  res.json({ customers, suggestDays });
});

// GET /api/comigo/summary?date=YYYY-MM-DD — caixa × a receber (ADR-112 D3).
// Caixa = só o RECEBIDO (à vista + fiado quitado). Fiado em aberto é a receber,
// não infla o caixa. Deriva ticket médio das vendas do dia.
router.get("/summary", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  res.json(BalcaoService.daySummary(orgId, date));
});

// ── Mesa/QR (ADR-119) — lado autenticado (dono/operador) ─────────────────────

// GET /api/comigo/mesa/link — token + URL do QR da mesa.
router.get("/mesa/link", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const token = ComigoMesaService.ensureToken(orgId);
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  res.json({ token, url: base ? `${base}/mesa/${token}` : `/mesa/${token}` });
});

// POST /api/comigo/mesa/regenerate — gera um novo token (invalida o QR antigo).
router.post("/mesa/regenerate", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const token = ComigoMesaService.regenerate(orgId);
  audit(orgId, req.user?.userId, orgId, "comigo_mesa_regenerate", {});
  const base = (process.env.APP_URL || "").replace(/\/$/, "");
  res.json({ token, url: base ? `${base}/mesa/${token}` : `/mesa/${token}` });
});

// GET /api/comigo/mesa/queue — fila de preparo (pedidos de mesa pagos).
router.get("/mesa/queue", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ orders: ComigoMesaService.prepQueue(orgId) });
});

// POST /api/comigo/orders/:id/fulfill — marca o pedido de mesa como entregue.
router.post("/orders/:id/fulfill", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ok = ComigoMesaService.markFulfilled(orgId, req.params.id);
  if (!ok) return res.status(404).json({ error: "not_found_or_not_ready" });
  res.json({ ok: true });
});

// GET /api/comigo/suggest?productId= — sugestão zero-token (ADR-117): co-ocorrência
// do item atual + mais pedidos (upsell no Balcão). Sem productId, só os mais pedidos.
router.get("/suggest", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const productId = req.query.productId ? String(req.query.productId) : undefined;
  res.json(ComigoSuggestionService.forBalcao(orgId, productId));
});

// GET /api/comigo/health?period=dia|semana|mes — termômetro de saúde (ADR-116).
router.get("/health", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const p = String(req.query.period || "dia");
  const period: Period = (["dia", "semana", "mes"].includes(p) ? p : "dia") as Period;
  res.json(ComigoHealthService.overview(orgId, period));
});

// POST /api/comigo/fiado/:contactId/remind — cobrança amigável (texto + wa.me).
router.post("/fiado/:contactId/remind", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const built = ComigoCollectionService.record(orgId, req.params.contactId, req.body?.level, req.user?.userId);
  audit(orgId, req.user?.userId, req.params.contactId, "comigo_fiado_remind", { level: built.level });
  res.json(built);
});

// POST /api/comigo/fiado/:contactId/settle — recebe (total/parcial).
router.post("/fiado/:contactId/settle", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const { amount, note } = req.body || {};
  try {
    const out = BalcaoService.settleFiado(orgId, req.params.contactId, Number(amount), note, req.user?.userId);
    audit(orgId, req.user?.userId, req.params.contactId, "comigo_fiado_settle", { amount });
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: e?.message || "settle_failed" });
  }
});

// PUT /api/comigo/fiado/:contactId/credit — define o limite do cliente.
router.put("/fiado/:contactId/credit", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  BalcaoService.setCreditLimit(orgId, req.params.contactId, Number(req.body?.limit));
  audit(orgId, req.user?.userId, req.params.contactId, "comigo_fiado_limit", { limit: req.body?.limit });
  res.json({ ok: true });
});

// POST /api/comigo/fiado/:contactId/blacklist — marca/desmarca lista negra.
router.post("/fiado/:contactId/blacklist", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const on = !!req.body?.on;
  BalcaoService.setBlacklist(orgId, req.params.contactId, on, req.body?.reason);
  audit(orgId, req.user?.userId, req.params.contactId, on ? "comigo_blacklist_add" : "comigo_blacklist_remove", { reason: req.body?.reason });
  res.json({ ok: true });
});

// POST /api/comigo/fiado/:contactId/block-all — suspensão total (inclui à vista).
router.post("/fiado/:contactId/block-all", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  BalcaoService.setBlockAllSales(orgId, req.params.contactId, !!req.body?.on);
  audit(orgId, req.user?.userId, req.params.contactId, "comigo_block_all", { on: !!req.body?.on });
  res.json({ ok: true });
});

export default router;
