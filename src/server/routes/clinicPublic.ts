import { Router } from "express";
import { ClinicPortalService } from "../ClinicPortalService.js";

/**
 * Portal do Profissional — rota PÚBLICA (sem login), ADR-080 Fase D. O token
 * (na URL, resolvido por hash no banco) É a credencial. Expõe SOMENTE a agenda
 * do próprio profissional, com projeção enxuta. Montada em /api/public/clinic.
 */
const router = Router();

router.get("/portal/:token", (req, res): any => {
  try { res.json(ClinicPortalService.agendaByToken(req.params.token, req.query.date as string)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

export default router;
