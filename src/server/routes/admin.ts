import { Router } from "express";
import bcrypt from "bcrypt";
import db from "../db.js";
import { v4 as uuidv4 } from "uuid";
import { SecurityAuditService } from "../SecurityAuditService.js";
import { SecurityConfigurationService } from "../SecurityConfigurationService.js";
import { AuthRequest } from "../middleware/auth.js";
import { MessageProviderService } from "../MessageProviderService.js";
import { PlanService } from "../PlanService.js";
import { VerticalBlueprintService } from "../VerticalBlueprintService.js";
import { VERTICALS } from "../verticals.js";
import { BlueprintSeeder } from "../BlueprintSeeder.js";
import { UpgradeRecommendationService } from "../UpgradeRecommendationService.js";
import { AiUsageDashboardService } from "../AiUsageDashboardService.js";
import { FalatuSaveOfferService } from "../FalatuSaveOfferService.js";
import { ProductionReadinessService } from "../ProductionReadinessService.js";
import { OperationalHealthService } from "../OperationalHealthService.js";
import { PlatformBaselineService } from "../PlatformBaselineService.js";
import { CapacityHeadroomService } from "../CapacityHeadroomService.js";
import { CapacityForecastService } from "../CapacityForecastService.js";
import { VpsSpecProfileService } from "../VpsSpecProfileService.js";
import { SloDefinitionService } from "../SloDefinitionService.js";
import { PlatformRootCauseService } from "../PlatformRootCauseService.js";
import { CapacityRecommendationService } from "../CapacityRecommendationService.js";
import { PlatformProtectionModeService } from "../PlatformProtectionModeService.js";
import { PlatformAlertService } from "../PlatformAlertService.js";
import { CapacityEnvelopeService } from "../CapacityEnvelopeService.js";
import { AiQuotaSignalService } from "../AiQuotaSignalService.js";
import { logAuthEvent } from "../auditLog.js";
import { JobQueueService } from "../JobQueueService.js";
import { MASTER_ADMIN_EMAIL } from "../config/secret.js";
import { RuntimePilotService } from "../RuntimePilotService.js";
import { HelpKnowledgeService } from "../HelpKnowledgeService.js";
import { eventsEnabled } from "../ContinuityService.js";
import { MessageDeliveryService } from "../MessageDeliveryService.js";
import { EdgeSyncService } from "../EdgeSyncService.js";
import productEvolutionRoutes from "./productEvolution.js";

const router = Router();

// ADR-193 F1 — Product Evolution Ledger montado como sub-router. Herda
// `requireMasterAdmin` do mount `/api/admin` em server.ts. GLOBAL (sem org).
router.use("/product-evolution", productEvolutionRoutes);

