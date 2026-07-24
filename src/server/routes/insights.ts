/**
 * Insights globais (ADR-136, Epic 2 — kernel de inteligência empresarial).
 *
 * Generaliza a tela de Insights do varejo para TODA a plataforma: o Pareto dos
 * sinais abertos de qualquer domínio (finanças, produção, compras, pessoas,
 * estoque, vendas, varejo…) num só lugar, com o botão "Agir" que propõe a AÇÃO
 * recomendada e um painel de "Ações em andamento" que fecha o ciclo (propor →
 * aprovar → concluir → medir). Só leitura + a proposição; o restante do ciclo de
 * vida da ação reusa /api/actions. Núcleo (não gated por módulo), isolado por org.
 */
import { Router } from "express";
import db from "../db.js";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { ImpactPrioritizationService } from "../ImpactPrioritizationService.js";
import { BusinessSignalService } from "../BusinessSignalService.js";
import { DecisionActionService } from "../DecisionActionService.js";
import { OutcomeMeasurementService } from "../OutcomeMeasurementService.js";
import { FinanceSignalPublisher } from "../FinanceSignalPublisher.js";
import { ProductionSignalPublisher } from "../ProductionSignalPublisher.js";
import { RetailOpsSignalPublisher } from "../RetailOpsSignalPublisher.js";

const router = Router();

// GET /api/insights — panorama consolidado: Pareto global (todos os domínios),
// contagem por severidade, distribuição por domínio e o resumo do Impact Ledger.
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const prioritized = ImpactPrioritizationService.prioritize(orgId, { globalLimit: 12, perDomain: 3 });
  const priorities = prioritized?.global || [];
  const open = BusinessSignalService.list(orgId, { status: "open" });
  const bySeverity: Record<string, number> = { critical: 0, risk: 0, attention: 0, info: 0 };
  const byDomain: Record<string, number> = {};
  for (const s of open) {
    bySeverity[s.severity] = (bySeverity[s.severity] || 0) + 1;
    byDomain[s.domain] = (byDomain[s.domain] || 0) + 1;
  }
  const ledger = OutcomeMeasurementService.ledger(orgId, { limit: 1 });
  res.json({ priorities, openCount: open.length, bySeverity, byDomain, ledgerTotals: ledger.totals });
});

// POST /api/insights/refresh — "Analisar agora" da plataforma: roda TODOS os
// publicadores de sinais (finanças, produção, varejo), cada um autoprotegido —
// só publica se houver dados do domínio. Idempotente, isolado por org. owner/admin.
router.post("/refresh", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const ran: Record<string, any> = {};
  try { ran.finance = FinanceSignalPublisher.run(orgId); } catch (e: any) { ran.finance = { error: e?.message || "falhou" }; }
  try { ran.production = ProductionSignalPublisher.run(orgId); } catch (e: any) { ran.production = { error: e?.message || "falhou" }; }
  try { ran.retail = RetailOpsSignalPublisher.run(orgId); } catch (e: any) { ran.retail = { error: e?.message || "falhou" }; }
  const published =
    (ran.finance?.count || 0) + (ran.production?.published || 0) + (ran.retail?.published || 0);
  res.json({ ok: true, published, ran, openCount: BusinessSignalService.list(orgId, { status: "open" }).length });
});

// POST /api/insights/act — age a partir de um insight de QUALQUER domínio: propõe
// a ação recomendada do sinal. A política de aprovação decide se já nasce
// aprovada ou aguardando (nada executa sozinho). owner/admin.
router.post("/act", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const signalId = String(req.body?.signalId || "");
  const sig = db.prepare("SELECT * FROM business_signals WHERE organization_id = ? AND id = ? AND status = 'open'").get(orgId, signalId) as any;
  if (!sig) return res.status(404).json({ error: "Sinal não encontrado ou já resolvido." });
  const action = ImpactPrioritizationService.actionFor(sig.signal_type);
  try {
    const proposed = DecisionActionService.propose(orgId, {
      signalId: sig.id, domain: sig.domain, actionType: action.actionType, title: action.label,
      description: `Ação a partir do sinal ${sig.signal_type} (${sig.domain}).`,
      expectedImpact: sig.impact_amount != null ? Number(sig.impact_amount) : null, impactUnit: sig.impact_unit || null,
      basis: sig.basis || "estimate", confidence: Number(sig.confidence) || 0.7, createdBy: req.user?.userId || "user",
    });
    res.status(201).json({ ok: true, action: proposed });
  } catch (e: any) {
    res.status(400).json({ ok: false, error: e?.message || "Falha ao criar a ação." });
  }
});

// GET /api/insights/actions — painel de ações ORIGINADAS DE SINAIS (qualquer
// domínio), do mais pendente ao concluído. Traz o domínio do sinal de origem.
router.get("/actions", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const actions = db.prepare(
    `SELECT a.id, a.title, a.domain, a.action_type, a.status, a.expected_impact, a.impact_unit, a.result_amount, a.created_at, a.approval_policy, a.approval_role, s.severity AS signal_severity
       FROM decision_actions a
       JOIN business_signals s ON s.id = a.signal_id
      WHERE a.organization_id = ?
      ORDER BY CASE a.status WHEN 'awaiting_approval' THEN 0 WHEN 'approved' THEN 1 WHEN 'done' THEN 2 ELSE 3 END, a.created_at DESC
      LIMIT 100`
  ).all(orgId) as any[];
  res.json({ actions });
});

export default router;
