import { Router } from "express";
import { AuthRequest, requireRole } from "../middleware/auth.js";
import { RadarB2BService } from "../RadarB2BService.js";
import { ProspectDiscoveryService } from "../ProspectDiscoveryService.js";

// Radar B2B — rotas (PRD Radar B2B, T04). Montadas em protectedApi (auth + org
// já aplicados). Mesmo padrão do módulo Prospect: leitura aberta ao usuário
// autenticado; escrita (import) restrita a owner/admin.
const router = Router();
const managerOnly = requireRole("owner", "admin");

// GET /api/radar-b2b/status — base instalada? total? mês da base?
router.get("/status", (_req: AuthRequest, res): any => {
  try { res.json(RadarB2BService.status()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/radar-b2b/search — { address?|cep?|lat?+lon?, radiusKm, filtros… }
router.post("/search", async (req: AuthRequest, res): Promise<any> => {
  const b = req.body || {};
  try {
    // Ponto de busca: usa lat/lon se vier; senão geocodifica endereço/CEP
    // (reuso do Prospect — sem duplicar a lógica de geocode/rate-limit).
    let ponto: { lat: number; lon: number; display: string } | null = null;
    if (typeof b.lat === "number" && typeof b.lon === "number") {
      ponto = { lat: b.lat, lon: b.lon, display: b.display || `${b.lat}, ${b.lon}` };
    } else if (b.cep && String(b.cep).replace(/\D/g, "").length === 8) {
      ponto = await ProspectDiscoveryService.geocodeViaCep(String(b.cep).replace(/\D/g, ""));
    } else if (b.address && String(b.address).trim()) {
      ponto = await ProspectDiscoveryService.geocode(String(b.address).trim());
    } else {
      return res.status(400).json({ error: "Informe um endereço, CEP ou lat/lon." });
    }
    if (!ponto) return res.status(422).json({ error: "Não consegui localizar esse endereço/CEP. Tente ser mais específico." });

    const result = RadarB2BService.search({
      lat: ponto.lat, lon: ponto.lon,
      radiusKm: Number(b.radiusKm) || 2,
      cnaePrefix: b.cnaePrefix ? String(b.cnaePrefix) : undefined,
      porte: Array.isArray(b.porte) ? b.porte : undefined,
      capitalMin: b.capitalMin != null ? Number(b.capitalMin) : undefined,
      comTelefone: !!b.comTelefone,
      comEmail: !!b.comEmail,
      limit: b.limit != null ? Number(b.limit) : undefined,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    res.json({ ponto, resumo: result.resumo, empresas: result.empresas });
  } catch (e: any) {
    res.status(500).json({ error: e.message || "Falha na busca." });
  }
});

// POST /api/radar-b2b/import — { campaignId?, cnpjs: string[] } (owner/admin)
router.post("/import", managerOnly, async (req: AuthRequest, res): Promise<any> => {
  const orgId = req.organizationId;
  const actorId = req.user?.userId;
  if (!orgId) return res.status(401).json({ error: "Unauthorized" });
  const b = req.body || {};
  const cnpjs = Array.isArray(b.cnpjs) ? b.cnpjs : [];
  if (!cnpjs.length) return res.status(400).json({ error: "Selecione ao menos uma empresa para importar." });
  try {
    const out = await RadarB2BService.importToProspect(orgId, b.campaignId ? String(b.campaignId) : null, cnpjs, actorId);
    res.json(out);
  } catch (e: any) {
    res.status(400).json({ error: e.message || "Falha ao importar." });
  }
});

export default router;
