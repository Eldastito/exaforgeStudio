import type { Request, Response, NextFunction } from "express";
import { StorefrontShortLinkService } from "../StorefrontShortLinkService.js";

/**
 * GET /loja/:slug/go/:code — link curto de campanha (ADR-207 F5). PÚBLICO (cliente clicando no Instagram/WhatsApp),
 * então: nunca lança, nunca vaza se o código existe (código ruim cai na vitrine, igual a um válido arquivado) e só
 * redireciona para caminho INTERNO da própria loja (o destino é montado no servidor, nada vem do usuário).
 * 302 (não 301): o destino muda se o dono trocar o produto do link ou arquivar; cache permanente seria errado.
 */
export function storefrontGoHandler(req: Request, res: Response, next: NextFunction): void {
  try {
    const r = StorefrontShortLinkService.resolve(String(req.params.slug || ""), String(req.params.code || ""));
    if (!r) return next(); // loja inexistente/não publicada: 404 normal
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer-when-downgrade");
    res.redirect(302, r.path);
  } catch { next(); }
}
