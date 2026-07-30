import { Router } from "express";
import fs from "node:fs";
import { ClinicPortalService } from "../ClinicPortalService.js";
import { ClinicDocumentDeliveryService } from "../ClinicDocumentDeliveryService.js";
import { ClinicPatientPortalService } from "../ClinicPatientPortalService.js";
import { ClinicDocumentsService } from "../ClinicDocumentsService.js";
import { ClinicAttachmentService } from "../ClinicAttachmentService.js";

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

// ── Portal do Paciente — rotas PÚBLICAS via token (ADR-080 Fase L) ─────
// Token opaco no path. Cada rota resolve o token e valida ownership por
// paciente antes de qualquer dado. Nenhum id interno vaza pra quem não
// tem o token — path traversal em ids é impossível porque cada `assertOwns`
// exige match `contact_id + status='issued' | share_with_patient=1`.

function resolveOr404(res: any, token: string) {
  const ctx = ClinicPatientPortalService.resolveToken(token);
  if (!ctx) { res.status(404).json({ error: "Link inválido ou expirado. Peça um novo à recepção." }); return null; }
  return ctx;
}

router.get("/patient/:token", (req, res): any => {
  const ctx = resolveOr404(res, req.params.token); if (!ctx) return;
  try { res.json(ClinicPatientPortalService.getPortalData(ctx.orgId, ctx.contactId)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.get("/patient/:token/prescriptions/:id/pdf", async (req, res): Promise<any> => {
  const ctx = resolveOr404(res, req.params.token); if (!ctx) return;
  if (!ClinicPatientPortalService.assertOwnsPrescription(ctx.orgId, ctx.contactId, req.params.id)) return res.status(404).json({ error: "not_found" });
  try {
    const pdf = await ClinicDocumentsService.renderPrescriptionPdf(ctx.orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="receita-${req.params.id.slice(0, 8)}.pdf"`);
    return res.send(pdf);
  } catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.get("/patient/:token/certificates/:id/pdf", async (req, res): Promise<any> => {
  const ctx = resolveOr404(res, req.params.token); if (!ctx) return;
  if (!ClinicPatientPortalService.assertOwnsCertificate(ctx.orgId, ctx.contactId, req.params.id)) return res.status(404).json({ error: "not_found" });
  try {
    const pdf = await ClinicDocumentsService.renderCertificatePdf(ctx.orgId, req.params.id);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="atestado-${req.params.id.slice(0, 8)}.pdf"`);
    return res.send(pdf);
  } catch (e: any) { res.status(404).json({ error: e.message }); }
});

router.get("/patient/:token/attachments/:id/download", (req, res): any => {
  const ctx = resolveOr404(res, req.params.token); if (!ctx) return;
  if (!ClinicPatientPortalService.assertOwnsSharedAttachment(ctx.orgId, ctx.contactId, req.params.id)) return res.status(404).json({ error: "not_found" });
  try {
    const { buffer, mime, filename } = ClinicAttachmentService.read(ctx.orgId, req.params.id);
    res.setHeader("Content-Type", mime);
    const disposition = mime.startsWith("image/") ? "inline" : "attachment";
    res.setHeader("Content-Disposition", `${disposition}; filename="${filename.replace(/"/g, "")}"`);
    return res.send(buffer);
  } catch (e: any) { res.status(404).json({ error: e.message }); }
});

export default router;
