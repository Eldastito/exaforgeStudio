import crypto from "crypto";

// Segredo único de assinatura/verificação de JWT, resolvido UMA vez no boot.
// - Em produção: exige a env JWT_SECRET. Se faltar, geramos um segredo aleatório
//   forte (em vez de cair num default fixo conhecido, que permitiria forjar tokens)
//   e avisamos — tokens deixarão de valer a cada restart até a env ser configurada.
// - Em dev: usa a env se houver, senão um aleatório por processo.
function resolveJwtSecret(): string {
  const fromEnv = process.env.JWT_SECRET;
  if (fromEnv && fromEnv.length >= 16) return fromEnv;

  if (process.env.NODE_ENV === "production") {
    console.warn(
      "[SECURITY] JWT_SECRET não configurado (ou muito curto). Gerando um segredo " +
      "aleatório efêmero — DEFINA JWT_SECRET no ambiente para que as sessões persistam " +
      "entre reinícios e para não invalidar tokens a cada deploy."
    );
  }
  return crypto.randomBytes(48).toString("hex");
}

export const JWT_SECRET = resolveJwtSecret();

// E-mail do administrador master (super-admin entre organizações). Configurável,
// com fallback para o dono original para não quebrar instalações existentes.
export const MASTER_ADMIN_EMAIL = process.env.MASTER_ADMIN_EMAIL || "eldastito@gmail.com";
