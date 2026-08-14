/**
 * TEST — Security headers (SEC-F11 / achado A15). Puro/determinístico.
 *
 * Prova: CSP + Referrer-Policy + Permissions-Policy presentes; CSP nasce REPORT-ONLY (não quebra
 * o SPA) e vira ENFORCING só sob CSP_ENFORCE=1; Permissions-Policy permite camera/microphone do
 * próprio site; os headers antigos (HSTS/nosniff/X-Frame-Options) continuam.
 *
 * Uso: npm run test:security-headers
 */
let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

async function main() {
  const { buildSecurityHeaders } = await import("../src/server/securityHeaders.js");

  // ── 1. Report-only por padrão (não quebra o SPA) ──
  const def = buildSecurityHeaders({});
  check("1.1 CSP presente em REPORT-ONLY por padrão", typeof def["Content-Security-Policy-Report-Only"] === "string" && !def["Content-Security-Policy"]);
  check("1.2 CSP fecha object-src/base-uri/frame-ancestors", /object-src 'none'/.test(def["Content-Security-Policy-Report-Only"]) && /base-uri 'self'/.test(def["Content-Security-Policy-Report-Only"]) && /frame-ancestors 'self'/.test(def["Content-Security-Policy-Report-Only"]));

  // ── 2. CSP_ENFORCE=1 → vira enforcing ──
  const enf = buildSecurityHeaders({ CSP_ENFORCE: "1" });
  check("2.1 CSP_ENFORCE=1 → header enforcing (sem report-only)", typeof enf["Content-Security-Policy"] === "string" && !enf["Content-Security-Policy-Report-Only"]);

  // ── 3. Novos headers presentes ──
  check("3.1 Referrer-Policy presente", def["Referrer-Policy"] === "strict-origin-when-cross-origin");
  check("3.2 Permissions-Policy presente", typeof def["Permissions-Policy"] === "string");
  check("3.3 Permissions-Policy permite camera/microphone do próprio site (Provador/áudio)", /camera=\(self\)/.test(def["Permissions-Policy"]) && /microphone=\(self\)/.test(def["Permissions-Policy"]));
  check("3.4 Permissions-Policy nega geolocation", /geolocation=\(\)/.test(def["Permissions-Policy"]));

  // ── 4. Headers antigos mantidos ──
  check("4.1 HSTS mantido", /max-age=/.test(def["Strict-Transport-Security"]));
  check("4.2 nosniff mantido", def["X-Content-Type-Options"] === "nosniff");
  check("4.3 X-Frame-Options mantido", def["X-Frame-Options"] === "SAMEORIGIN");

  // ── relatório ──
  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
  console.log(`\n${failures === 0 ? "✅" : "❌"} security-headers: ${passed}/${results.length} checks`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
