/**
 * sessionMode — flag de build da sessão por COOKIE httpOnly no frontend (SEC-F24 Fase 2 / FE1).
 *
 * A Fase 1 (backend) já EMITE e ACEITA o token num cookie httpOnly `zf_session` (imune a XSS),
 * mantendo o header `Authorization` como primário. Esta Fase 2 muda o FRONTEND: quando ligada,
 * o app NÃO guarda mais o token (o segredo) no `localStorage` — confia no cookie httpOnly, que
 * o navegador envia sozinho (same-origin). Só o PERFIL do usuário (não-secreto: nome/e-mail/
 * papel/org) continua no `localStorage`, para reidratar a UI no refresh.
 *
 * DEFAULT OFF (0-regressão): sem a env, tudo segue como hoje (token no localStorage + header).
 * Ligue `VITE_COOKIE_SESSION=1` no build SÓ depois de validar no navegador: login, refresh
 * (reidratação via /api/auth/me pelo cookie), logout (limpa o cookie) e o socket reconectando
 * pelo cookie. Como é flag de BUILD (Vite), ligar/desligar exige rebuild — reversível.
 *
 * Por que build-time e não runtime: o front não lê config de runtime do servidor hoje; uma env
 * de build é o menor toque e é determinística. O deploy já rebuilda a imagem (Coolify/Docker).
 */
/** Parser puro do valor da flag (testável fora do navegador). */
export function parseCookieSessionFlag(raw: unknown): boolean {
  return /^(1|true|yes|on)$/i.test(String(raw ?? ""));
}

export const COOKIE_SESSION: boolean =
  typeof import.meta !== "undefined" &&
  parseCookieSessionFlag((import.meta as any).env?.VITE_COOKIE_SESSION);
