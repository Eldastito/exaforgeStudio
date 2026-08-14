/**
 * corsConfig — cabeçalhos CORS centralizados e testáveis (SEC-F12 / achado A12).
 *
 * A auditoria apontou que `Access-Control-Allow-Headers` listava `x-organization-id`
 * mas OMITIA `Authorization` — o header de autenticação real (Bearer). Consumidores
 * externos (M2M) que mandam `Authorization` num request cross-origin batiam no
 * preflight. Aqui a lista passa a INCLUIR `Authorization`.
 *
 * Nota de segurança (SEC-02 / SEC-F4): `x-organization-id` segue ACEITO no preflight por
 * compatibilidade com consumidores legados, mas o backend NÃO o trata como autoridade de
 * tenant — o `organization_id` vem SEMPRE do JWT verificado (`resolveTokenOrg`). Anunciar
 * o header no CORS não o torna confiável; ele é apenas tolerado, nunca decisivo.
 *
 * Política de origem inalterada (0-regressão): em produção libera APENAS uma origem
 * explícita (`CORS_ORIGIN` || `APP_URL`) — nunca reflete o Host (falsificável); fora de
 * produção libera `*`. O SPA é servido pela MESMA origem, então não depende de CORS.
 *
 * Determinístico e injetável (`buildCorsHeaders(env)`) — testável em CI.
 */

/** Origem permitida pelo CORS. Vazio ('') = nenhuma (não emite cabeçalhos). */
export function corsAllowedOrigin(env: Record<string, string | undefined> = process.env): string {
  const isProd = env.NODE_ENV === "production";
  return isProd ? (env.CORS_ORIGIN || env.APP_URL || "") : "*";
}

/**
 * Mapa de cabeçalhos CORS a aplicar. Retorna `{}` quando não há origem permitida
 * (produção sem `CORS_ORIGIN`/`APP_URL` configurada) — nesse caso nada é liberado.
 */
export function buildCorsHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const allowed = corsAllowedOrigin(env);
  if (!allowed) return {};
  return {
    "Access-Control-Allow-Origin": allowed,
    Vary: "Origin",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, PATCH, DELETE",
    // A12: inclui Authorization (header de auth real). x-organization-id é tolerado
    // por compat, mas nunca é autoridade de tenant (SEC-02).
    "Access-Control-Allow-Headers": "Authorization,X-Requested-With,content-type,x-organization-id",
  };
}
