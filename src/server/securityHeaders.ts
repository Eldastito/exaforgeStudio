/**
 * securityHeaders — cabeçalhos HTTP de segurança centralizados (SEC-F11 / achado A15).
 *
 * Adiciona o que faltava (CSP, Referrer-Policy, Permissions-Policy) SEM quebrar o SPA:
 *  - CSP nasce em modo REPORT-ONLY (não bloqueia nada; só relata) — vira ENFORCING apenas sob
 *    `CSP_ENFORCE=1` (opt-in, mesmo padrão fail-closed do SEC-F2, depois de validar em report-only).
 *  - Permissions-Policy PERMITE camera/microphone do próprio site (Provador Virtual captura foto,
 *    mensagens de áudio usam o microfone) e nega o resto por padrão.
 *  - Mantém HSTS/nosniff/X-Frame-Options já existentes.
 *
 * Determinístico e injetável (`buildSecurityHeaders(env)`) — testável em CI.
 */

// Política permissiva o bastante pra não falsо-quebrar o SPA (estilos inline do React, imagens de
// chat/avatares, WebSocket), mas fechando `object-src`/`base-uri`/`frame-ancestors`.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'self'",
  "img-src 'self' data: blob: https:",
  "media-src 'self' data: blob: https:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
].join("; ");

export function buildSecurityHeaders(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const cspEnforce = /^(1|true|yes|on)$/i.test(String(env.CSP_ENFORCE || ""));
  const headers: Record<string, string> = {
    // já existentes (mantidos)
    "X-DNS-Prefetch-Control": "off",
    "X-Frame-Options": "SAMEORIGIN",
    "Strict-Transport-Security": "max-age=15552000; includeSubDomains",
    "X-Download-Options": "noopen",
    "X-Content-Type-Options": "nosniff",
    // novos (SEC-F11)
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()",
  };
  // CSP: enforcing sob opt-in; senão report-only (não quebra o SPA).
  headers[cspEnforce ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only"] = CSP_DIRECTIVES;
  return headers;
}
