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

// POST /api/public/comigo/:token/order — pay-first: cria pedido + cobrança Pix.
router.post("/:token/order", (req, res): any => {
  const orgId = ComigoMesaService.orgByToken(req.params.token);
  if (!orgId) return res.status(404).json({ error: "not_found" });
  const { items, sessionAlias, consumo } = req.body || {};
  const out = ComigoMesaService.placeOrder(orgId, { items, sessionAlias, consumo });
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
