import { Router } from "express";
import { FalaTuService } from "../FalaTuService.js";
import { FalaTuCaptureTokenService } from "../FalaTuCaptureTokenService.js";

// ADR-154 F8.4 — ingestão por TOKEN PESSOAL (API aberta write-only).
//
// Montado FORA do protectedApi (sem JWT/sessão): autentica pelo token `ftk_`
// no Authorization Bearer. O escopo é deliberadamente MÍNIMO — este router
// expõe UMA rota. É isso (e não uma flag) que garante o write-only: com um
// token vazado dá pra criar item PENDENTE no inbox do próprio dono e nada
// mais (RN-151: materializar exige confirm humano autenticado na sessão).
//
// É a porta dos plugues externos da Fase 8: Atalho Siri, Share Target
// Android, adesivo NFC, Zapier/n8n/ERP. Sem rate limit próprio no MVP:
// custo de IA já é governado dentro do capture() (PlanService.aiAllowed +
// ai_usage_ledger, mesma régua da sessão).

// Mesmo teto da rota de sessão (routes/falatu.ts) — o body global é 2mb.
const MAX_MEDIA_B64 = 1_900_000;

const router = Router();

router.post("/capture", async (req, res): Promise<any> => {
  const auth = String(req.headers.authorization || "");
  const tok = FalaTuCaptureTokenService.verify(auth.startsWith("Bearer ") ? auth.slice(7) : "");
  if (!tok) return res.status(401).json({ error: "Token de captura inválido ou revogado." });
  // Mesmo gate de módulo da sessão (falatuGate, sem o bypass de master admin
  // — token é sempre de usuário comum agindo em nome próprio).
  if (!FalaTuService.orgEnabled(tok.orgId)) {
    return res.status(403).json({ error: "FalaTu não está habilitado para esta organização." });
  }
  const { text, audio, image, source } = req.body || {};
  if (text !== undefined && typeof text !== "string") return res.status(400).json({ error: "text deve ser string." });
  for (const [name, media] of [["audio", audio], ["image", image]] as const) {
    if (media === undefined) continue;
    if (typeof media?.mimeType !== "string" || typeof media?.data !== "string") {
      return res.status(400).json({ error: `${name} deve ter mimeType e data (base64).` });
    }
    if (media.data.length > MAX_MEDIA_B64) return res.status(400).json({ error: `${name} muito grande (máx ~1.4MB).` });
  }
  if (audio && image) return res.status(400).json({ error: "Envie áudio OU imagem, não ambos." });
  try {
    res.json(await FalaTuService.capture(tok.orgId, tok.userId, { text, audio, image, source }));
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

export default router;
