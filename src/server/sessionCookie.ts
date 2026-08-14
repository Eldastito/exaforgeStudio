/**
 * sessionCookie — sessão por cookie httpOnly (SEC-F24 / achado FE1), FASE 1 (backend).
 *
 * Hoje o token de sessão vive no `localStorage` do navegador (legível por JS → um XSS
 * exfiltra a sessão). O caminho seguro é guardar o token num cookie **httpOnly** (que o JS
 * NÃO lê). Esta fase é ADITIVA e 0-regressão: o backend passa a EMITIR e ACEITAR o token no
 * cookie, mas o header `Authorization` continua funcionando (o front atual não muda) — a
 * migração do front (parar de usar localStorage) é a FASE 2, atrás de flag.
 *
 * CSRF: aceitar cookie para autenticar INTRODUZIRIA CSRF (o navegador manda o cookie sozinho).
 * Defesa: cookie `SameSite=Strict` + verificação de MESMA ORIGEM no servidor para métodos que
 * mudam estado quando a autenticação veio do COOKIE. Autenticação por HEADER é CSRF-safe por
 * natureza (um site atacante não consegue setar `Authorization`).
 */
import { SESSION_JWT_TTL } from "./config/secret.js";

export const SESSION_COOKIE = "zf_session";

interface HeaderCarrier { headers?: any; method?: string }

/** Token do header `Authorization: Bearer <t>`. */
export function bearerToken(req: HeaderCarrier): string | null {
  const h = req?.headers?.authorization;
  if (!h || typeof h !== "string") return null;
  const parts = h.split(" ");
  if (parts.length === 2 && /^bearer$/i.test(parts[0])) return parts[1] || null;
  return null;
}

/** Token do cookie httpOnly `zf_session` (parseado do header Cookie). */
export function cookieToken(req: HeaderCarrier, name = SESSION_COOKIE): string | null {
  const raw = req?.headers?.cookie;
  if (!raw || typeof raw !== "string") return null;
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) {
      try { return decodeURIComponent(part.slice(idx + 1).trim()); } catch { return part.slice(idx + 1).trim(); }
    }
  }
  return null;
}

export interface ResolvedToken { token: string | null; source: "header" | "cookie" | null }

/** Header primeiro (0-regressão), depois cookie. */
export function resolveRequestToken(req: HeaderCarrier): ResolvedToken {
  const b = bearerToken(req);
  if (b) return { token: b, source: "header" };
  const c = cookieToken(req);
  if (c) return { token: c, source: "cookie" };
  return { token: null, source: null };
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF para autenticação por COOKIE: métodos que mudam estado só passam se a requisição for
 * MESMA ORIGEM (Origin/Referer com o mesmo host). Um atacante cross-site não forja o Origin.
 * Métodos seguros (GET/HEAD/OPTIONS) sempre passam.
 */
export function cookieAuthCsrfOk(req: HeaderCarrier): boolean {
  const method = String(req?.method || "GET").toUpperCase();
  if (SAFE_METHODS.has(method)) return true;
  const host = String(req?.headers?.host || "");
  if (!host) return false;
  const origin = String(req?.headers?.origin || "");
  if (origin) { try { return new URL(origin).host === host; } catch { return false; } }
  const referer = String(req?.headers?.referer || req?.headers?.referrer || "");
  if (referer) { try { return new URL(referer).host === host; } catch { return false; } }
  return false; // muta estado por cookie sem Origin/Referer → recusa (conservador)
}

/** Validade do cookie em segundos, derivada do TTL do JWT (SEC-A13). */
export function cookieMaxAgeSec(ttl: string | number = SESSION_JWT_TTL): number {
  if (typeof ttl === "number") return ttl; // já em segundos
  const m = /^(\d+)([smhdw])$/.exec(String(ttl));
  if (!m) return 24 * 60 * 60;
  const mult: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return Number(m[1]) * (mult[m[2]] || 3600);
}

/** Valor do header Set-Cookie para GRAVAR a sessão. `Secure` só em produção. */
export function sessionCookieHeader(token: string, isProd = process.env.NODE_ENV === "production"): string {
  const parts = [`${SESSION_COOKIE}=${encodeURIComponent(token)}`, "HttpOnly", "Path=/", "SameSite=Strict", `Max-Age=${cookieMaxAgeSec()}`];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}

/** Valor do header Set-Cookie para LIMPAR a sessão (logout). */
export function clearSessionCookieHeader(isProd = process.env.NODE_ENV === "production"): string {
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (isProd) parts.push("Secure");
  return parts.join("; ");
}
