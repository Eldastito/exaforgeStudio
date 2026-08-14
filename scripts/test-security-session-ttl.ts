/**
 * TEST — Configurable session TTL (achado A13). Determinístico, sem DB.
 *
 * Prova que `JWT_TTL` controla a validade do token de sessão, com default 24h (0-regressão)
 * e parsing seguro: só-dígitos vira NUMBER (segundos — senão o `jwt`/`ms` leria como
 * milissegundos), unidade vira string, valor inválido cai no default.
 *
 * Uso: npm run test:security-session-ttl
 */
import { resolveSessionJwtTtl } from "../src/server/config/secret.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

check("1.1 sem JWT_TTL → default '24h'", resolveSessionJwtTtl({}) === "24h");
check("1.2 vazio → default '24h'", resolveSessionJwtTtl({ JWT_TTL: "  " }) === "24h");
check("2.1 '8h' preservado como string", resolveSessionJwtTtl({ JWT_TTL: "8h" }) === "8h");
check("2.2 '30m' preservado", resolveSessionJwtTtl({ JWT_TTL: "30m" }) === "30m");
check("2.3 '7d' preservado", resolveSessionJwtTtl({ JWT_TTL: "7d" }) === "7d");
// só-dígitos → NUMBER (segundos), não string (evita ms interpretar como milissegundos)
const secs = resolveSessionJwtTtl({ JWT_TTL: "3600" });
check("3.1 '3600' vira number 3600 (segundos)", secs === 3600 && typeof secs === "number");
check("4.1 valor inválido 'banana' → default '24h'", resolveSessionJwtTtl({ JWT_TTL: "banana" }) === "24h");
check("4.2 unidade inválida '5y' → default '24h'", resolveSessionJwtTtl({ JWT_TTL: "5y" }) === "24h");
check("4.3 '8 h' (espaço) → default '24h'", resolveSessionJwtTtl({ JWT_TTL: "8 h" }) === "24h");

const passed = results.filter((r) => r.ok).length;
for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
console.log(`\n${failures === 0 ? "✅" : "❌"} security-session-ttl: ${passed}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);
