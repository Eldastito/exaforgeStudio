import { Router } from "express";
import fs from "node:fs";
import { ClinicPortalService } from "../ClinicPortalService.js";
import { ClinicDocumentDeliveryService } from "../ClinicDocumentDeliveryService.js";

/**
 * Rotas PÚBLICAS (sem login) do módulo Clínica. Montada em /api/public/clinic.
 *   - Portal do Profissional (ADR-080 Fase D) — token na URL é a credencial.
 *   - Download de doc clínico por URL assinada (ADR-080 Fase K) — o WhatsApp/
 *     Meta baixa o PDF por essa rota; ninguém sem `sig` válido acessa.
 */
const router = Router();

router.get("/portal/:token", (req, res): any => {
  try { res.json(ClinicPortalService.agendaByToken(req.params.token, req.query.date as string)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

// GET /api/public/clinic/documents/:key?exp=&sig=  → PDF binário se HMAC ok.
// `:key` é o basename do arquivo em PRIVATE_MEDIA_DIR/clinical_docs/ —
// nunca vira path de sistema porque o service valida basename.
router.get("/documents/:key", (req, res): any => {
  const filePath = ClinicDocumentDeliveryService.resolveSignedFile(
    req.params.key,
    String(req.query.exp || ""),
    String(req.query.sig || "")
  );
  if (!filePath) return res.status(404).json({ error: "not_found" });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${req.params.key}"`);
  return fs.createReadStream(filePath).pipe(res);
});

export default router;
