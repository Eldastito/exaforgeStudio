import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { ContextCandidateService } from "../ContextCandidateService.js";

/**
 * Candidatos de contexto (PRD 3 F6 / §36/§37) — uma mudança PROPOSTA ao contexto
 * (uma restrição/regra ou um fato) capturada do Fala Tu / de um detector, que só
 * afeta o contexto depois de CONFIRMADA por um humano (nunca em silêncio, §36).
 * Leitura pra qualquer papel autenticado; capturar/confirmar/rejeitar é do gestor
 * (owner/admin) — confirmar PROMOVE (cria restrição / publica sinal). A rota valida
 * a FORMA; o serviço guarda o invariante de estado + a promoção.
 */
const router = Router();
const actor = (req: AuthRequest) => req.user?.userId;

// GET /api/context-candidates?status=&kind= — lista (isolado por org).
router.get("/", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ candidates: ContextCandidateService.list(orgId, { status: req.query.status as string | undefined, kind: req.query.kind as string | undefined }) });
});

// GET /api/context-candidates/:id — um candidato.
router.get("/:id", (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const c = ContextCandidateService.get(orgId, req.params.id);
  if (!c) return res.status(404).json({ error: "Candidato não encontrado." });
  res.json({ candidate: c });
});

// POST /api/context-candidates — captura um candidato (gestor). NÃO altera o
// contexto (§36) — só registra a proposta.
router.post("/", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, candidate: ContextCandidateService.detect(orgId, { ...(req.body || {}), createdBy: actor(req) }) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// POST /api/context-candidates/:id/submit — DETECTED → PENDING (gestor).
router.post("/:id/submit", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, candidate: ContextCandidateService.submit(orgId, req.params.id, actor(req)) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// POST /api/context-candidates/:id/confirm — CONFIRMA e PROMOVE (gestor). É o
// único ponto que muda o contexto (§36).
router.post("/:id/confirm", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, ...ContextCandidateService.confirm(orgId, req.params.id, actor(req), { reason: req.body?.reason }) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

// POST /api/context-candidates/:id/reject — rejeita sem promover (gestor).
router.post("/:id/reject", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  try {
    res.json({ ok: true, candidate: ContextCandidateService.reject(orgId, req.params.id, actor(req), { reason: req.body?.reason }) });
  } catch (e: any) {
    res.status(400).json({ error: String(e?.message || e) });
  }
});

export default router;