// ADR-154 F10.1 — prontidão de produção (master admin). Relatório completo de
// quais dependências estão configuradas pra vender: blockers, recomendados e
// canais opcionais. Sem segredo no payload — só estado + dica.
router.get("/production-readiness", (_req: AuthRequest, res): any => {
  try {
    return res.json(ProductionReadinessService.report());
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// Execution Runtime — habilitação por organização (Master Admin). É a trava
// mestra das abas Operações/Recuperação do Diretor IA (flag
// execution_runtime_enabled). Reusa o piloto do CLI (RuntimePilotService):
//   - /search: acha a org pelo nome (sem chutar id);
//   - /plan/:orgId: diagnóstico SEM escrita (o que está ligado, o que falta);
//   - POST /: liga (runtime + policies; opcional recuperação de vendas) ou
//     desliga (kill-switch execution_runtime_enabled=0). Auditado.
// Todo o router /api/admin herda requireMasterAdmin.
router.get("/runtime-pilot/search", (req: AuthRequest, res): any => {
  const q = String(req.query.q || "").trim();
  // Busca vazia LISTA as organizações (primeiras 20) — o operador nem sempre
  // sabe o nome exato; assim ele acha na lista em vez de adivinhar.
  return res.json({ orgs: RuntimePilotService.findOrgs(q) });
});
router.get("/runtime-pilot/plan/:orgId", (req: AuthRequest, res): any => {
  try { return res.json(RuntimePilotService.plan(String(req.params.orgId))); }
  catch (e: any) { return res.status(404).json({ error: e.message }); }
});
router.post("/runtime-pilot", (req: AuthRequest, res): any => {
  const orgId = String(req.body?.orgId || "").trim();
  if (!orgId) return res.status(400).json({ error: "orgId é obrigatório." });
  const actor = req.user?.email || "master";
  try {
    if (req.body?.enabled === false) {
      // Kill-switch: nunca apaga policies (ficam inertes); só fecha a trava.
      db.prepare(`UPDATE organization_settings SET execution_runtime_enabled = 0 WHERE organization_id = ?`).run(orgId);
      try { logAuthEvent(orgId, actor, null, "RUNTIME_PILOT_DISABLE", {}); } catch { /* audit best-effort */ }
      return res.json(RuntimePilotService.plan(orgId));
    }
    // Liga a trava e semeia as policies exigidas pelo executor. `salesRecovery`
    // (e follow-up/atribuição) ligam a aba Recuperação; sem eles, só Operações.
    const plan = RuntimePilotService.apply(orgId, {
      runtime: true,
      salesRecovery: req.body?.salesRecovery === true,
      followup: req.body?.followup === true,
      attribution: req.body?.attribution === true,
      seedPolicies: true,
    });
    return res.json(plan);
  } catch (e: any) { return res.status(400).json({ error: e.message }); }
});

// SEC-F2 — validação da configuração de segredos no boot (redigida: presença/tamanho/códigos,
// NUNCA o valor do segredo). Master-only (herda requireMasterAdmin).
router.get("/security-config", (_req: AuthRequest, res): any => {
  try {
    return res.json(SecurityConfigurationService.report());
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ADR-164 F5 — Operational Health: estende a Prontidão de Produção com saúde
// OPERACIONAL (runtime + SLI HTTP + dependências) além da de configuração. Master-only
// (herda o requireMasterAdmin do router). Não expõe segredo — só estado + números agregados.
router.get("/operational-health", (_req: AuthRequest, res): any => {
  try {
    return res.json(OperationalHealthService.snapshot());
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// ADR-164 F6 — baseline agregado de uma métrica (master-only). Sem histórico → honesto.
router.get("/platform-baseline", (req: AuthRequest, res): any => {
  try {
    const metric = typeof req.query?.metric === "string" ? req.query.metric : "app.p95";
    const seasonal = req.query?.seasonal === "1" || req.query?.seasonal === "true";
    const days = typeof req.query?.days === "string" ? Number(req.query.days) : undefined;
    return res.json(PlatformBaselineService.baseline(metric, { seasonal, days }));
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F6 — candidatos a anomalia (desvio sustentado vs baseline). Hipótese, não veredito.
router.get("/platform-anomalies", (req: AuthRequest, res): any => {
  try {
    const days = typeof req.query?.days === "string" ? Number(req.query.days) : undefined;
    return res.json(PlatformBaselineService.anomalies({ days }));
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F7 — headroom de capacidade por recurso + zona (§25-27). Recurso que exige
// o provider de host é declarado not_available; tendência vem do baseline da F6.
router.get("/capacity-headroom", (_req: AuthRequest, res): any => {
  try {
    return res.json(CapacityHeadroomService.snapshot());
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F8 — forecast de capacidade: projeta a trajetória de uma métrica e estima
// quando cruza o limiar crítico, com confiança. Sem histórico suficiente → honesto
// (insufficient_history, §59). `?metric=`, `?days=`, `?horizon=`; sem metric → visão de
// capacidade (métricas conhecidas + primeiro gargalo).
router.get("/capacity-forecast", (req: AuthRequest, res): any => {
  try {
    const metric = typeof req.query?.metric === "string" ? req.query.metric : undefined;
    const days = typeof req.query?.days === "string" ? Number(req.query.days) : undefined;
    const horizonDays = typeof req.query?.horizon === "string" ? Number(req.query.horizon) : undefined;
    if (metric) return res.json(CapacityForecastService.forecast(metric, { days, horizonDays }));
    return res.json(CapacityForecastService.forecastCapacity({ days, horizonDays }));
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F9 — correlação de causa provável: compõe as anomalias da F6 em hipóteses
// ranqueadas (sintoma→causa). Correlação, não veredito (§35). Sem anomalia → vazio.
router.get("/platform-root-cause", (req: AuthRequest, res): any => {
  try {
    const days = typeof req.query?.days === "string" ? Number(req.query.days) : undefined;
    return res.json(PlatformRootCauseService.analyze({ days }));
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F10 — recomendação ADVISÓRIA e explicável: junta headroom (F7) + forecast
// (F8) + causa provável (F9) em recomendações que o operador LÊ e decide. V1 NUNCA
// executa (D6/CA16) — toda rec é requiresHuman. Sem sinal → all_clear.
router.get("/capacity-recommendations", (req: AuthRequest, res): any => {
  try {
    const days = typeof req.query?.days === "string" ? Number(req.query.days) : undefined;
    const horizonDays = typeof req.query?.horizon === "string" ? Number(req.query.horizon) : undefined;
    return res.json(CapacityRecommendationService.recommend({ days, horizonDays }));
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F11 — Protection Mode: postura de confiabilidade derivada (NORMAL/CAUTIOUS/
// PROTECTED). SHADOW por padrão (§102) — só reporta; enforcement é opt-in humano. O
// Guard NUNCA sacrifica operação crítica (CA23).
router.get("/protection-mode", (_req: AuthRequest, res): any => {
  try {
    return res.json(PlatformProtectionModeService.assess());
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F11 — liga/desliga o ENFORCEMENT do Protection Mode (decisão humana explícita,
// §102). Body: { enforce: boolean }. Master-only (herda requireMasterAdmin).
router.post("/protection-mode/enforce", (req: AuthRequest, res): any => {
  try {
    const enforce = req.body?.enforce === true || req.body?.enforce === "true";
    PlatformProtectionModeService.setEnforcing(enforce);
    return res.json({ enforcing: PlatformProtectionModeService.isEnforcing() });
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F12 — Master Alerts: eventos de saúde de PLATAFORMA abertos (Admin Master).
// GLOBAL, separado de business_signals per-tenant (RN-PRC). Anti-spam por dedupe.
router.get("/platform-alerts", (req: AuthRequest, res): any => {
  try {
    const severity = typeof req.query?.severity === "string" ? req.query.severity as any : undefined;
    return res.json({ open: PlatformAlertService.listOpen({ severity }) });
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F12 — sincroniza alertas a partir das recomendações de capacidade correntes
// (F10): prioridade ALTA vira evento; recomendação que sumiu → auto-resolve (recuperou).
router.post("/platform-alerts/refresh", (_req: AuthRequest, res): any => {
  try {
    const recs = CapacityRecommendationService.recommend().recommendations;
    return res.json(PlatformAlertService.refresh({ recommendations: recs }));
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F13 — Capacity Envelope: limite seguro de operação derivado de teste de carga
// FORA de produção. Sem teste ainda → awaiting_load_test (§59, não inventa). GET lê o
// envelope corrente; POST persiste um envelope derivado (revisado por humano).
router.get("/capacity-envelope", (_req: AuthRequest, res): any => {
  try {
    return res.json(CapacityEnvelopeService.current());
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});
router.post("/capacity-envelope", (req: AuthRequest, res): any => {
  try {
    const samples = Array.isArray(req.body?.samples) ? req.body.samples : null;
    if (!samples) return res.status(400).json({ error: "Envie { samples: [{rps,p95Ms,errorRatePct}] } de um teste de carga." });
    const env = CapacityEnvelopeService.deriveEnvelope(samples, { sloP95Ms: Number(req.body?.sloP95Ms) || undefined, at: Date.now() });
    if (env.established) CapacityEnvelopeService.store(env);
    return res.json(env);
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});

// ADR-164 F2 (host/infra) — VPS Spec Profile: o Admin Master registra os fatos da infra
// (vCPU/RAM/storage/banda/SO, orquestração, limites de container, .db) uma vez; o headroom
// passa a usar limites REAIS. Sem perfil → honesto (configured:false). GLOBAL.
router.get("/vps-spec-profile", (_req: AuthRequest, res): any => {
  try {
    return res.json(VpsSpecProfileService.get());
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});
router.post("/vps-spec-profile", (req: AuthRequest, res): any => {
  try {
    return res.json(VpsSpecProfileService.set(req.body || {}));
  } catch (error: any) { return res.status(400).json({ error: error.message }); }
});

// ADR-164 F3.4 — SLO por jornada crítica: o Admin Master define o orçamento de latência
// p95 + teto de erro (global e por rota). Com o SLO, a Operational Health classifica a
// latência (antes só reportada). Sem SLO → honesto. GLOBAL.
router.get("/slo", (_req: AuthRequest, res): any => {
  try {
    return res.json(SloDefinitionService.get());
  } catch (error: any) { return res.status(500).json({ error: error.message }); }
});
router.post("/slo", (req: AuthRequest, res): any => {
  try {
    return res.json(SloDefinitionService.set(req.body || {}));
  } catch (error: any) { return res.status(400).json({ error: error.message }); }
});

// Master Admin - SaaS overview (métricas agregadas de todas as empresas)
router.get("/overview", (req: AuthRequest, res) => {
  try {
    const orgs = db.prepare(`SELECT status, billing_status FROM organization_settings WHERE deleted_at IS NULL`).all() as any[];
    const totalOrgs = orgs.length;
    const activeOrgs = orgs.filter(o => (o.status || 'active') === 'active').length;
    const blockedOrgs = orgs.filter(o => o.status === 'blocked').length;
    const pastDueOrgs = orgs.filter(o => ['past_due', 'suspended'].includes(o.billing_status)).length;

    const safeCount = (sql: string): number => {
      try { return (db.prepare(sql).get() as any)?.c || 0; } catch (e) { return 0; }
    };
    const safeSum = (sql: string): number => {
      try { return (db.prepare(sql).get() as any)?.s || 0; } catch (e) { return 0; }
    };

    res.json({
      totalOrgs,
      activeOrgs,
      blockedOrgs,
      pastDueOrgs,
      totalUsers: safeCount(`SELECT COUNT(*) as c FROM users`),
      totalContacts: safeCount(`SELECT COUNT(*) as c FROM contacts`),
      aiTotal: safeCount(`SELECT COUNT(*) as c FROM ai_interactions_log`),
      aiLast30d: safeCount(`SELECT COUNT(*) as c FROM ai_interactions_log WHERE created_at >= datetime('now','-30 days')`),
      aiLast24h: safeCount(`SELECT COUNT(*) as c FROM ai_interactions_log WHERE created_at >= datetime('now','-1 day')`),
      totalRevenue: safeSum(`SELECT COALESCE(SUM(total_amount),0) as s FROM orders WHERE status IN ('pago','em_preparo','entregue','concluido')`),
      // Custo de IA (R$) — consumo de tokens das empresas.
      aiCost30d: safeSum(`SELECT COALESCE(SUM(cost_brl),0) as s FROM ai_usage_log WHERE created_at >= datetime('now','-30 days')`),
      aiCostTotal: safeSum(`SELECT COALESCE(SUM(cost_brl),0) as s FROM ai_usage_log`),
      aiTokens30d: safeCount(`SELECT COALESCE(SUM(total_tokens),0) as c FROM ai_usage_log WHERE created_at >= datetime('now','-30 days')`),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - List all organizations (com métricas por empresa)
router.get("/organizations", (req: AuthRequest, res) => {
  try {
    const orgs = db.prepare(`
      SELECT os.*,
        (SELECT COUNT(*) FROM users u WHERE u.organization_id = os.organization_id) AS user_count,
        (SELECT COUNT(*) FROM contacts c WHERE c.organization_id = os.organization_id) AS contact_count,
        (SELECT COUNT(*) FROM ai_interactions_log a WHERE a.organization_id = os.organization_id) AS ai_total,
        (SELECT COUNT(*) FROM ai_interactions_log a WHERE a.organization_id = os.organization_id AND a.created_at >= datetime('now','-30 days')) AS ai_30d,
        (SELECT COALESCE(SUM(u.cost_brl),0) FROM ai_usage_log u WHERE u.organization_id = os.organization_id AND u.created_at >= datetime('now','-30 days')) AS ai_cost_30d,
        (SELECT COALESCE(SUM(u.total_tokens),0) FROM ai_usage_log u WHERE u.organization_id = os.organization_id AND u.created_at >= datetime('now','-30 days')) AS ai_tokens_30d,
        (SELECT COALESCE(SUM(o.total_amount),0) FROM orders o WHERE o.organization_id = os.organization_id AND o.status IN ('pago','em_preparo','entregue','concluido')) AS revenue,
        (SELECT MAX(m.created_at) FROM messages m WHERE m.organization_id = os.organization_id) AS last_activity
      FROM organization_settings os
      WHERE os.deleted_at IS NULL
      ORDER BY ai_30d DESC, os.created_at DESC
    `).all();
    res.json(orgs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Update organization status (block, unblock, etc)
router.post("/organizations/:id/status", (req: AuthRequest, res) => {
  const adminId = req.user?.userId;
  const { status } = req.body;
  const orgId = req.params.id;
  
  try {
    db.prepare('UPDATE organization_settings SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?').run(status, orgId);
    
    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_CHANGE_STATUS', { status });
      
    res.json({ success: true, status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Update organization billing status
router.post("/organizations/:id/billing-status", (req: AuthRequest, res) => {
  const adminId = req.user?.userId;
  const { billing_status } = req.body;
  const orgId = req.params.id;
  
  try {
    // Passa pela porta auditável de billing (ADR-091): valida o estado e — ao
    // voltar para active/trialing — ZERA a régua de inadimplência
    // (billing_dunning_stage). O UPDATE cru anterior deixava o dunning preso, o
    // que podia recolocar a conta em somente-leitura logo após "reativar".
    const ok = PlanService.setBillingStatus(orgId, billing_status, { reason: 'admin_panel' });
    if (!ok) return res.status(400).json({ error: "Estado de cobrança inválido ou organização não encontrada." });

    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_CHANGE_BILLING_STATUS', { billing_status });

    res.json({ success: true, billing_status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Liga/desliga o FalaTu de uma organização (rollout opt-in da
// Fatia 2, ADR-151). O gate real é o falatuGate da rota /api/falatu; aqui é só
// a porta de administração da flag.
router.post("/organizations/:id/falatu", async (req: AuthRequest, res): Promise<any> => {
  const enabled = !!req.body?.enabled;
  const orgId = req.params.id;
  try {
    const { FalaTuService } = await import("../FalaTuService.js");
    FalaTuService.setOrgEnabled(orgId, enabled);
    logAuthEvent(req.organizationId, req.user?.userId, orgId, 'ADMIN_FALATU_TOGGLE', { enabled });
    res.json({ success: true, enabled });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Atribui/troca o plano de uma organização (libera o teto de
// módulos do plano). Preenche o gap de "liberar a conta": até aqui o admin
// mudava status/billing, mas não conseguia dar um plano a uma org existente.
router.post("/organizations/:id/plan", (req: AuthRequest, res): any => {
  const adminId = req.user?.userId;
  const { planId } = req.body || {};
  const orgId = req.params.id;
  if (!planId) return res.status(400).json({ error: "Informe o planId." });
  try {
    const r = PlanService.setPlan(orgId, planId);
    if (!r.ok) return res.status(400).json({ error: r.reason || "Falha ao atribuir plano." });
    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_CHANGE_PLAN', { planId });
    res.json({ success: true, plan_id: planId });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ADR-169 F19 — Master Admin altera a `vertical` de uma organização. Preenche o
// gap operacional descoberto na F19: até aqui o Admin só conseguia atribuir
// blueprint (que carrega módulos/plano/quickstart) mas não conseguia editar o
// campo `organization_settings.vertical` — que é o gate real da BeautyView
// (Sidebar mostra "Beauty AI" quando vertical==='beleza') e do
// `assertBeautyOn(orgId)` (routes/beauty.ts). A ordem correta é:
//   1) atribuir vertical (esta rota) — carimba a etiqueta de negócio
//   2) atribuir blueprint (POST /:id/blueprint) — habilita módulos/plano
// Aceita só `key` do registry `VERTICALS` (verticals.ts), evita string livre
// que travaria os gates. Body: `{ vertical: VerticalKey | null }`.
router.patch("/organizations/:id/vertical", (req: AuthRequest, res): any => {
  const adminId = req.user?.userId;
  const orgId = String(req.params.id);
  const v = req.body?.vertical;
  if (v !== null && (typeof v !== "string" || !VERTICALS.some(x => x.key === v))) {
    return res.status(400).json({ error: `Vertical inválida. Use uma de: ${VERTICALS.map(x => x.key).join(", ")} ou null.` });
  }
  try {
    const info = db.prepare(
      `UPDATE organization_settings SET vertical = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND deleted_at IS NULL`
    ).run(v, orgId);
    if (info.changes === 0) return res.status(404).json({ error: "Organização não encontrada." });
    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_CHANGE_VERTICAL', { vertical: v });
    res.json({ success: true, vertical: v });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Soft delete organization
router.delete("/organizations/:id", (req: AuthRequest, res) => {
  const adminId = req.user?.userId;
  const orgId = req.params.id;
  
  try {
    db.prepare('UPDATE organization_settings SET deleted_at = CURRENT_TIMESTAMP, status = ? WHERE organization_id = ?').run('cancelled', orgId);
    
    logAuthEvent(req.organizationId, adminId, orgId, 'ADMIN_SOFT_DELETE', {});
      
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Convites de NOVA EMPRESA (Cortesia) — o super admin cria uma conta gratuita
// com plano + módulos definidos e envia o link de ativação pelo WhatsApp.
// ============================================================================

// POST /api/admin/org-invites — gera o convite e (opcional) envia pelo WhatsApp.
router.post("/org-invites", async (req: AuthRequest, res): Promise<any> => {
  const adminId = req.user?.userId;
  try {
    const { businessName, recipientName, recipientPhone, planId, modules, vertical, billingStatus, sendWhatsapp } = req.body || {};
    const phone = String(recipientPhone || "").replace(/\D/g, "");
    const token = uuidv4() + uuidv4();
    const id = uuidv4();
    const modulesJson = Array.isArray(modules) ? JSON.stringify(modules) : null;

    db.prepare(`
      INSERT INTO org_invitations (id, token, business_name, recipient_name, recipient_phone, plan_id, enabled_modules, vertical, billing_status, status, created_by, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, datetime('now', '+30 days'))
    `).run(id, token, businessName || null, recipientName || null, phone || null,
           planId || 'cortesia', modulesJson, vertical || null, billingStatus || 'active', adminId || null);

    const base = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, "");
    const link = `${base}/?orgInvite=${token}`;

    // Entrega pelo WhatsApp usando um canal conectado da org do super admin.
    let whatsappSent = false;
    let whatsappError: string | null = null;
    if (sendWhatsapp && phone) {
      try {
        const ch = db.prepare(
          `SELECT id FROM channels WHERE organization_id = ? AND status != 'disabled' ORDER BY (provider LIKE 'evolution%') DESC, created_at ASC LIMIT 1`
        ).get(req.organizationId) as any;
        if (!ch) { whatsappError = "Nenhum canal conectado para enviar."; }
        else {
          const nome = (recipientName || "").trim().split(/\s+/)[0] || "";
          const msg = `Olá ${nome}! 🎉 Sua conta no ZapFlow.ai (${businessName || 'sua empresa'}) está liberada.\n\n` +
            `Crie seu acesso por aqui (válido por 30 dias):\n${link}\n\n` +
            `Qualquer dúvida, é só chamar. 🚀`;
          await MessageProviderService.sendMessage(ch.id, phone, msg);
          whatsappSent = true;
        }
      } catch (e: any) { whatsappError = e?.message || "Falha ao enviar pelo WhatsApp."; }
    }

    logAuthEvent(req.organizationId, adminId, id, 'ADMIN_ORG_INVITE_CREATED', { businessName, planId: planId || 'cortesia', whatsappSent });
    res.json({ success: true, id, token, link, whatsappSent, whatsappError });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/admin/org-invites — lista os convites de nova empresa.
router.get("/org-invites", (req: AuthRequest, res) => {
  try {
    const invites = db.prepare(`
      SELECT oi.id, oi.business_name, oi.recipient_name, oi.recipient_phone, oi.plan_id, oi.enabled_modules,
             oi.status, oi.created_org_id, oi.accepted_at, oi.expires_at, oi.created_at,
             (SELECT business_name FROM organization_settings os WHERE os.organization_id = oi.created_org_id) AS created_org_name
      FROM org_invitations oi
      ORDER BY oi.created_at DESC LIMIT 50
    `).all();
    res.json(invites);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/admin/org-invites/:id — revoga um convite pendente.
router.delete("/org-invites/:id", (req: AuthRequest, res) => {
  try {
    db.prepare(`UPDATE org_invitations SET status = 'revoked' WHERE id = ? AND status = 'pending'`).run(req.params.id);
    logAuthEvent(req.organizationId, req.user?.userId, req.params.id, 'ADMIN_ORG_INVITE_REVOKED', {});
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// Planos & Limites — o super admin edita preço e limites de cada plano
// (respostas de IA, contatos, canais, usuários, trial e limites do Estúdio).
// ============================================================================

// GET /api/admin/plans — lista os planos com features (limites) já parseadas.
router.get("/plans", (req: AuthRequest, res) => {
  try {
    res.json(PlanService.listPlans());
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/plans/:id — atualiza nome/preço/limites de um plano.
router.put("/plans/:id", (req: AuthRequest, res): any => {
  try {
    const plan = db.prepare("SELECT features FROM plans WHERE id = ?").get(req.params.id) as any;
    if (!plan) return res.status(404).json({ error: "Plano não encontrado." });
    let cur: any = {};
    try { cur = plan.features ? JSON.parse(plan.features) : {}; } catch { cur = {}; }

    const { name, price, features } = req.body || {};
    const NUM_KEYS = ["ai_monthly_limit", "contacts_limit", "channels_limit", "users_limit", "trial_days", "studio_images_monthly", "studio_videos_monthly", "price_annual_month"];
    const next = { ...cur };
    if (features && typeof features === "object") {
      for (const k of NUM_KEYS) {
        if (features[k] !== undefined && features[k] !== null && features[k] !== "") {
          const n = parseInt(String(features[k]), 10);
          if (!isNaN(n)) next[k] = Math.max(0, n);
        }
      }
    }
    db.prepare("UPDATE plans SET name = COALESCE(?, name), price = COALESCE(?, price), features = ? WHERE id = ?")
      .run(name != null && String(name).trim() ? String(name).trim() : null,
           price != null && price !== "" && !isNaN(Number(price)) ? Number(price) : null,
           JSON.stringify(next), req.params.id);
    logAuthEvent(req.organizationId, req.user?.userId, req.params.id, 'ADMIN_PLAN_UPDATED', { name, price });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Admin - Audit Logs
router.get("/audit-logs", (req: AuthRequest, res) => {
  try {
    const logs = db.prepare('SELECT * FROM auth_audit_logs ORDER BY created_at DESC LIMIT 50').all();
    res.json(logs);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Create global notification
router.post("/notifications/global", (req: AuthRequest, res) => {
  const { title, message, type } = req.body;
  const adminId = req.user?.userId;
  try {
    db.prepare('INSERT INTO notifications (id, organization_id, title, message, type) VALUES (?, ?, ?, ?, ?)')
      .run(uuidv4(), 'global', title, message, type || 'info');
      
    logAuthEvent(req.organizationId, adminId, 'global', 'CREATE_GLOBAL_NOTIFICATION', { title });
      
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// Master Admin - Security Check
router.get("/security-check", async (req: AuthRequest, res) => {
  try {
    const issues = await SecurityAuditService.runSecurityCheck();
    res.json(issues);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---- Job Queue monitoring (ADR-029) ----

router.get("/queue/health", (_req: AuthRequest, res) => {
  try { res.json(JobQueueService.health()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Saúde CROSS-TENANT da Continuity Layer (ADR-082) — para o rollout observável
// das flags em produção (ver docs/RUNBOOK-CONTINUITY-ROLLOUT.md). Master-admin.
router.get("/continuity/health", (_req: AuthRequest, res): any => {
  try {
    const delivRows = db.prepare(`SELECT status, COUNT(*) AS c FROM message_deliveries GROUP BY status`).all() as any[];
    const deliv: Record<string, number> = { queued: 0, sent: 0, delivered: 0, failed: 0 };
    for (const r of delivRows) deliv[r.status] = r.c;
    const oldest = db.prepare(`SELECT MIN(next_attempt_at) AS t FROM message_deliveries WHERE status = 'queued'`).get() as any;
    const stuck = db.prepare(`SELECT COUNT(*) AS c FROM message_deliveries WHERE status = 'queued' AND attempt_count >= 3`).get() as any;
    const last24 = (st: string) => (db.prepare(`SELECT COUNT(*) AS c FROM message_deliveries WHERE status = ? AND updated_at >= datetime('now','-1 day')`).get(st) as any).c;
    const ev = db.prepare(`SELECT COUNT(*) AS total, COUNT(DISTINCT organization_id) AS orgs FROM domain_events`).get() as any;
    const edge = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active, MAX(last_seen_at) AS lastSeen FROM edge_devices`).get() as any;
    // Canais QUEBRADOS detectados (o "stuckQueued" atribuído ao canal), com nome.
    const degraded = MessageDeliveryService.degradedChannels().map((c) => {
      const ch = db.prepare(`SELECT name, provider FROM channels WHERE id = ?`).get(c.channelId) as any;
      return { ...c, channelName: ch?.name || null, provider: ch?.provider || null };
    });

    res.json({
      flags: { events: eventsEnabled(), deliveryQueue: MessageDeliveryService.enabled(), edgeSync: EdgeSyncService.enabled() },
      delivery: {
        queued: deliv.queued, sent: deliv.sent, delivered: deliv.delivered, failed: deliv.failed,
        oldestQueuedAt: oldest?.t || null,
        stuckQueued: stuck?.c || 0,                 // fila 'queued' com 3+ tentativas — sinal de canal quebrado
        deliveredLast24h: last24("delivered"), failedLast24h: last24("failed"),
      },
      degradedChannels: degraded,                    // canais com entregas presas (reagir: reconectar)
      events: { total: Number(ev?.total || 0), orgs: Number(ev?.orgs || 0) },
      edge: { devices: Number(edge?.total || 0), active: Number(edge?.active || 0), lastSeenAt: edge?.lastSeen || null },
    });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.get("/queue/jobs", (req: AuthRequest, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit || 50), 10) || 50));
  try { res.json(JobQueueService.listRecent(limit)); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/queue/jobs/:id/retry", (req: AuthRequest, res): any => {
  try {
    const ok = JobQueueService.retry(req.params.id);
    if (!ok) return res.status(404).json({ error: "Job not found or not in failed state." });
    res.json({ success: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/queue/cleanup", (req: AuthRequest, res) => {
  const days = Math.max(1, parseInt(String(req.body?.olderThanDays || 7), 10) || 7);
  try {
    const deleted = JobQueueService.cleanupCompleted(days);
    res.json({ deleted });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ============================================================================
// Master Admin — Gerenciador de USUÁRIOS (ADR-090)
// ----------------------------------------------------------------------------
// Rotas para o master admin listar/resetar/remover usuários de qualquer org.
// Caso de uso primário: cliente esquece senha com email fictício (não recebe
// recovery), plataforma trava. Sem o gerenciador, resolver exige SSH na VPS.
//
// Todas as rotas assumem `requireMasterAdmin` já aplicado no mount do router.
// ============================================================================

// GET /api/admin/users — lista usuários paginada com busca por email/nome
// e nome da org junto.
router.get("/users", (req: AuthRequest, res) => {
  try {
    const q = String(req.query.q || "").trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || 50), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset || 0), 10) || 0);
    const where: string[] = ["1 = 1"];
    const args: any[] = [];
    if (q) {
      where.push("(lower(u.email) LIKE ? OR lower(u.name) LIKE ? OR lower(os.business_name) LIKE ?)");
      args.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    const rows = db.prepare(`
      SELECT u.id, u.email, u.name, u.phone, u.role, u.global_status,
             u.organization_id, u.created_at, u.last_login_at,
             os.business_name AS org_name, os.status AS org_status
      FROM users u
      LEFT JOIN organization_settings os ON os.organization_id = u.organization_id
      WHERE ${where.join(" AND ")}
      ORDER BY u.created_at DESC
      LIMIT ? OFFSET ?
    `).all(...args, limit, offset) as any[];
    const total = (db.prepare(`
      SELECT COUNT(*) AS c FROM users u
      LEFT JOIN organization_settings os ON os.organization_id = u.organization_id
      WHERE ${where.join(" AND ")}
    `).get(...args) as any).c;
    res.json({ users: rows, total, limit, offset });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/users/:id/reset-password — troca a senha por bcrypt hash.
// Body: { password: "nova-senha" }. Mínimo 8 chars.
router.post("/users/:id/reset-password", async (req: AuthRequest, res): Promise<any> => {
  try {
    const id = String(req.params.id || "");
    const password = String(req.body?.password || "");
    if (password.length < 8) return res.status(400).json({ error: "senha_muito_curta" });
    const user = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(id) as any;
    if (!user) return res.status(404).json({ error: "user_not_found" });
    // Trava óbvia: master admin não pode resetar a própria senha por aqui
    // (evita bug de auto-lockout se ele digitar errado; usa /reset-password normal).
    if (user.email === MASTER_ADMIN_EMAIL) {
      return res.status(400).json({ error: "cannot_reset_master_admin_here" });
    }
    const hash = await bcrypt.hash(password, 10);
    db.prepare(`UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(hash, id);
    try {
      logAuthEvent(null, req.user?.userId || null, id, "ADMIN_PASSWORD_RESET", {
        by_master: req.user?.email, target_email: user.email,
      });
    } catch { /* noop */ }
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/admin/users/:id — soft delete (global_status = 'deleted').
// O usuário não pode fazer login mais, mas os registros históricos ficam
// preservados por integridade referencial e LGPD (forget é fluxo separado).
router.delete("/users/:id", (req: AuthRequest, res): any => {
  try {
    const id = String(req.params.id || "");
    const user = db.prepare(`SELECT id, email FROM users WHERE id = ?`).get(id) as any;
    if (!user) return res.status(404).json({ error: "user_not_found" });
    if (user.email === MASTER_ADMIN_EMAIL) {
      return res.status(400).json({ error: "cannot_delete_master_admin" });
    }
    const r = db.prepare(`UPDATE users SET global_status = 'deleted', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
    try {
      logAuthEvent(null, req.user?.userId || null, id, "ADMIN_USER_SOFT_DELETED", {
        by_master: req.user?.email, target_email: user.email,
      });
    } catch { /* noop */ }
    res.json({ ok: true, changes: r.changes });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// ADR-153 F3.1 — Vertical Blueprints (Master Admin).
// Rotas gateadas pelo `requireMasterAdmin` já aplicado no mount de /api/admin.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/admin/blueprints — lista blueprints (?status=draft|published|deprecated&key=...&baseVertical=...)
router.get("/blueprints", (req: AuthRequest, res): any => {
  try {
    const filter: any = {};
    if (typeof req.query.status === "string") filter.status = req.query.status;
    if (typeof req.query.key === "string") filter.key = req.query.key;
    if (typeof req.query.baseVertical === "string") filter.baseVertical = req.query.baseVertical;
    res.json({ blueprints: VerticalBlueprintService.listBlueprints(filter) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/blueprints/:id — busca blueprint por id.
router.get("/blueprints/:id", (req: AuthRequest, res): any => {
  const bp = VerticalBlueprintService.getBlueprint(String(req.params.id));
  if (!bp) return res.status(404).json({ error: "Blueprint não encontrado" });
  res.json(bp);
});

// POST /api/admin/blueprints — cria blueprint em status draft.
router.post("/blueprints", (req: AuthRequest, res): any => {
  const b = req.body || {};
  if (!b.key || !b.name || !b.baseVertical || !b.config) {
    return res.status(400).json({ error: "key, name, baseVertical, config são obrigatórios" });
  }
  try {
    const bp = VerticalBlueprintService.createBlueprint(
      { key: b.key, name: b.name, baseVertical: b.baseVertical, version: b.version, minimumPlanId: b.minimumPlanId, defaultPlanId: b.defaultPlanId, defaultBundleKey: b.defaultBundleKey, config: b.config },
      req.user?.userId,
    );
    res.status(201).json(bp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/blueprints/:id/publish — publica (draft → published, imutável).
router.post("/blueprints/:id/publish", (req: AuthRequest, res): any => {
  try {
    const bp = VerticalBlueprintService.publishVersion(String(req.params.id), req.user?.userId);
    res.json(bp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/blueprints/:id/deprecate — marca como deprecated.
router.post("/blueprints/:id/deprecate", (req: AuthRequest, res): any => {
  try {
    const bp = VerticalBlueprintService.deprecateBlueprint(String(req.params.id), req.user?.userId);
    res.json(bp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /api/admin/organizations/:id/blueprint — atribui blueprint publicado à org.
// Body: { blueprintId: string, overrides?: object }.
router.post("/organizations/:id/blueprint", (req: AuthRequest, res): any => {
  const orgId = String(req.params.id);
  const b = req.body || {};
  if (!b.blueprintId) return res.status(400).json({ error: "blueprintId é obrigatório" });
  try {
    const assignment = VerticalBlueprintService.assignToOrganization(orgId, b.blueprintId, req.user?.userId, b.overrides);
    res.json(assignment);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// GET /api/admin/organizations/:id/blueprint — devolve o blueprint atual da org (+ overrides).
router.get("/organizations/:id/blueprint", (req: AuthRequest, res): any => {
  const orgId = String(req.params.id);
  const assignment = VerticalBlueprintService.getForOrganization(orgId);
  if (!assignment) return res.json({ assignment: null });
  const bp = VerticalBlueprintService.getBlueprint(assignment.blueprintId);
  res.json({ assignment, blueprint: bp });
});

// POST /api/admin/blueprints/seed — força re-seed idempotente dos 5 blueprints
// iniciais. Normalmente chamado uma vez no primeiro deploy; disponível como
// rota pra Master Admin poder rodar novamente em caso de precisar corrigir
// blueprints que ficaram no meio do caminho.
router.post("/blueprints/seed", (req: AuthRequest, res): any => {
  try {
    const result = BlueprintSeeder.seedInitialBlueprints(req.user?.userId);
    res.json(result);
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/admin/blueprints/migrate-orgs?dryRun=true|false — migra orgs vivas
// pra blueprints inferidos por (vertical, plan_id). ADR-153 F3.2. `dryRun` só
// reporta o que faria (Master Admin revisa antes de aplicar).
router.post("/blueprints/migrate-orgs", (req: AuthRequest, res): any => {
  try {
    const dryRun = String(req.query.dryRun ?? "true").toLowerCase() === "true";
    const result = BlueprintSeeder.migrateExistingOrgs({ dryRun, actor: req.user?.userId });
    res.json({ dryRun, ...result });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/organizations/:id/blueprint/preview?blueprintId=... — preview do diff pra F3.3.
router.get("/organizations/:id/blueprint/preview", (req: AuthRequest, res): any => {
  const orgId = String(req.params.id);
  const blueprintId = String(req.query.blueprintId || "");
  if (!blueprintId) return res.status(400).json({ error: "blueprintId query param é obrigatório" });
  try {
    res.json(VerticalBlueprintService.previewEntitlements(orgId, blueprintId));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ADR-153 F3.3 — cria a próxima versão de um blueprint existente clonando
// a config e aplicando edits. Auto-incrementa `version`.
// Body: { edits: { name?, minimumPlanId?, defaultPlanId?, defaultBundleKey?,
//                   config?: { requiredModules?, optionalModules?, hiddenModules?,
//                              commercialUpgrades?, quickStartPack?, runtimePlaybooks? }}}
router.post("/blueprints/:id/next-version", (req: AuthRequest, res): any => {
  const sourceId = String(req.params.id || "");
  const edits = (req.body && req.body.edits) || {};
  try {
    const bp = VerticalBlueprintService.createNextVersion(sourceId, edits, req.user?.userId);
    res.status(201).json(bp);
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ADR-153 F3.3 — diff entre dois blueprints sem depender de org atribuída.
// Usado pelo Master Admin ANTES de publicar uma nova versão pra revisar
// o que mudou vs a versão anterior.
router.get("/blueprints/:id/diff", (req: AuthRequest, res): any => {
  const sourceId = String(req.params.id);
  const targetId = String(req.query.targetId || "");
  if (!targetId) return res.status(400).json({ error: "targetId query param é obrigatório" });
  try {
    res.json(VerticalBlueprintService.previewBlueprintDiff(sourceId, targetId));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────────────────────
// ADR-153 F7.6 — Ledger de recomendações de upgrade (Master Admin).
//
// Cross-tenant: Master Admin vê o funil consolidado (aceitas aguardando
// checkout, pendentes, dispensadas) de TODAS as orgs pra processar upgrade
// MANUAL até a Fase 5 automatizar via Asaas. Já gateado pelo mount de
// /api/admin com `requireMasterAdmin`.
// ─────────────────────────────────────────────────────────────────────────

// GET /api/admin/upgrade-recommendations
// ?status=accepted|pending|dismissed|expired
// &targetPlanId=growth&targetModuleKey=clinica&organizationId=org_xxx&limit=200
router.get("/upgrade-recommendations", (req: AuthRequest, res): any => {
  try {
    const opts: any = {};
    if (typeof req.query.status === "string") opts.status = req.query.status;
    if (typeof req.query.targetPlanId === "string") opts.targetPlanId = req.query.targetPlanId;
    if (typeof req.query.targetModuleKey === "string") opts.targetModuleKey = req.query.targetModuleKey;
    if (typeof req.query.organizationId === "string") opts.organizationId = req.query.organizationId;
    if (req.query.limit) opts.limit = Number(req.query.limit);
    res.json({ items: UpgradeRecommendationService.listAcrossOrgs(opts) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/upgrade-recommendations/summary — agregados pro dashboard.
router.get("/upgrade-recommendations/summary", (_req: AuthRequest, res): any => {
  try {
    res.json(UpgradeRecommendationService.summaryAcrossOrgs());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ADR-155 F5.3 — medição de retenção das save offers (retidos vs reembolsados),
// CROSS-ORG (só o dono da plataforma). Derivado por query sobre o outcome das
// intenções (RN-004). `byOffer` diz qual degrau do ladder retém melhor. Gateado
// pelo `requireMasterAdmin` do mount de /api/admin.
router.get("/falatu/save-offer-retention", (_req: AuthRequest, res): any => {
  try {
    res.json(FalatuSaveOfferService.retentionSummary());
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ADR-154 F1.2 — Dashboard de consumo de IA por org (master admin).
// Ordem importa (Express match order): path específico ANTES do :param.

// GET /api/admin/ai-usage?days=N  — 1 linha por org com totais da janela.
router.get("/ai-usage", (req: AuthRequest, res): any => {
  try {
    const rows = AiUsageDashboardService.listOrgs(Number(req.query.days));
    res.json({ days: AiUsageDashboardService.clampDays(Number(req.query.days)), items: rows });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/admin/ai-usage/:orgId?days=N — drill-down (série + breakdowns).
router.get("/ai-usage/:orgId", (req: AuthRequest, res): any => {
  try {
    res.json(AiUsageDashboardService.byOrg(req.params.orgId, Number(req.query.days)));
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ADR-154 F1.3 — ajuste de cota mensal de custo (centavos) pela org.
// body: { monthlyLimitCents: number|null }  (null desativa o teto de custo).
// Também roda AiQuotaSignalService.run() pra dar feedback imediato — se a org
// já estourou o novo teto, o admin já sai vendo o sinal recém-publicado; se
// aumentou o teto além do consumo atual, o sinal antigo é resolved.
router.post("/organizations/:id/ai-quota", (req: AuthRequest, res): any => {
  const orgId = req.params.id;
  const raw = req.body?.monthlyLimitCents;
  let value: number | null;
  if (raw === null || raw === undefined || raw === "") {
    value = null;
  } else {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
      return res.status(400).json({ error: "monthlyLimitCents deve ser INTEGER ≥ 0 ou null" });
    }
    value = n;
  }
  try {
    const changes = db.prepare(
      `UPDATE organization_settings SET ai_monthly_limit_cents = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`
    ).run(value, orgId).changes;
    if (changes === 0) return res.status(404).json({ error: "Org não encontrada" });
    logAuthEvent(orgId, req.user?.userId, orgId, "ADMIN_AI_QUOTA_UPDATE", { newLimitCents: value });
    const outcome = AiQuotaSignalService.run(orgId);
    res.json({ ok: true, monthlyLimitCents: value, quota: outcome });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ─────────────────── Curadoria da base de ajuda (ADR-179 F2) ───────────────────
// Master-only (herda requireMasterAdmin). Ciclo draft → published → archived; só
// `published` com reviewed_by é recuperável pelo Tutor de Ajuda (RN-HELP-3).

// GET /api/admin/help-articles?status=all|draft|published|archived
router.get("/help-articles", (req: AuthRequest, res): any => {
  const s = String(req.query?.status || "all");
  const status = ["draft", "published", "archived", "all"].includes(s) ? s : "all";
  res.json({ articles: HelpKnowledgeService.adminList(status as any) });
});

// POST /api/admin/help-articles — cria rascunho ou atualiza (patch). Não publica.
router.post("/help-articles", (req: AuthRequest, res): any => {
  try { res.json(HelpKnowledgeService.upsert(req.body || {}, req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// POST /api/admin/help-articles/bootstrap — destila um RASCUNHO da doc do módulo.
router.post("/help-articles/bootstrap", async (req: AuthRequest, res): Promise<any> => {
  try {
    const b = req.body || {};
    if (!b.moduleKey) return res.status(400).json({ error: "moduleKey é obrigatório." });
    res.json(await HelpKnowledgeService.bootstrap(b, req.user?.userId));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// POST /api/admin/help-articles/:id/publish — publica com reviewedBy (RN-HELP-3).
router.post("/help-articles/:id/publish", (req: AuthRequest, res): any => {
  try { res.json(HelpKnowledgeService.publish(String(req.params.id), String(req.body?.reviewedBy || ""), req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// POST /api/admin/help-articles/:id/archive — arquiva (sai da recuperação).
router.post("/help-articles/:id/archive", (req: AuthRequest, res): any => {
  try { res.json(HelpKnowledgeService.archive(String(req.params.id), req.user?.userId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// GET /api/admin/help-gaps?limit= — fila GLOBAL de lacunas (cross-org) que puxa a
// curadoria (ADR-179 F4). Só a pergunta normalizada + total de hits + nº de orgs.
router.get("/help-gaps", (req: AuthRequest, res): any => {
  const limit = typeof req.query?.limit === "string" ? Number(req.query.limit) : undefined;
  res.json({ gaps: HelpKnowledgeService.globalGaps({ limit }) });
});

// GET /api/admin/help-metrics — métricas GLOBAIS (cross-org) da base de ajuda (F4).
router.get("/help-metrics", (_req: AuthRequest, res): any => {
  res.json(HelpKnowledgeService.globalMetrics());
});

export default router;
