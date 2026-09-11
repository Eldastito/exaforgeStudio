/**
 * FINANCIAL RECOVERY — API do Financial Recovery OS (PRD-ZF-UNIFIED-GAP-CLOSURE-03 F3, PR-5).
 * Montada em /api/financial-recovery. owner/admin (recuperação é decisão do dono).
 * GATE SERVER-SIDE pela flag `financial_recovery_enabled` (esconder botão não é segurança):
 * desligada → 404. A rota valida FORMA; o invariante vive nos services.
 * Dinheiro role-gated (§73): o assessment redige BRL para quem não pode ver dinheiro.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RecoveryAssessmentService } from "../RecoveryAssessmentService.js";
import { RecoveryDebtService } from "../RecoveryDebtService.js";
import { RecoveryViabilityService } from "../RecoveryViabilityService.js";
import { DebtPriorityService } from "../DebtPriorityService.js";
import { SurvivalBudgetService } from "../SurvivalBudgetService.js";
import { RecoveryScenarioService } from "../RecoveryScenarioService.js";
import { RecoveryPlanService } from "../RecoveryPlanService.js";
import { ProfessionalEscalationService } from "../ProfessionalEscalationService.js";
import { RecoveryDataRoomService } from "../RecoveryDataRoomService.js";
import { FalaTuAskService } from "../FalaTuAskService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;
function fail(res: any, e: any) { res.status(400).json({ error: e?.message || "erro" }); }

/** Gate: módulo precisa estar ligado pra org (opt-in). */
function requireRecovery(req: AuthRequest, res: any, next: any): any {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!RecoveryAssessmentService.isEnabled(orgId)) return res.status(404).json({ error: "Financial Recovery indisponível para esta organização." });
  next();
}

// ── HABILITAÇÃO — antes do gate (senão o dono nunca ligaria a flag). owner/admin. ──
router.get("/enablement", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try { res.json(RecoveryAssessmentService.settings(req.organizationId!)); } catch (e: any) { fail(res, e); }
});
router.put("/enablement", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try { res.json(RecoveryAssessmentService.setEnabled(req.organizationId!, req.body?.enabled === true || req.body?.enabled === 1)); }
  catch (e: any) { fail(res, e); }
});

router.use(requireRole("owner", "admin"), requireRecovery);

// GET /assessment — quadro consolidado (financeiro + Mapa da Dívida). Dinheiro role-gated.
router.get("/assessment", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  try {
    const includeMoney = FalaTuAskService.canSeeMoney(orgId, req.user);
    const period = typeof req.query?.period === "string" ? req.query.period : undefined;
    res.json(RecoveryAssessmentService.assess(orgId, { includeMoney, period }));
  } catch (e: any) { fail(res, e); }
});

// GET /viability — IRF (Índice de Recuperabilidade Financeira) + diagnóstico estrutural
// (crise operacional×financeira). Determinístico; não expõe R$ (score/%/labels/razões).
router.get("/viability", (req: AuthRequest, res): any => {
  try {
    const period = typeof req.query?.period === "string" ? req.query.period : undefined;
    res.json(RecoveryViabilityService.viability(req.organizationId!, { period }));
  } catch (e: any) { fail(res, e); }
});

// GET /debts/priority — matriz de priorização (4 eixos + composto explicável).
// NÃO é ordem jurídica de pagamento; risco jurídico exige validação profissional.
// Não expõe R$ (scores/bands/labels).
router.get("/debts/priority", (req: AuthRequest, res): any => {
  try { res.json(DebtPriorityService.prioritize(req.organizationId!)); } catch (e: any) { fail(res, e); }
});

// GET /survival-budget — sugestão A/B/C/D das contas a pagar. A IA sugere, humano confirma;
// nada é cancelado aqui. Dinheiro role-gated.
router.get("/survival-budget", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  try {
    const includeMoney = FalaTuAskService.canSeeMoney(orgId, req.user);
    res.json(SurvivalBudgetService.suggest(orgId, { includeMoney }));
  } catch (e: any) { fail(res, e); }
});

// GET /plan — Plano de Recuperação consolidado (compõe assessment/viability/priority/budget).
// Dinheiro role-gated.
router.get("/plan", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  try {
    const includeMoney = FalaTuAskService.canSeeMoney(orgId, req.user);
    const period = typeof req.query?.period === "string" ? req.query.period : undefined;
    res.json(RecoveryPlanService.plan(orgId, { includeMoney, period }));
  } catch (e: any) { fail(res, e); }
});

