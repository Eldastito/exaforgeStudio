/**
 * TEST — Login rate limiter (achado A10). Determinístico (relógio injetável), sem DB.
 *
 * Cobre a proteção de força-bruta que antes vivia solta em routes/auth.ts sem teste (SEC-10):
 *   - trava após N falhas dentro da janela; libera após o TTL;
 *   - sucesso limpa; chaves distintas (e-mails/IPs) são isoladas;
 *   - o teto por-IP (defesa opt-in contra rotação de e-mail) trava a rotação de e-mails
 *     vinda do MESMO IP mesmo com cada e-mail abaixo do próprio teto;
 *   - store plugável (o mesmo comportamento sobre um store customizado — encaixe p/ Redis).
 *
 * Uso: npm run test:security-login-ratelimit
 */
import { LoginRateLimiter, MemoryRateLimitStore, RateLimitStore, RateLimitRecord } from "../src/server/loginRateLimit.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

// Relógio controlável.
let clock = 1_000_000;
const now = () => clock;

// ── 1. Trava após 5 falhas; libera após 15min ──
const lim = new LoginRateLimiter({ maxAttempts: 5, lockMs: 15 * 60 * 1000, now });
for (let i = 0; i < 4; i++) lim.registerFailure("a@b.com");
check("1.1 4 falhas → ainda livre", lim.remainingMs("a@b.com") === 0);
lim.registerFailure("a@b.com"); // 5ª
check("1.2 5ª falha → travado", lim.remainingMs("a@b.com") > 0);
check("1.3 restante ~15min", Math.abs(lim.remainingMs("a@b.com") - 15 * 60 * 1000) < 1000);
clock += 15 * 60 * 1000 + 1;
check("1.4 após a janela → livre de novo", lim.remainingMs("a@b.com") === 0);

// ── 2. Sucesso limpa ──
const lim2 = new LoginRateLimiter({ maxAttempts: 3, lockMs: 1000, now });
lim2.registerFailure("x"); lim2.registerFailure("x");
lim2.clear("x");
lim2.registerFailure("x"); lim2.registerFailure("x");
check("2.1 clear reiniciou o contador (2 falhas pós-clear → livre)", lim2.remainingMs("x") === 0);

// ── 3. Isolamento entre chaves ──
const lim3 = new LoginRateLimiter({ maxAttempts: 2, lockMs: 1000, now });
lim3.registerFailure("e1"); lim3.registerFailure("e1"); // trava e1
check("3.1 e1 travado", lim3.remainingMs("e1") > 0);
check("3.2 e2 intacto", lim3.remainingMs("e2") === 0);

// ── 4. Teto por-IP pega rotação de e-mail (simulação da defesa opt-in) ──
// Cada e-mail tentado 1x (abaixo do teto por-e-mail de 5), mas todos do mesmo IP:
const emailLim = new LoginRateLimiter({ maxAttempts: 5, lockMs: 60_000, now });
const ipLim = new LoginRateLimiter({ maxAttempts: 20, lockMs: 60_000, now });
for (let i = 0; i < 20; i++) { emailLim.registerFailure(`user${i}@b.com`); ipLim.registerFailure("1.2.3.4"); }
check("4.1 nenhum e-mail sozinho travou (1 falha cada < 5)", emailLim.remainingMs("user0@b.com") === 0);
check("4.2 mas o IP travou (20 falhas ≥ teto)", ipLim.remainingMs("1.2.3.4") > 0);
check("4.3 outro IP intacto", ipLim.remainingMs("9.9.9.9") === 0);

// ── 5. Store plugável (encaixe p/ Redis) — mesmo comportamento sobre store customizado ──
class SpyStore implements RateLimitStore {
  inner = new MemoryRateLimitStore(); sets = 0;
  get(k: string) { return this.inner.get(k); }
  set(k: string, r: RateLimitRecord) { this.sets++; this.inner.set(k, r); }
  delete(k: string) { this.inner.delete(k); }
}
const spy = new SpyStore();
const lim5 = new LoginRateLimiter({ maxAttempts: 2, lockMs: 1000, store: spy, now });
lim5.registerFailure("k"); lim5.registerFailure("k");
check("5.1 usa o store injetado (writes registrados)", spy.sets === 2);
check("5.2 comportamento preservado sobre store custom (travou)", lim5.remainingMs("k") > 0);

const passed = results.filter((r) => r.ok).length;
for (const r of results) if (!r.ok) console.log(`  ✗ ${r.name}`);
console.log(`\n${failures === 0 ? "✅" : "❌"} security-login-ratelimit: ${passed}/${results.length} checks`);
process.exit(failures === 0 ? 0 : 1);
