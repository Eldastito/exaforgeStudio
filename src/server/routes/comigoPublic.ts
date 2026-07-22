import { Router } from "express";
import { ComigoMesaService } from "../ComigoMesaService.js";

// ZappFlow Comigo — rotas PÚBLICAS do Mesa/QR (ADR-119). Sem JWT: o cliente não
// tem login. A org é resolvida pelo token do QR; preço vem sempre do servidor.
const router = Router();

// GET /api/public/comigo/:token/menu — cardápio da mesa.
router.get("/:token/menu", (req, res): any => {
  const orgId = ComigoMesaService.orgByToken(req.params.token);
  if (!orgId) return res.status(404).json({ error: "not_found" });
  res.json({ items: ComigoMesaService.menu(orgId) });
});

// POST /api/public/comigo/:token/fiado-check — o cliente confere se pode fiar
// (só aparece pra quem o dono cadastrou e liberou, dentro do limite — ADR-124).
router.post("/:token/fiado-check", (req, res): any => {
  const orgId = ComigoMesaService.orgByToken(req.params.token);
  if (!orgId) return res.status(404).json({ error: "not_found" });
  const { phone, cartTotal } = req.body || {};
  const e = ComigoMesaService.fiadoEligibility(orgId, String(phone || ""), Number(cartTotal) || 0);
  // Não vaza saldo/limite de terceiros: só devolve o essencial.
  res.json({ authorized: !!e.authorized, available: e.available ?? 0, fits: e.fits ?? false, name: e.name || null });
});

// POST /api/public/comigo/:token/order — Pix dinâmico (pay-first) ou fiado autorizado.
router.post("/:token/order", (req, res): any => {
  const orgId = ComigoMesaService.orgByToken(req.params.token);
  if (!orgId) return res.status(404).json({ error: "not_found" });
  const { items, sessionAlias, consumo, payment, customer } = req.body || {};
  const out = ComigoMesaService.placeOrder(orgId, { items, sessionAlias, consumo, payment, customer });
  if (!out.ok) return res.status(400).json(out);
  res.status(201).json(out);
});

// GET /api/public/comigo/:token/order/:orderId/status — polling do pagamento.
router.get("/:token/order/:orderId/status", (req, res): any => {
  const orgId = ComigoMesaService.orgByToken(req.params.token);
  if (!orgId) return res.status(404).json({ error: "not_found" });
  res.json(ComigoMesaService.orderStatus(orgId, req.params.orderId));
});

export default router;
