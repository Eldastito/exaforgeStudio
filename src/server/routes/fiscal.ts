/**
 * FISCAL — API de prontidão da Reforma Tributária (CBS/IBS/IS). Montada em /api/fiscal.
 * ADR-181. Por ora: Perfil Fiscal da org (F1). owner/admin (config fiscal é decisão do dono).
 * A rota valida FORMA; o invariante (regime válido, Simples-only pro híbrido) vive no service.
 */
import { Router } from "express";
import { AuthRequest, requireRole, requireMasterAdmin } from "../middleware/auth.js";
import { FiscalProfileService, FISCAL_REGIMES } from "../FiscalProfileService.js";
import { TaxReferenceService, TRIBUTES } from "../TaxReferenceService.js";

const router = Router();
const actor = (req: any) => req.user?.userId || req.user?.id;
function fail(res: any, e: any) { res.status(400).json({ error: e?.message || "erro" }); }

/** Perfil fiscal + o que falta pro motor calcular (regimes disponíveis pro form). */
router.get("/profile", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try {
    const orgId = req.organizationId!;
    res.json({
      profile: FiscalProfileService.get(orgId),
      completeness: FiscalProfileService.completeness(orgId),
      regimes: FISCAL_REGIMES,
    });
  } catch (e: any) { fail(res, e); }
});

/** Grava o patch do perfil (só campos presentes). Regime inválido → 400. */
router.put("/profile", requireRole("owner", "admin"), (req: AuthRequest, res): any => {
  try {
    const orgId = req.organizationId!;
    const b = req.body || {};
    const profile = FiscalProfileService.save(orgId, {
      regime: b.regime,
      regimeRegularOptin: b.regimeRegularOptin,
      municipalRegistration: b.municipalRegistration,
      stateRegistration: b.stateRegistration,
      municipalityIbge: b.municipalityIbge,
      municipalityName: b.municipalityName,
    }, actor(req));
    res.json({ profile, completeness: FiscalProfileService.completeness(orgId) });
  } catch (e: any) { fail(res, e); }
});

// ── F2 — Base de Referência Tributária CURADA (master-only) ──
// A lei é GLOBAL e a curadoria é de plataforma (RN-FISCAL-2/6). Estas rotas escrevem/leem a
// base de alíquotas CBS/IBS/IS; o master carrega da fonte oficial. Nasce vazia — nunca inventa.

/** Cobertura da base (honesto quando vazia) + tributos disponíveis pro form. */
router.get("/reference/status", requireMasterAdmin, (_req: AuthRequest, res): any => {
  try { res.json({ status: TaxReferenceService.status(), tributes: TRIBUTES }); }
  catch (e: any) { fail(res, e); }
});

/** Lista as alíquotas curadas (published; ?includeArchived=1 traz arquivadas). */
router.get("/reference/rates", requireMasterAdmin, (req: AuthRequest, res): any => {
  try {
    res.json({ rates: TaxReferenceService.list({
      tribute: req.query.tribute ? String(req.query.tribute) : undefined,
      includeArchived: req.query.includeArchived === "1",
    }) });
  } catch (e: any) { fail(res, e); }
});

/** Publica uma alíquota curada. Exige reviewedBy (RN-FISCAL-2). */
router.post("/reference/curate", requireMasterAdmin, (req: AuthRequest, res): any => {
  try { res.json(TaxReferenceService.curate(req.body || {}, actor(req))); }
  catch (e: any) { fail(res, e); }
});

/** Arquiva uma alíquota (não apaga — histórico). */
router.post("/reference/rates/:id/archive", requireMasterAdmin, (req: AuthRequest, res): any => {
  try { res.json(TaxReferenceService.archive(String(req.params.id), actor(req))); }
  catch (e: any) { fail(res, e); }
});

export default router;
