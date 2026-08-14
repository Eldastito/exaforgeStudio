/**
 * TEST — Rate-limit de login DISTRIBUÍDO (SEC-F22 / A11/F8). Deterministico, com Redis FALSO.
 *
 * Prova, sem um Redis real, que o `DistributedLoginLimiter`:
 *   - trava apos N falhas e libera quando o TTL da trava expira (relogio controlado no fake);
 *   - COMPARTILHA o estado: falhas numa "instancia" travam em OUTRA instancia (mesmo Redis) —
 *     e o estado sobrevive a "restart" (nova instancia sobre o mesmo Redis);
 *   - `clear` libera;
 *   - se o Redis FALHA, cai pra memoria (login nao trava por causa do Redis);
 *   - sem cliente (clientFactory -> null), usa memoria (0-regressao).
 *
 * Uso: npm run test:security-login-ratelimit-redis
 */
import { DistributedLoginLimiter, RedisLike } from "../src/server/loginRateLimitRedis.js";

let failures = 0; const results: { name: string; ok: boolean }[] = [];
function check(name: string, ok: boolean) { results.push({ name, ok }); if (!ok) failures++; }

let clock = 1_000_000;

// Redis FALSO em memoria com TTL simulado pelo `clock`.
class FakeRedis implements RedisLike {
  store = new Map<string, { val: number; exp: number | null }>();
  private live(key: string) {
    const e = this.store.get(key);
    if (e && e.exp != null && e.exp <= clock) { this.store.delete(key); return undefined; }
    return e;
  }
  async incr(key: string) { const e = this.live(key); const val = (e?.val ?? 0) + 1; this.store.set(key, { val, exp: e?.exp ?? null }); return val; }
  async pexpire(key: string, ms: number) { const e = this.live(key); if (!e) return 0; e.exp = clock + ms; return 1; }
  async pttl(key: string) { const e = this.live(key); if (!e) return -2; if (e.exp == null) return -1; return e.exp - clock; }
  async del(...keys: string[]) { let n = 0; for (const k of keys) if (this.store.delete(k)) n++; return n; }
}

async function main() {
  const LOCK = 15 * 60 * 1000;

  // ── 1. Trava apos 5 e libera no TTL ──
  const redis = new FakeRedis();
  const factory = async () => redis;
  const lim = new DistributedLoginLimiter({ maxAttempts: 5, lockMs: LOCK, prefix: "t1", clientFactory: factory });
  for (let i = 0; i < 4; i++) await lim.registerFailure("a@b.com");
  check("1.1 4 falhas -> livre", (await lim.remainingMs("a@b.com")) === 0);
  await lim.registerFailure("a@b.com"); // 5a
  check("1.2 5a falha -> travado", (await lim.remainingMs("a@b.com")) > 0);
  clock += LOCK + 1;
  check("1.3 apos o TTL -> livre de novo", (await lim.remainingMs("a@b.com")) === 0);

  // ── 2. COMPARTILHADO: instancia B ve a trava criada pela instancia A (mesmo Redis) ──
  const redis2 = new FakeRedis();
  const A = new DistributedLoginLimiter({ maxAttempts: 3, lockMs: LOCK, prefix: "shared", clientFactory: async () => redis2 });
  const B = new DistributedLoginLimiter({ maxAttempts: 3, lockMs: LOCK, prefix: "shared", clientFactory: async () => redis2 });
  await A.registerFailure("x"); await A.registerFailure("x"); await A.registerFailure("x"); // trava na A
  check("2.1 instancia B ve a trava da A (estado compartilhado)", (await B.remainingMs("x")) > 0);
  // "restart": nova instancia sobre o MESMO Redis ainda ve a trava
  const C = new DistributedLoginLimiter({ maxAttempts: 3, lockMs: LOCK, prefix: "shared", clientFactory: async () => redis2 });
  check("2.2 apos 'restart' a trava persiste (durabilidade)", (await C.remainingMs("x")) > 0);
  await A.clear("x");
  check("2.3 clear numa instancia libera nas outras", (await B.remainingMs("x")) === 0);

  // ── 3. Redis FALHANDO -> cai pra memoria (login nao trava por causa do Redis) ──
  const brokenRedis: RedisLike = {
    incr: async () => { throw new Error("redis down"); },
    pexpire: async () => { throw new Error("redis down"); },
    pttl: async () => { throw new Error("redis down"); },
    del: async () => { throw new Error("redis down"); },
  };
  const limBroken = new DistributedLoginLimiter({ maxAttempts: 3, lockMs: LOCK, prefix: "brk", clientFactory: async () => brokenRedis });
  for (let i = 0; i < 3; i++) await limBroken.registerFailure("y");
  check("3.1 Redis fora -> fallback memoria ainda trava", (await limBroken.remainingMs("y")) > 0);

  // ── 4. Sem cliente (null) -> memoria pura (0-regressao) ──
  const limMem = new DistributedLoginLimiter({ maxAttempts: 2, lockMs: LOCK, prefix: "mem", clientFactory: async () => null });
  await limMem.registerFailure("z"); await limMem.registerFailure("z");
  check("4.1 sem Redis -> memoria trava apos N", (await limMem.remainingMs("z")) > 0);
  check("4.2 chave diferente intacta", (await limMem.remainingMs("outro")) === 0);

  const passed = results.filter((r) => r.ok).length;
  for (const r of results) if (!r.ok) console.log("  x " + r.name);
  console.log("\n" + (failures === 0 ? "OK" : "FAIL") + " security-login-ratelimit-redis: " + passed + "/" + results.length + " checks");
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
