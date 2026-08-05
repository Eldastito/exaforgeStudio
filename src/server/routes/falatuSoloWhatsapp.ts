/**
 * ADR-154 Fatia 4.1 — rotas de provision Evolution dedicado por org Solo.
 *
 * Duas rotas:
 *   POST /api/falatu-solo/whatsapp/provision — provisiona (idempotente) e
 *        devolve QR. Só owner da org Solo autoriza (o assinante do assistente
 *        pessoal É o dono). Erro de Evolution → 502 com mensagem clara.
 *   GET  /api/falatu-solo/whatsapp/status    — kind + canal + connected/hasQr.
 *        Usado por health-check e futura UI da FalaTuSettingsView (Fase 3).
 *
 * `assertSoloOrg` está no service — se a org NÃO for solo, o service devolve
 * ok:false; a rota traduz pra 403 (semanticamente é "permissão"; não é 400
 * de payload). RBAC via requireRole('owner').
 */
import { Router, Response } from "express";
import { AuthRequest, requireAuth, requireRole } from "../middleware/auth.js";
import { FalaTuSoloWhatsAppService } from "../FalaTuSoloWhatsAppService.js";

const router = Router();

router.post("/provision", requireAuth, requireRole("owner"), async (req: AuthRequest, res: Response): Promise<any> => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(400).json({ error: "organizationId ausente." });
  try {
    const result = await FalaTuSoloWhatsAppService.provision(orgId, req.user?.userId || null);
    if (!result.ok) {
      // Distingue "não é solo" (403) de "Evolution falhou" (502) na mensagem.
      const status = /solo|blueprint/i.test(result.error || "") ? 403 : 502;
      return res.status(status).json({ error: result.error, channelId: result.channelId });
    }
    return res.status(200).json({
      ok: true,
      instanceName: result.instanceName,
      channelId: result.channelId,
      qrBase64: result.qrBase64,
      state: result.state,
      alreadyProvisioned: !!result.alreadyExists,
    });
  } catch (e: any) {
    console.error("[FalaTuSoloWA] provision fatal:", e);
    return res.status(500).json({ error: e?.message || "Falha interna no provision" });
  }
});

router.get("/status", requireAuth, (req: AuthRequest, res: Response): any => {
  const orgId = req.organizationId;
  if (!orgId) return res.status(400).json({ error: "organizationId ausente." });
  try {
    const s = FalaTuSoloWhatsAppService.getStatus(orgId);
    return res.json(s);
  } catch (e: any) {
    console.error("[FalaTuSoloWA] status fatal:", e);
    return res.status(500).json({ error: e?.message || "Falha ao consultar status" });
  }
});

export default router;
