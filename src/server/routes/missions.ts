/**
 * MISSIONS — API do Mission Contract (ADR-189 F1, Mission OS). Montada em /api/missions.
 * owner/admin (missão é decisão de negócio do dono). GATE SERVER-SIDE pela flag
 * `mission_layer_enabled` (esconder botão não é segurança): desligada → 404, o recurso
 * não existe pro tenant. A rota valida FORMA; o invariante vive no MissionService.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { MissionService } from "../MissionService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;
function fail(res: any, e: any) { res.status(400).json({ error: e?.message || "erro" }); }

/** Gate: o Mission Layer precisa estar ligado pra org (opt-in). */
function requireMissionLayer(req: AuthRequest, res: any, next: any): any {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  if (!MissionService.isEnabled(orgId)) return res.status(404).json({ error: "Mission Layer indisponível para esta organização." });
  next();
}

router.use(requireRole("owner", "admin"), requireMissionLayer);

/** Lista as missões (opcional ?status=). */
router.get("/", (req: AuthRequest, res): any => {
  try {
    const status = typeof req.query?.status === "string" ? req.query.status : undefined;
    res.json({ missions: MissionService.list(req.organizationId!, { status }) });
  } catch (e: any) { fail(res, e); }
});

/** Cria uma missão (nasce draft, autonomia off). */
router.post("/", (req: AuthRequest, res): any => {
  try { res.json(MissionService.create(req.organizationId!, req.body || {}, actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Detalhe de uma missão. */
router.get("/:id", (req: AuthRequest, res): any => {
  try {
    const m = MissionService.get(req.organizationId!, String(req.params.id));
    if (!m) return res.status(404).json({ error: "Missão não encontrada." });
    res.json(m);
  } catch (e: any) { fail(res, e); }
});

/** Patch parcial do contrato (não muda status). */
router.patch("/:id", (req: AuthRequest, res): any => {
  try { res.json(MissionService.update(req.organizationId!, String(req.params.id), req.body || {}, actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Muda o status da missão. */
router.post("/:id/status", (req: AuthRequest, res): any => {
  try { res.json(MissionService.setStatus(req.organizationId!, String(req.params.id), String(req.body?.status || ""), actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Ajusta a autonomia (autopilot é recusado — shadow-first). */
router.post("/:id/autonomy", (req: AuthRequest, res): any => {
  try { res.json(MissionService.setAutonomy(req.organizationId!, String(req.params.id), String(req.body?.level || ""), actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Cancela (preserva histórico — nunca deleta). */
router.post("/:id/cancel", (req: AuthRequest, res): any => {
  try { res.json(MissionService.cancel(req.organizationId!, String(req.params.id), actor(req))); }
  catch (e: any) { fail(res, e); }
});

export default router;
