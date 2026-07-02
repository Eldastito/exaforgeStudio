import { Router } from "express";
import { RadarPublicService } from "../RadarPublicService.js";

// Rotas PÚBLICAS do diagnóstico rápido do Radar — sem login, sem
// organização. Montadas em server.ts ANTES do bloco `protectedApi`, mesmo
// padrão de storefrontPublicRoutes: `/api/public/radar/*` nunca exige JWT.
const router = Router();

// Kill-switch global da landing pública (PRD §17: `public_radar_enabled`).
// Independente do módulo opcional 'radar' (que gate as rotas AUTENTICADAS) —
// dá para desligar só a porta de entrada pública sem afetar quem já usa o
// diagnóstico internamente. Default ligado.
router.use((_req, res, next) => {
  if (process.env.PUBLIC_RADAR_ENABLED === "false") {
    return res.status(404).json({ error: "not_found" });
  }
  next();
});

// Rate limit simples por IP, em memória, autocontido — mesmo padrão do
// `rateLimit` local de server.ts (não é exportado de lá, então replicado aqui
// pequeno; ver docs/adr/ADR-012). Só a criação de sessão é limitada de forma
// agressiva — é o endpoint que um bot atacaria para poluir o funil de leads.
const buckets = new Map<string, { count: number; resetTime: number }>();
function rateLimit(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.resetTime) b = { count: 0, resetTime: now + windowMs };
  b.count++;
  buckets.set(key, b);
  return b.count <= max;
}
function clientIp(req: any): string {
  return String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();
}

router.get("/template", (_req, res): any => {
  try { res.json(RadarPublicService.getDefaultTemplate()); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.post("/sessions", (req, res): any => {
  const ip = clientIp(req);
  if (!rateLimit(`radar_public_create:${ip}`, 10, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Muitas tentativas. Tente novamente mais tarde." });
  }
  // Honeypot: campo escondido no formulário que só um bot preenche (humano
  // nunca vê o input). Responde 201 "de mentirinha" — sem criar nada — para
  // não sinalizar ao bot que foi detectado.
  if (req.body?.website) {
    return res.status(201).json({ token: randomFakeToken(), session: null });
  }
  try {
    const { session, token } = RadarPublicService.createSession(req.body || {});
    res.status(201).json({ token, session });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/sessions/:token", (req, res): any => {
  const session = RadarPublicService.getByToken(req.params.token);
  if (!session) return res.status(404).json({ error: "Link expirado ou inválido. Solicite um novo diagnóstico." });
  res.json(session);
});

router.patch("/sessions/:token", (req, res): any => {
  try { res.json(RadarPublicService.updateContact(req.params.token, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:token/consent", (req, res): any => {
  try { res.json(RadarPublicService.recordConsent(req.params.token, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:token/answers", (req, res): any => {
  const ip = clientIp(req);
  if (!rateLimit(`radar_public_answer:${ip}`, 300, 60 * 60 * 1000)) {
    return res.status(429).json({ error: "Muitas requisições." });
  }
  try { res.json(RadarPublicService.saveAnswer(req.params.token, req.body || {})); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.post("/sessions/:token/complete", (req, res): any => {
  try { res.json(RadarPublicService.complete(req.params.token)); }
  catch (e: any) { res.status(400).json({ error: e.message }); }
});

router.get("/sessions/:token/result", (req, res): any => {
  try { res.json(RadarPublicService.getResult(req.params.token)); }
  catch (e: any) { res.status(404).json({ error: e.message }); }
});

function randomFakeToken(): string {
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

export default router;
