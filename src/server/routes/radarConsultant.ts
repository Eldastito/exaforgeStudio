import { Router } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { RadarConsultantService } from "../RadarConsultantService.js";

// Painel do consultor (Radar — Fase 3). Router INTEIRO montado atrás de
// `requireMasterAdmin` em server.ts (mesmo padrão de /api/admin e /api/audit)
// — nenhuma checagem de autorização acontece aqui dentro, de propósito: a
// autorização já aconteceu no nível do mount. Ver RadarConsultantService.ts
// para o porquê disso ser seguro (cross-tenant intencional, não um bug).

const router = Router();

const actorId = (req: any) => req.user?.userId || req.user?.id;

router.get("/sessions", (req: AuthRequest, res): any => {
  res.json(RadarConsultantService.listSessions({ status: req.query.status as string | undefined }));
});

router.get("/sessions/:id", (req: AuthRequest, res): any => {
  const session = RadarConsultantService.getSession(req.params.id);
  if (!session) return res.status(404).json({ error: "Sessão não encontrada." });
  res.json(session);
});

router.patch("/sessions/:id/note", (req: AuthRequest, res): any => {
  try { res.json(RadarConsultantService.saveNote(req.params.id, actorId(req), req.body?.note || "")); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:id/approve", (req: AuthRequest, res): any => {
  try { res.json(RadarConsultantService.approve(req.params.id, actorId(req))); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
