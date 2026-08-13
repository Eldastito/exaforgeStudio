import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { SocialConnectionService } from "../SocialConnectionService.js";
import { logAuthEvent } from "../auditLog.js";

/**
 * Rotas do Social Connection Hub (PRD 10 / ADR-167 F2). ESTENDE Canais e IA com o
 * estado por-org das conexões de CANAL SOCIAL. Owner/admin (config = credencial).
 *
 * SEGREDOS (RN-SI-05): a config gravada é CIFRADA no service; o status devolvido é
 * REDIGIDO — nunca o token cru, só `hasToken`/escopos/capacidades/estado. A rota valida
 * FORMA; o service guarda invariante (cifra, degradação, estado observável §5). NÃO há
 * segunda tela de credenciais no frontend nem integração frontend→API social (§42): estas
 * rotas são o backend que a superfície de Canais e IA consome.
 */
const router = Router();

// GET /api/social/connections — lista REDIGIDA das conexões da org.
router.get("/connections", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  res.json({ connections: SocialConnectionService.list(orgId) });
});

// GET /api/social/connections/:channel — status REDIGIDO de um canal.
router.get("/connections/:channel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  res.json(SocialConnectionService.status(orgId, channel));
});

// PUT /api/social/connections/:channel { config, provider?, enabled?, scopes? } —
// grava credenciais (CIFRADAS no service). `config` traz o token/escopos do canal.
router.put("/connections/:channel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  const b = req.body || {};
  if (b.config != null && typeof b.config !== "object") return res.status(400).json({ error: "config inválido" });
  if (b.scopes != null && !Array.isArray(b.scopes)) return res.status(400).json({ error: "scopes inválido" });
  try {
    SocialConnectionService.setConfig(orgId, channel, b.config || {}, {
      provider: typeof b.provider === "string" ? b.provider : undefined,
      enabled: b.enabled == null ? undefined : !!b.enabled,
      scopes: Array.isArray(b.scopes) ? b.scopes.map(String) : undefined,
    });
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_CONNECTION_SET", { channel, enabled: !!b.enabled });
    res.json({ ok: true, ...SocialConnectionService.status(orgId, channel) });
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// POST /api/social/connections/:channel/health — passe de saúde: conecta, lê health,
// PERSISTE estado observável (§5) + capacidades DESCOBERTAS (RN-SI-06). Redigido.
router.post("/connections/:channel/health", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  try {
    const status = await SocialConnectionService.refreshHealth(orgId, channel);
    res.json(status);
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

// DELETE /api/social/connections/:channel — desconecta (zera credencial, not_connected).
router.delete("/connections/:channel", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const channel = String(req.params.channel || "");
  if (!SocialConnectionService.isKnownChannel(channel)) return res.status(400).json({ error: "canal inválido" });
  try {
    SocialConnectionService.disconnect(orgId, channel);
    logAuthEvent(orgId, (req as any).user?.userId || null, null, "SOCIAL_CONNECTION_DISCONNECTED", { channel });
    res.json({ ok: true, ...SocialConnectionService.status(orgId, channel) });
  } catch (e: any) { res.status(500).json({ error: String(e?.message || e) }); }
});

export default router;
