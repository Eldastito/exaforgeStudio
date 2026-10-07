/**
 * Rotas PÚBLICAS do link de consentimento do cliente do PDV (ADR-204 D4c) — montadas em `/api/public/consent`, FORA do `requireAuth` do staff.
 * Autoriza só pelo token do link (32 bytes, comparado por hash). Devolve o MÍNIMO e erra de forma uniforme: link desconhecido/revogado → 404; vencido → 410.
 * Limite por IP (em memória) pra travar tentativa em massa — o token é inadivinhável, o limite é defesa em profundidade.
 */
import { Router, Request, Response } from "express";
import { PdvConsentLinkService } from "../PdvConsentLinkService.js";

const router = Router();
const buckets = new Map<string, { n: number; reset: number }>();
export const CONSENT_PUBLIC_MAX = 40, CONSENT_PUBLIC_WINDOW_MS = 10 * 60 * 1000;
export function resetConsentPublicLimiter() { buckets.clear(); }

function limited(req: Request): boolean {
  const ip = String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown").split(",")[0].trim();
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now > b.reset) b = { n: 0, reset: now + CONSENT_PUBLIC_WINDOW_MS };
  b.n++; buckets.set(ip, b);
  return b.n > CONSENT_PUBLIC_MAX;
}
const fail = (res: Response, reason: string): any => res.status(reason === "expired" ? 410 : reason === "bad_request" ? 400 : 404).json({ error: reason === "expired" ? "link_expired" : reason === "bad_request" ? "bad_request" : "link_invalid" });

router.get("/:token", (req: Request, res: Response): any => {
  if (limited(req)) return res.status(429).json({ error: "too_many_requests" });
  res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Robots-Tag", "noindex");
  const v = PdvConsentLinkService.view(String(req.params.token));
  if (v.ok === false) return fail(res, v.reason);
  res.json(v);
});

router.post("/:token/decision", (req: Request, res: Response): any => {
  if (limited(req)) return res.status(429).json({ error: "too_many_requests" });
  res.setHeader("Cache-Control", "no-store");
  const out = PdvConsentLinkService.decide(String(req.params.token), req.body?.granted);
  if (out.ok === false) return fail(res, out.reason === "no_phone" ? "invalid" : out.reason);
  res.json({ ok: true, state: out.state });
});

export default router;