// GET /plan/mission-suggestion — RASCUNHO de missão de recuperação (sugere, nunca cria).
router.get("/plan/mission-suggestion", (req: AuthRequest, res): any => {
  try { res.json(RecoveryPlanService.suggestMission(req.organizationId!)); } catch (e: any) { fail(res, e); }
});

// GET /escalation — gatilhos de escalonamento profissional (F3.17). Sinaliza, nunca parecer.
router.get("/escalation", (req: AuthRequest, res): any => {
  try { res.json(ProfessionalEscalationService.assess(req.organizationId!)); } catch (e: any) { fail(res, e); }
});

// GET /data-room — pacote organizado pra contador/advogado/banco/credor (F3.19). Dinheiro role-gated.
router.get("/data-room", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  try {
    const includeMoney = FalaTuAskService.canSeeMoney(orgId, req.user);
    const period = typeof req.query?.period === "string" ? req.query.period : undefined;
    res.json(RecoveryDataRoomService.assemble(orgId, { includeMoney, period }));
  } catch (e: any) { fail(res, e); }
});

// ── Simulador / Negociação (F3.9/F3.10/F3.11) — determinístico, dinheiro role-gated ──
// POST /scenario/simulate — testa alavancas (cortar/renegociar/antecipar/aumentar); reporta
// baseline × factOnly × scenario (fato ≠ hipótese nunca somados).
router.post("/scenario/simulate", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  try {
    const includeMoney = FalaTuAskService.canSeeMoney(orgId, req.user);
    res.json(RecoveryScenarioService.simulate(orgId, { levers: req.body?.levers, minCash: Number(req.body?.minCash) || 0, includeMoney }));
  } catch (e: any) { fail(res, e); }
});

// POST /scenario/commitment — "quanto podemos prometer?": um acordo proposto é compatível
// com a projeção? Nunca "aceite".
router.post("/scenario/commitment", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  try {
    const includeMoney = FalaTuAskService.canSeeMoney(orgId, req.user);
    const b = req.body || {};
    res.json(RecoveryScenarioService.commitmentAffordability(orgId, { downPayment: Number(b.downPayment) || 0, monthlyAmount: Number(b.monthlyAmount) || 0, installments: Number(b.installments) || 0, minCash: Number(b.minCash) || 0, includeMoney }));
  } catch (e: any) { fail(res, e); }
});

// POST /scenario/negotiation — propõe parcela que cabe no caixa + rascunho de mensagem.
// O ZapFlow não aceita/assina/renegocia sozinho.
router.post("/scenario/negotiation", (req: AuthRequest, res): any => {
  const orgId = req.organizationId!;
  try {
    const includeMoney = FalaTuAskService.canSeeMoney(orgId, req.user);
    const b = req.body || {};
    res.json(RecoveryScenarioService.negotiationProposal(orgId, { debtTotal: Number(b.debtTotal) || 0, maxInstallments: Number(b.maxInstallments) || 12, minCash: Number(b.minCash) || 0, includeMoney }));
  } catch (e: any) { fail(res, e); }
});

// ── Mapa da Dívida (F3.3) ──
// GET /debts — lista (?status= ?category= ?includeCanceled=1).
router.get("/debts", (req: AuthRequest, res): any => {
  try {
    res.json({
      items: RecoveryDebtService.list(req.organizationId!, {
        status: req.query?.status as any,
        category: req.query?.category as any,
        includeCanceled: req.query?.includeCanceled === "1" || req.query?.includeCanceled === "true",
      }),
    });
  } catch (e: any) { fail(res, e); }
});

// GET /debts/summary — resumo agregado (só valores conhecidos; não prioriza — RN-FR-4).
router.get("/debts/summary", (req: AuthRequest, res): any => {
  try { res.json(RecoveryDebtService.summary(req.organizationId!)); } catch (e: any) { fail(res, e); }
});

// POST /debts — cadastra obrigação.
router.post("/debts", (req: AuthRequest, res): any => {
  try { res.status(201).json(RecoveryDebtService.create(req.organizationId!, req.body || {}, actor(req))); }
  catch (e: any) { fail(res, e); }
});

// PATCH /debts/:id — atualiza campos parciais / status.
router.patch("/debts/:id", (req: AuthRequest, res): any => {
  try { res.json(RecoveryDebtService.update(req.organizationId!, req.params.id, req.body || {}, actor(req))); }
  catch (e: any) { fail(res, e); }
});

// DELETE /debts/:id — cancela (retenção: UPDATE status, nunca DELETE — RN-FR-9).
router.delete("/debts/:id", (req: AuthRequest, res): any => {
  try { res.json(RecoveryDebtService.cancel(req.organizationId!, req.params.id, actor(req))); }
  catch (e: any) { fail(res, e); }
});

export default router;
