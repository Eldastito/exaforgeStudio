/**
 * FIN — API financeira (PRD Moda/TOULON). Montada em /api/fin.
 * Por ora: conexão de COBRANÇA Sicredi (ADR-177) — scaffold honesto, gated na
 * homologação bancária. owner/admin (config financeira); segredos nunca voltam.
 */
import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { SicrediCobrancaService } from "../SicrediCobrancaService.js";

const router = Router();

function fail(res: any, e: any) {
  res.status(400).json({ error: e?.message || "erro" });
}

// Status REDIGIDO da conexão Sicredi Cobrança (sem segredos).
router.get("/sicredi/cobranca/status", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try {
    res.json(SicrediCobrancaService.status(req.organizationId!));
  } catch (e: any) { fail(res, e); }
});

// Grava/atualiza credenciais (cifradas) + opt-in. Nunca marca 'connected'
// (configurar não homologa — ADR-177 RN-177-002).
router.put("/sicredi/cobranca/config", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try {
    const body = req.body || {};
    const enabled = body.enabled != null ? !!body.enabled : undefined;
    res.json(SicrediCobrancaService.configure(req.organizationId!, body, { enabled }, req.user?.userId));
  } catch (e: any) { fail(res, e); }
});

// Desliga/limpa a conexão (reversível).
router.post("/sicredi/cobranca/disconnect", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try {
    res.json(SicrediCobrancaService.disconnect(req.organizationId!, req.user?.userId));
  } catch (e: any) { fail(res, e); }
});

// Tentativa de emissão — enquanto não homologado, devolve erro claro (honesto).
// Existe pra que o caminho da UI seja verdadeiro (nunca finge emissão).
router.post("/sicredi/cobranca/charge", requireRole("owner", "admin"), async (req: AuthRequest, res): Promise<any> => {
  try {
    await SicrediCobrancaService.issueCharge(req.organizationId!, req.body || {});
    res.json({ ok: true });
  } catch (e: any) {
    // 501: implementação pendente de homologação — honesto, não é erro do cliente.
    const awaiting = e?.message === "sicredi_awaiting_homologation" || e?.message === "sicredi_not_configured";
    res.status(awaiting ? 501 : 400).json({ error: e?.message || "erro", awaitingHomologation: awaiting });
  }
});

export default router;
