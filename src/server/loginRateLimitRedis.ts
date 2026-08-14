/**
 * loginRateLimitRedis — limitador de força-bruta de login DISTRIBUÍDO (SEC-F22 / A11/F8).
 *
 * O `LoginRateLimiter` in-memory (SEC-A10) tem duas limitações conhecidas: o bloqueio ZERA no
 * restart e NÃO é compartilhado entre instâncias. Aqui a mesma semântica roda sobre Redis
 * (compartilhado + durável), ATRÁS do MESMO encaixe que a SEC-A10 deixou pronto.
 *
 * Fail-safe (disponibilidade > tudo): se o Redis não estiver configurado (`REDIS_URL` vazio) ou
 * cair, cada operação CAI AUTOMÁTICO para um `LoginRateLimiter` in-memory — o login NUNCA trava
 * por causa do Redis. Sem `REDIS_URL` → comportamento idêntico ao de hoje (0-regressão).
 *
 * Semântica preservada: N falhas na janela → trava por `lockMs`; ao travar, zera o contador;
 * sucesso limpa. No Redis: `INCR` no contador (+`PEXPIRE` janela); ao atingir o teto, cria a
 * chave de trava (`PEXPIRE lockMs`) e zera o contador; `remainingMs` = `PTTL` da trava.
 */
import { LoginRateLimiter } from "./loginRateLimit.js";

/** Subconjunto do cliente Redis que usamos — `ioredis` satisfaz isto direto (e o teste mocka). */
export interface RedisLike {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<number>;
  pttl(key: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
}

export interface AsyncLoginLimiter {
  remainingMs(key: string): Promise<number>;
  registerFailure(key: string): Promise<void>;
  clear(key: string): Promise<void>;
}

export interface DistributedLoginLimiterOpts {
  maxAttempts?: number;
  lockMs?: number;
  prefix?: string;
  /** Resolve o cliente Redis (cacheado internamente). `null` = usar só memória. */
  clientFactory?: () => Promise<RedisLike | null>;
}

export class DistributedLoginLimiter implements AsyncLoginLimiter {
  private maxAttempts: number;
  private lockMs: number;
  private prefix: string;
  private fallback: LoginRateLimiter; // instância única — o estado em memória persiste
  private clientFactory: () => Promise<RedisLike | null>;
  private clientResolved = false;
  private client: RedisLike | null = null;

  constructor(opts: DistributedLoginLimiterOpts = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.lockMs = opts.lockMs ?? 15 * 60 * 1000;
    this.prefix = opts.prefix ?? "loginrl";
    this.fallback = new LoginRateLimiter({ maxAttempts: this.maxAttempts, lockMs: this.lockMs });
    this.clientFactory = opts.clientFactory ?? defaultRedisClientFactory;
  }

  private async redis(): Promise<RedisLike | null> {
    if (this.clientResolved) return this.client;
    this.clientResolved = true;
    try { this.client = await this.clientFactory(); } catch { this.client = null; }
    return this.client;
  }

  private countKey(k: string) { return `${this.prefix}:c:${k}`; }
  private lockKey(k: string) { return `${this.prefix}:l:${k}`; }

  async remainingMs(key: string): Promise<number> {
    const r = await this.redis();
    if (!r) return this.fallback.remainingMs(key);
    try {
      const ttl = await r.pttl(this.lockKey(key));
      return ttl > 0 ? ttl : 0;
    } catch { return this.fallback.remainingMs(key); }
  }

  async registerFailure(key: string): Promise<void> {
    const r = await this.redis();
    if (!r) return this.fallback.registerFailure(key);
    try {
      const c = await r.incr(this.countKey(key));
      if (c === 1) await r.pexpire(this.countKey(key), this.lockMs); // janela do contador
      if (c >= this.maxAttempts) {
        await r.incr(this.lockKey(key));                 // cria a chave de trava
        await r.pexpire(this.lockKey(key), this.lockMs); // com TTL = lockMs
        await r.del(this.countKey(key));                 // zera o contador (próxima janela recomeça)
      }
    } catch { this.fallback.registerFailure(key); }
  }

  async clear(key: string): Promise<void> {
    const r = await this.redis();
    if (!r) return this.fallback.clear(key);
    try { await r.del(this.countKey(key), this.lockKey(key)); }
    catch { this.fallback.clear(key); }
  }
}

// --- fábrica default do cliente Redis (opt-in por REDIS_URL) ---
let sharedClient: RedisLike | null = null;
let sharedTried = false;

async function defaultRedisClientFactory(): Promise<RedisLike | null> {
  if (sharedTried) return sharedClient;
  sharedTried = true;
  const url = process.env.REDIS_URL;
  if (!url) return null; // sem Redis configurado → memória (0-regressão)
  try {
    const mod: any = await import("ioredis");
    const IORedis = mod.default || mod;
    // maxRetriesPerRequest baixo: se o Redis estiver fora, a op falha rápido e cai pra memória
    // (o try/catch de cada método pega). enableOfflineQueue false evita empilhar comandos.
    sharedClient = new IORedis(url, { maxRetriesPerRequest: 1, enableOfflineQueue: false, lazyConnect: false }) as RedisLike;
    console.warn("[SECURITY] Rate-limit de login: usando Redis compartilhado/durável (REDIS_URL).");
  } catch (e) {
    console.error("[SECURITY] REDIS_URL definido, mas falhou ao iniciar o cliente Redis — caindo para memória.", e);
    sharedClient = null;
  }
  return sharedClient;
}
