/**
 * Rotas PÚBLICAS do webapp do profissional (ADR-180 F7.1) — montadas em
 * `/api/public/professional`, FORA do `requireAuth` do staff (nunca exigem JWT de painel).
 *
 * Fluxo: `POST /session` troca o magic-link por um JWT escopado (professional_portal); os
 * demais endpoints exigem esse JWT via `requireProfessional` (sessão do profissional, sem
 * organizationId — nunca toca `users`/org). Leitura por-profissional (F7.1); a escrita
 * (disponibilidade, aceitar/recusar) entra nas F7.3/F7.4 sobre este mesmo eixo.
 */
import { Router, Request, Response, NextFunction } from "express";
import { ProfessionalAuthService } from "../ProfessionalAuthService.js";
import { ProfessionalSelfService } from "../ProfessionalSelfService.js";
import { ProfessionalService } from "../ProfessionalService.js";

const router = Router();

interface ProfReq extends Request { professionalId?: string; }

/** Sessão do profissional: Bearer JWT escopado (professional_portal). 401 se ausente/inválido. */
function requireProfessional(req: ProfReq, res: Response, next: NextFunction): any {
  const h = String(req.headers.authorization || "");
  const token = h.startsWith("Bearer ") ? h.slice(7) : (req.headers["x-professional-session"] as string) || "";
  const claims = ProfessionalAuthService.verifySession(token);
  if (!claims) return res.status(401).json({ error: "professional_session_invalid" });
  req.professionalId = claims.professionalId;
  next();
}

// Troca do magic-link por sessão.
router.post("/session", (req: Request, res: Response): any => {
  try {
    const token = String(req.body?.token || req.query?.token || "");
    res.json(ProfessionalAuthService.startSession(token));
  } catch (e: any) { res.status(401).json({ error: e?.message || "token_invalid" }); }
});

// Cabeçalho: identidade + clínicas.
router.get("/overview", requireProfessional, (req: ProfReq, res: Response): any => {
  try { res.json(ProfessionalSelfService.overview(req.professionalId!)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// Agenda federada (todas as clínicas) numa janela.
router.get("/agenda", requireProfessional, (req: ProfReq, res: Response): any => {
  try {
    res.json(ProfessionalSelfService.agenda(req.professionalId!, {
      fromISO: req.query.from as string, toISO: req.query.to as string,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    }));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// Financeiro do profissional (o que recebe/vai receber), agregado por clínica.
router.get("/finance", requireProfessional, (req: ProfReq, res: Response): any => {
  try { res.json(ProfessionalSelfService.finance(req.professionalId!, { fromISO: req.query.from as string, toISO: req.query.to as string })); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// F7.3 — o profissional edita a PRÓPRIA disponibilidade numa clínica dele.
router.get("/relationships/:relId/windows", requireProfessional, (req: ProfReq, res: Response): any => {
  try { res.json(ProfessionalSelfService.windows(req.professionalId!, String(req.params.relId))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.put("/relationships/:relId/windows", requireProfessional, (req: ProfReq, res: Response): any => {
  try {
    const windows = Array.isArray(req.body?.windows) ? req.body.windows : req.body;
    res.json(ProfessionalSelfService.setWindows(req.professionalId!, String(req.params.relId), windows));
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// F7.4 — o profissional aceita (confirma presença) / recusa (cancela + avisa a clínica).
router.post("/appointments/:apptId/accept", requireProfessional, (req: ProfReq, res: Response): any => {
  try { res.json(ProfessionalSelfService.acceptAppointment(req.professionalId!, String(req.params.apptId))); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.post("/appointments/:apptId/decline", requireProfessional, async (req: ProfReq, res: Response): Promise<any> => {
  try { res.json(await ProfessionalSelfService.declineAppointment(req.professionalId!, String(req.params.apptId), req.body?.reason)); }
  catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

// F10.1 — o profissional liga/desliga a própria descoberta (rede/marketplace) + região base.
router.get("/discovery-profile", requireProfessional, (req: ProfReq, res: Response): any => {
  try {
    const p = ProfessionalService.getById(req.professionalId!);
    if (!p) return res.status(404).json({ error: "professional_not_found" });
    res.json({ discoverable: p.discoverable, baseCity: p.baseCity, baseState: p.baseState, specialties: p.specialties });
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});
router.put("/discovery-profile", requireProfessional, (req: ProfReq, res: Response): any => {
  try {
    const b = req.body || {};
    const p = ProfessionalService.setDiscoverability(req.professionalId!, {
      discoverable: b.discoverable, baseCity: b.baseCity, baseState: b.baseState,
    }, `professional:${req.professionalId}`);
    res.json({ discoverable: p.discoverable, baseCity: p.baseCity, baseState: p.baseState, specialties: p.specialties });
  } catch (e: any) { res.status(400).json({ error: e?.message || "erro" }); }
});

export default router;
