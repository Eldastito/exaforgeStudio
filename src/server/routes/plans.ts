import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { PlanService } from "../PlanService.js";
import { AsaasService } from "../AsaasService.js";
import { ConsumptionService } from "../ConsumptionService.js";
import { AddonService } from "../AddonService.js";
import { ModuleService } from "../ModuleService.js";
import db from "../db.js";

const addonLabel = (key: string) => (ModuleService as any).MODULE_META?.[key]?.label || key;
const addonDesc = (key: string) => (ModuleService as any).MODULE_META?.[key]?.desc || "";

const router = Router();

// GET /api/plans — lista os planos disponíveis (público para a UI de escolha).
router.get("/", (req: AuthRequest, res): any => {
  try {
    res.json(PlanService.listPlans());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/plans/current — plano atual + status + uso vs limites.
router.get("/current", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json(PlanService.getBillingSnapshot(orgId));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/plans/alerts — alertas de uso (80/90/100% dos limites do plano).
router.get("/alerts", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ alerts: PlanService.getUsageAlerts(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/select — escolhe/troca o plano da org. Inicia trial na primeira escolha.
router.post("/select", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const { planId } = req.body || {};
    if (!planId) return res.status(400).json({ error: "planId é obrigatório." });
    const r = PlanService.selectPlan(orgId, planId);
    if (!r.ok) return res.status(400).json({ error: r.reason || "Erro ao selecionar plano." });
    res.json({ success: true, ...PlanService.getBillingSnapshot(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== Assinatura ASAAS (ADR-091 Bloco B) — ZappFlow cobra o lojista =====

// GET /api/plans/billing/invoices — faturas da assinatura (ASAAS).
router.get("/billing/invoices", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json({ invoices: await AsaasService.listInvoices(orgId) }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/billing/subscribe — ativa a assinatura recorrente do plano
// atual no ASAAS (checkout ao fim do trial). Precisa do CPF/CNPJ do responsável.
router.post("/billing/subscribe", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    if (!AsaasService.isConfigured()) return res.status(503).json({ error: "Cobrança online ainda não está configurada. Fale com o suporte." });
    const { cpfCnpj, name, email } = req.body || {};
    if (!cpfCnpj) return res.status(400).json({ error: "CPF/CNPJ é obrigatório para ativar a assinatura." });

    const snap = PlanService.getBillingSnapshot(orgId);
    if (!snap.plan) return res.status(400).json({ error: "Escolha um plano antes de assinar." });

    const org = db.prepare(`SELECT business_name, email, phone FROM organization_settings WHERE organization_id = ?`).get(orgId) as any || {};
    const nextDueDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10); // amanhã
    const r = await AsaasService.subscribe(orgId, {
      customer: { name: name || org.business_name || "Cliente ZappFlow", email: email || org.email || "", cpfCnpj, mobilePhone: org.phone },
      value: Number(snap.plan.price || 0),
      description: `ZappFlow ${snap.plan.name}`,
      nextDueDate,
    });
    if (!r) return res.status(502).json({ error: "Não consegui criar a assinatura no gateway. Tente de novo." });
    const invoices = await AsaasService.listInvoices(orgId);
    res.json({ success: true, subscriptionId: r.subscriptionId, invoices });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/billing/cancel — cancela a assinatura (aviso: modo somente-leitura).
router.post("/billing/cancel", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const ok = await AsaasService.cancelSubscription(orgId);
    res.json({ success: ok, ...PlanService.getBillingSnapshot(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== Consumo excedente de IA (ADR-091 §4, Bloco D) =====

// GET /api/plans/consumption — uso vs folga do mês + pacote extra disponível.
router.get("/consumption", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ConsumptionService.status(orgId)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/consumption/topup — compra 1 pacote extra de ações.
router.post("/consumption/topup", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const bought = ConsumptionService.buyTopup(orgId, "manual");
    if (!bought) return res.status(400).json({ error: "Seu plano não tem pacote extra (Enterprise é negociado)." });
    res.json({ success: true, bought, ...ConsumptionService.status(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/consumption/auto-topup { enabled } — liga/desliga recompra a 90%.
router.post("/consumption/auto-topup", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ConsumptionService.setAutoTopup(orgId, !!req.body?.enabled)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ===== Add-ons contratáveis (ADR-091 §5, Bloco D) =====

// GET /api/plans/addons — disponíveis (do plano) + ativos, com rótulos.
router.get("/addons", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const l = AddonService.list(orgId);
    res.json({
      available: l.available.map(a => ({ ...a, label: addonLabel(a.key), desc: addonDesc(a.key) })),
      active: l.active.map((a: any) => ({ ...a, label: addonLabel(a.key), desc: addonDesc(a.key) })),
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/addons/contract { key } — contrata um add-on e liga o módulo.
router.post("/addons/contract", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const key = String(req.body?.key || "");
    const r = AddonService.contract(orgId, key);
    if (!r.ok) return res.status(400).json({ error: r.reason || "Não foi possível contratar." });
    ModuleService.enableModule(orgId, key); // liga o módulo em enabled_modules
    res.json({ success: true, price: r.price });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/plans/addons/cancel { key } — cancela o add-on (o módulo perde acesso).
router.post("/addons/cancel", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(AddonService.cancel(orgId, String(req.body?.key || ""))); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

export default router;
