/**
 * Rotas de artefatos (PRD 1, Fase 2). Duas superfícies:
 *  - PROTEGIDA (sessão + org): listar/ver metadados + emitir URL assinada.
 *    Nunca devolve o path interno do servidor (§15) — só id + URL.
 *  - PÚBLICA (sem sessão): download por URL assinada HMAC (§16). A segurança é a
 *    assinatura (tenant + expiração + timingSafeEqual), não o login.
 */
import { Router, Response } from "express";
import { AuthRequest } from "../middleware/auth.js";
import { ArtifactService } from "../ArtifactService.js";

const actorId = (req: any) => req.user?.userId || req.user?.id;

// ── Protegida: montada no protectedApi (/api/artifacts) ──
export const artifactsRoutes = Router();

artifactsRoutes.get("/", (req: AuthRequest, res): any => {
  const createdBy = req.query.mine === "1" || req.query.mine === "true" ? actorId(req) : undefined;
  const kind = typeof req.query.kind === "string" ? req.query.kind : undefined;
  // Gated por classificação: artefatos sensíveis de outros só aparecem p/ quem pode.
  res.json(ArtifactService.listForUser(req.organizationId!, req.user, { createdBy, kind, limit: Number(req.query.limit) || 50 }));
});

artifactsRoutes.get("/:id", (req: AuthRequest, res): any => {
  const a = ArtifactService.getForUser(req.organizationId!, req.user, req.params.id);
  if (!a) return res.status(404).json({ error: "Artefato não encontrado." }); // 404 (não 403) não revela existência
  const { storageKey, ...pub } = a; // não vaza o path interno
  res.json(pub);
});

// Emite a URL assinada temporária pra entrega (ex.: link no Fala Tu). Gated:
// quem não pode acessar não minta o link (o download público é bearer).
artifactsRoutes.get("/:id/link", (req: AuthRequest, res): any => {
  const url = ArtifactService.signedUrlForUser(req.organizationId!, req.user, req.params.id);
  if (!url) return res.status(404).json({ error: "Artefato não encontrado." });
  res.json({ url });
});

// ── Pública: montada em /api/public/artifacts (sem requireAuth) ──
export const artifactsPublicRoutes = Router();

artifactsPublicRoutes.get("/:orgId/:id", (req, res: Response): any => {
  const file = ArtifactService.resolveSigned(req.params.orgId, req.params.id, String(req.query.exp || ""), String(req.query.sig || ""));
  if (!file) return res.status(404).send("Não encontrado ou link expirado.");
  res.setHeader("Content-Type", file.mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
  res.send(file.buffer);
});
