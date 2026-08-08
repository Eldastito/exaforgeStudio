import { Router } from "express";
import { PlanService } from "../PlanService.js";
import { FalatuCheckoutService, FalatuCheckoutError } from "../FalatuCheckoutService.js";

/**
 * Rotas PÚBLICAS do FalaTu (sem auth) — ADR-154 F2.2 (Fatias A + B).
 *
 * - GET  /plans    → catálogo comercial (Solo/Pro/Família). Read-only, vitrine.
 * - POST /checkout → inicia a assinatura self-serve: cria a conta + assinatura
 *   no Asaas e devolve o link de pagamento (o webhook existente ativa a conta
 *   quando o pagamento confirma). A gente NUNCA recebe dado de cartão — o
 *   pagamento acontece na página hospedada do Asaas.
 */
const router = Router();

// GET /api/public/falatu/plans → catálogo B2C do FalaTu.
router.get("/plans", (_req, res): any => {
  try {
    return res.json({ plans: PlanService.listFalatuPlans() });
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

// POST /api/public/falatu/checkout → { organizationId, checkoutUrl }.
router.post("/checkout", async (req, res): Promise<any> => {
  try {
    const { name, email, phone, cpf, password, planId, acceptedTerms } = req.body || {};
    const out = await FalatuCheckoutService.start({ name, email, phone, cpf, password, planId, acceptedTerms });
    return res.json(out);
  } catch (error: any) {
    if (error instanceof FalatuCheckoutError) {
      return res.status(error.httpStatus).json({ error: error.code, message: error.message });
    }
    console.error("[FalatuCheckout] erro inesperado:", error);
    return res.status(500).json({ error: "internal_error" });
  }
});

export default router;
