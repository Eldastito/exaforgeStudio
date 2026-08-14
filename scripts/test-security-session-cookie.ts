/**
 * TEST — Sessão por cookie httpOnly (SEC-F24 / achado FE1), FASE 1 (backend). Determinístico.
 *
 * Prova, sem servidor HTTP, que os helpers de `sessionCookie.ts`:
 *   - extraem o token do header `Authorization` e do cookie `zf_session`;
 *   - dão PRECEDÊNCIA ao header (0-regressão pro front atual);
 *   - a defesa CSRF só passa métodos que mudam estado quando a origem é a MESMA;
 *   - o header Set-Cookie de gravar é HttpOnly + SameSite=Strict + Max-Age (+ Secure em prod);
 *   - o header de limpar zera o cookie (Max-Age=0);
 *   - o Max-Age deriva corretamente do TTL do JWT.
 *
 * Uso: npm run test:security-session-cookie
 */
import {
  SESSION_COOKIE,
  bearerToken,
  cookieToken,
  resolveRequestToken,
  cookieAuthCsrfOk,
  cookieMaxAgeSec,
  sessionCookieHeader,
  clearSessionCookieHeader,
} from "../src/server/sessionCookie.js";
import { parseCookieSessionFlag } from "../src/lib/sessionMode.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

function main() {
  // ── 1. Extração de token ──
  check("1.1 bearer do header", bearerToken({ headers: { authorization: "Bearer abc123" } }) === "abc123");
  check("1.2 bearer case-insensitive", bearerToken({ headers: { authorization: "bearer xyz" } }) === "xyz");
  check("1.3 sem header -> null", bearerToken({ headers: {} }) === null);
  check("1.4 header malformado -> null", bearerToken({ headers: { authorization: "Basic zzz" } }) === null);
  check("1.5 cookie zf_session", cookieToken({ headers: { cookie: `${SESSION_COOKIE}=tok9; outro=1` } }) === "tok9");
  check("1.6 cookie no meio da lista", cookieToken({ headers: { cookie: `a=1; ${SESSION_COOKIE}=meio; b=2` } }) === "meio");
  check("1.7 cookie url-encoded decodifica", cookieToken({ headers: { cookie: `${SESSION_COOKIE}=a%20b` } }) === "a b");
  check("1.8 sem cookie -> null", cookieToken({ headers: {} }) === null);
  check("1.9 cookie ausente na lista -> null", cookieToken({ headers: { cookie: "outro=1; mais=2" } }) === null);

  // ── 2. Precedência: header primeiro, cookie fallback ──
  const both = resolveRequestToken({ headers: { authorization: "Bearer H", cookie: `${SESSION_COOKIE}=C` } });
  check("2.1 header vence o cookie", both.token === "H" && both.source === "header");
  const onlyCookie = resolveRequestToken({ headers: { cookie: `${SESSION_COOKIE}=C` } });
  check("2.2 só cookie -> source cookie", onlyCookie.token === "C" && onlyCookie.source === "cookie");
  const none = resolveRequestToken({ headers: {} });
  check("2.3 nenhum -> token null / source null", none.token === null && none.source === null);

  // ── 3. CSRF (só relevante quando a autenticação veio do cookie) ──
  check("3.1 GET sempre passa", cookieAuthCsrfOk({ method: "GET", headers: { host: "app.com" } }) === true);
  check("3.2 HEAD/OPTIONS passam", cookieAuthCsrfOk({ method: "OPTIONS", headers: { host: "app.com" } }) === true);
  check("3.3 POST mesma origem (Origin) passa",
    cookieAuthCsrfOk({ method: "POST", headers: { host: "app.com", origin: "https://app.com" } }) === true);
  check("3.4 POST origem diferente RECUSA",
    cookieAuthCsrfOk({ method: "POST", headers: { host: "app.com", origin: "https://evil.com" } }) === false);
  check("3.5 POST via Referer mesma origem passa",
    cookieAuthCsrfOk({ method: "POST", headers: { host: "app.com", referer: "https://app.com/x" } }) === true);
  check("3.6 POST Referer diferente RECUSA",
    cookieAuthCsrfOk({ method: "POST", headers: { host: "app.com", referer: "https://evil.com/x" } }) === false);
  check("3.7 POST sem Origin/Referer RECUSA (conservador)",
    cookieAuthCsrfOk({ method: "POST", headers: { host: "app.com" } }) === false);
  check("3.8 POST sem host RECUSA",
    cookieAuthCsrfOk({ method: "POST", headers: { origin: "https://app.com" } }) === false);
  check("3.9 Origin com porta diferente conta como host diferente",
    cookieAuthCsrfOk({ method: "POST", headers: { host: "app.com", origin: "https://app.com:8443" } }) === false);

  // ── 4. Max-Age derivado do TTL ──
  check("4.1 TTL numérico = segundos", cookieMaxAgeSec(3600) === 3600);
  check("4.2 TTL '24h' = 86400s", cookieMaxAgeSec("24h") === 86400);
  check("4.3 TTL '30m' = 1800s", cookieMaxAgeSec("30m") === 1800);
  check("4.4 TTL '7d' = 604800s", cookieMaxAgeSec("7d") === 604800);
  check("4.5 TTL inválido -> default 24h", cookieMaxAgeSec("banana") === 86400);

  // ── 5. Header Set-Cookie de gravar ──
  const setDev = sessionCookieHeader("TKN", false);
  check("5.1 grava o nome/valor do cookie", setDev.startsWith(`${SESSION_COOKIE}=TKN`));
  check("5.2 HttpOnly presente", /(?:^|;\s*)HttpOnly(?:;|$)/.test(setDev));
  check("5.3 SameSite=Strict presente", /SameSite=Strict/.test(setDev));
  check("5.4 Path=/ presente", /Path=\//.test(setDev));
  check("5.5 Max-Age presente", /Max-Age=\d+/.test(setDev));
  check("5.6 dev NÃO tem Secure", !/;\s*Secure/.test(setDev));
  const setProd = sessionCookieHeader("TKN", true);
  check("5.7 prod TEM Secure", /;\s*Secure/.test(setProd));
  check("5.8 valor é url-encoded", sessionCookieHeader("a b", false).startsWith(`${SESSION_COOKIE}=a%20b`));

  // ── 6. Header de limpar (logout) ──
  const clr = clearSessionCookieHeader(false);
  check("6.1 limpa com Max-Age=0", /Max-Age=0/.test(clr));
  check("6.2 limpa mantém HttpOnly", /HttpOnly/.test(clr));
  check("6.3 limpa mantém nome do cookie", clr.startsWith(`${SESSION_COOKIE}=`));

  // ── 7. Flag de build da Fase 2 (parser puro) — default OFF (0-regressão) ──
  check("7.1 '1' liga", parseCookieSessionFlag("1") === true);
  check("7.2 'true'/'on'/'yes' ligam", parseCookieSessionFlag("true") && parseCookieSessionFlag("on") && parseCookieSessionFlag("yes"));
  check("7.3 vazio/undefined = OFF (default)", parseCookieSessionFlag("") === false && parseCookieSessionFlag(undefined) === false);
  check("7.4 '0'/'false' = OFF", parseCookieSessionFlag("0") === false && parseCookieSessionFlag("false") === false);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log("  x " + r.name);
  console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-session-cookie: " + passed + "/" + results.length + " checks");
  process.exit(failures === 0 ? 0 : 1);
}
main();
