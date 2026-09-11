/**
 * Rotas do IDO — Índice de Dependência Operacional (PRD 04 / "Evolução de Marca").
 * Diagnóstico POR-ORG (o dono avalia a própria operação). Gestão: owner/admin.
 * Isolado por org (usa req.organizationId). Não expõe dado de outro tenant.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { OperationalDependencyService } from "../OperationalDependencyService.js";

const router = Router();

// Questionário (versionado) para montar a UI. Leitura autenticada.
router.get("/questionnaire", (_req: AuthRequest, res): any => {
  return res.json(OperationalDependencyService.questionnaire());
});

// Visão consolidada: último placar + comparação (antes→hoje→meta) + histórico.
router.get("/", (req: AuthRequest, res): any => {
  try { return res.json(OperationalDependencyService.overview(req.organizationId!)); }
  catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get("/latest", (req: AuthRequest, res): any => {
  try { return res.json(OperationalDependencyService.latest(req.organizationId!)); }
  catch (e: any) { return res.status(500).json({ error: e.message }); }
});

router.get("/history", (req: AuthRequest, res): any => {
  try { return res.json({ history: OperationalDependencyService.history(req.organizationId!, Number(req.query.limit) || 12) }); }
  catch (e: any) { return res.status(500).json({ error: e.message }); }
});

// Submete respostas → calcula + registra o snapshot. Gestão (owner/admin).
router.post("/assess", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try {
    const answers = (req.body && typeof req.body.answers === "object") ? req.body.answers : {};
    const actor = req.user?.email || req.user?.userId;
    return res.json(OperationalDependencyService.submit(req.organizationId!, answers, actor));
  } catch (e: any) { return res.status(400).json({ error: e.message }); }
});

// Meta de IDO (opt-in). null limpa a meta.
router.get("/target", (req: AuthRequest, res): any => {
  return res.json({ target: OperationalDependencyService.getTarget(req.organizationId!) });
});
router.put("/target", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try {
    const t = req.body?.target;
    return res.json(OperationalDependencyService.setTarget(req.organizationId!, t == null ? null : Number(t)));
  } catch (e: any) { return res.status(400).json({ error: e.message }); }
});

export default router;
