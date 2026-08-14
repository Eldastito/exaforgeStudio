/**
 * TEST — CORS headers (SEC-F12 / achado A12). Determinístico, sem DB/rede.
 *
 * Prova que:
 *  - `Access-Control-Allow-Headers` INCLUI `Authorization` (o header de auth real que faltava);
 *  - a política de origem NÃO regrediu (prod → origem explícita; dev → `*`);
 *  - produção SEM `CORS_ORIGIN`/`APP_URL` não libera nada (`{}` — nenhum cabeçalho).
 *
 * Uso: npm run test:security-cors
 */
import { buildCorsHeaders, corsAllowedOrigin } from "../src/server/corsConfig.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// ── 1. Authorization presente (A12) ──
const dev = buildCorsHeaders({ NODE_ENV: "development" });
check("1.1 dev libera origem '*'", dev["Access-Control-Allow-Origin"] === "*");
const allowHeaders = dev["Access-Control-Allow-Headers"] || "";
check("1.2 Allow-Headers inclui Authorization", /(^|,)\s*Authorization\s*(,|$)/i.test(allowHeaders));
check("1.3 Allow-Headers mantém content-type", /content-type/i.test(allowHeaders));
check("1.4 Allow-Headers tolera x-organization-id (compat)", /x-organization-id/i.test(allowHeaders));
check("1.5 Allow-Methods presente", (dev["Access-Control-Allow-Methods"] || "").includes("POST"));
check("1.6 Vary: Origin presente", dev["Vary"] === "Origin");

// ── 2. Produção: origem explícita, sem reflexão do Host ──
const prod = buildCorsHeaders({ NODE_ENV: "production", CORS_ORIGIN: "https://app.exemplo.com" });
check("2.1 prod usa CORS_ORIGIN", prod["Access-Control-Allow-Origin"] === "https://app.exemplo.com");
check("2.2 prod também expõe Authorization", /Authorization/i.test(prod["Access-Control-Allow-Headers"] || ""));

const prodApp = buildCorsHeaders({ NODE_ENV: "production", APP_URL: "https://app2.exemplo.com" });
check("2.3 prod cai para APP_URL quando não há CORS_ORIGIN", prodApp["Access-Control-Allow-Origin"] === "https://app2.exemplo.com");

// ── 3. Produção sem origem configurada → não libera nada ──
const prodNone = buildCorsHeaders({ NODE_ENV: "production" });
check("3.1 prod sem origem → mapa vazio", Object.keys(prodNone).length === 0);
check("3.2 corsAllowedOrigin('') em prod sem env", corsAllowedOrigin({ NODE_ENV: "production" }) === "");
check("3.3 corsAllowedOrigin('*') em dev", corsAllowedOrigin({ NODE_ENV: "development" }) === "*");

// ── relatório ──
const passed = results.filter((r) => r.ok).length;
for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
console.log(`\n${failures === 0 ? "✅" : "❌"} security-cors: ${passed}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);
