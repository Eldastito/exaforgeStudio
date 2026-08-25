import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { ExecutiveAdvisorService } from "../ExecutiveAdvisorService.js";
import { ExecutiveVisionService } from "../ExecutiveVisionService.js";
import { ExecutiveBusinessSnapshotService } from "../ExecutiveBusinessSnapshotService.js";
import { ExecutiveConstraintService } from "../ExecutiveConstraintService.js";
import { ExecutiveMissionBridgeService } from "../ExecutiveMissionBridgeService.js";
import { ExecutiveFinanceService } from "../ExecutiveFinanceService.js";
import { KeyPersonDependencyService } from "../KeyPersonDependencyService.js";
import { ExecutiveProactiveService } from "../ExecutiveProactiveService.js";

const router = Router();

// GET /api/executive/briefing — briefing do dia (dados reais).
router.get("/briefing", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ text: await ExecutiveAdvisorService.briefing(orgId) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/executive/effectiveness — "o que costuma funcionar": eficácia aprendida
// por tipo de ação (todos os domínios), ranqueada. Só leitura, determinística.
router.get("/effectiveness", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ items: ExecutiveAdvisorService.learnedEffectiveness(orgId) });
});

// POST /api/executive/ask — pergunta livre do gestor ao Diretor IA.
router.post("/ask", async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ text: await ExecutiveAdvisorService.ask(orgId, req.body?.question) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── CEO Operating Layer (ADR-190 F3) — VISÃO estratégica (owner/admin; §50 role gating) ──
// A visão é intenção HUMANA: a IA nunca a inventa — só grava o que o dono escreveu.
const visionActor = (req: any) => req.user?.userId || req.user?.id;

// GET /api/executive/vision — lê a visão (sem dado → campos null + defined:false).
router.get("/vision", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExecutiveVisionService.get(orgId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// PUT /api/executive/vision — grava (patch parcial: statement/horizon/strategicPriority).
router.put("/vision", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const b = req.body || {};
    res.json(ExecutiveVisionService.save(orgId, { statement: b.statement, horizon: b.horizon, strategicPriority: b.strategicPriority }, visionActor(req)));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── CEO Operating Layer (ADR-190 F4) — Executive Business Snapshot ──
// "Como está minha empresa?" (§4): 3 pilares + indicadores + metas + exceções +
// prioridades + missões + visão. Read-only, composição pura. Owner/admin (§73 —
// carrega valores em R$; a rota gateia o dinheiro).
router.get("/snapshot", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const period = typeof req.query.period === "string" ? req.query.period : undefined;
    res.json(ExecutiveBusinessSnapshotService.read(orgId, { period }));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── CEO Operating Layer (ADR-190 F5) — pilar em pior forma + restrição nº1 ──
// Company-level "onde focar" sobre o snapshot (F4). Owner/admin (§73 — impacto R$).
router.get("/constraint", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExecutiveConstraintService.assess(orgId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── CEO Operating Layer (ADR-190 F6) — Mission Bridge ──
// Sugere (NUNCA cria — RN-CEO-06) missões pros desvios que ameaçam metas. Owner/admin.
router.get("/mission-suggestions", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExecutiveMissionBridgeService.suggest(orgId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── CEO Operating Layer (ADR-190 F7) — financeiro executivo ──
// Liquidez + recebíveis + rentabilidade + retiradas (projeção do FinanceSnapshotAdapter).
// Owner/admin (§73 — dinheiro).
router.get("/finance", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    const period = typeof req.query.period === "string" ? req.query.period : undefined;
    res.json(ExecutiveFinanceService.read(orgId, { period }));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── CEO Operating Layer (ADR-190 §38) — risco de concentração (key-person) ──
// Read-only; o alerta HIGH já flui pra espinha via detect/Scheduler. Owner/admin (§73).
router.get("/key-person", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(KeyPersonDependencyService.assess(orgId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// ── CEO Operating Layer (ADR-190) — briefing proativo (preview do digest da semana) ──
// Read-only; o push real flui pela espinha/FalaTuProactiveService. Owner/admin.
router.get("/proactive-briefing", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try { res.json(ExecutiveProactiveService.briefing(orgId)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

export default router;
