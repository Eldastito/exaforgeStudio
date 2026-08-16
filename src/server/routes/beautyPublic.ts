/**
 * Rota PÚBLICA da Beleza & Salões (ADR-169 F7) — serve mídia privada por
 * URL ASSINADA HMAC (fileSigning canônico, escopo `beauty_private_media_v1`).
 *
 * Montada em `/api/public/beauty/media`, ANTES do middleware de auth do
 * staff (padrão fashionPublic/clinicPublic). Sem cookies, sem sessão — só
 * a assinatura da URL manda. Segurança em camadas:
 *  - `resolveSignedFile` chama `verifyKey` do fileSigning (HMAC +
 *    expiração + timingSafeEqual) + `safeStorageKey` anti-traversal.
 *  - `X-Content-Type-Options: nosniff` (defesa em profundidade contra
 *    interpretação do navegador).
 *  - Cache-Control privado curto — a URL já é curta (TTL 15min).
 */
import { Router, Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { BeautyVisualConsultationService } from "../BeautyVisualConsultationService.js";
import { BeautyQueueService } from "../BeautyQueueService.js";

const router = Router();

// F37 — status PÚBLICO da fila virtual (celular do cliente). Sem sessão: a
// assinatura HMAC da URL (escopo `beauty_queue`) prova a posse do link que a
// recepção gerou. Só devolve o PRIMEIRO NOME do próprio cliente + posição —
// nunca nomes de outros da fila (minimização LGPD). `no-store`: dado ao vivo.
// GET /api/public/beauty/queue/:id?exp=&sig=
router.get("/queue/:id", (req: Request, res: Response): any => {
  const id = String(req.params.id || "");
  const exp = String(req.query.exp || "");
  const sig = String(req.query.sig || "");
  if (!id || !exp || !sig) return res.status(400).json({ error: "bad_request" });
  const status = BeautyQueueService.status(id, exp, sig);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (!status.found) return res.status(status.state === "not_found" ? 403 : 200).json(status);
  res.json(status);
});

// GET /api/public/beauty/media/:key?exp=&sig=
router.get("/media/:key(*)", (req: Request, res: Response): any => {
  const key = String(req.params.key || "");
  const exp = String(req.query.exp || "");
  const sig = String(req.query.sig || "");
  if (!key || !exp || !sig) return res.status(400).send("bad_request");

  const file = BeautyVisualConsultationService.resolveSignedFile(key, exp, sig);
  if (!file) return res.status(403).send("forbidden");
  if (!fs.existsSync(file)) return res.status(404).send("not_found");

  // Content-Type básico pela extensão (o service só grava JPEG/PNG hoje).
  const ext = path.extname(file).toLowerCase();
  const ct = ext === ".png" ? "image/png"
           : ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
           : "application/octet-stream";
  res.setHeader("Content-Type", ct);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, max-age=900"); // 15 min — coincide com TTL da assinatura
  return res.sendFile(file);
});

export default router;
