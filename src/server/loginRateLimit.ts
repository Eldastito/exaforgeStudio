/**
 * loginRateLimit — proteção de força-bruta do login, extraída e testável (achado A10).
 *
 * Antes a lógica vivia como um `Map` + funções soltas em `routes/auth.ts`, SEM cobertura de
 * teste (SEC-10 exige que segurança crítica vire regressão) e SEM ponto de extensão para um
 * store durável/compartilhado. Aqui ela vira uma classe determinística (relógio injetável)
 * sobre uma interface `RateLimitStore`:
 *   - `MemoryRateLimitStore` é o default (0-regressão: mesmo comportamento por-e-mail de antes);
 *   - um store durável/compartilhado (ex.: Redis) pode implementar a MESMA interface no futuro
 *     — o encaixe fica pronto. Enquanto in-memory: reinício limpa e não compartilha entre
 *     instâncias (limitação conhecida A10/A11; o fecho completo depende de infra).
 *
 * Semântica preservada: N falhas dentro da janela → trava por `lockMs`; ao travar, zera o
 * contador (a próxima janela recomeça limpa); sucesso limpa a chave.
 */

export interface RateLimitRecord { count: number; lockUntil: number; }

export interface RateLimitStore {
  get(key: string): RateLimitRecord | undefined;
  set(key: string, rec: RateLimitRecord): void;
  delete(key: string): void;
}

export class MemoryRateLimitStore implements RateLimitStore {
  private m = new Map<string, RateLimitRecord>();
  get(key: string) { return this.m.get(key); }
  set(key: string, rec: RateLimitRecord) { this.m.set(key, rec); }
  delete(key: string) { this.m.delete(key); }
}

export class LoginRateLimiter {
  private maxAttempts: number;
  private lockMs: number;
  private store: RateLimitStore;
  private now: () => number;

  constructor(opts: { maxAttempts?: number; lockMs?: number; store?: RateLimitStore; now?: () => number } = {}) {
    this.maxAttempts = opts.maxAttempts ?? 5;
    this.lockMs = opts.lockMs ?? 15 * 60 * 1000;
    this.store = opts.store ?? new MemoryRateLimitStore();
    this.now = opts.now ?? (() => Date.now());
  }

  /** Milissegundos restantes de trava para a chave (0 = não travada). */
  remainingMs(key: string): number {
    const rec = this.store.get(key);
    if (!rec) return 0;
    if (rec.lockUntil && this.now() < rec.lockUntil) return rec.lockUntil - this.now();
    return 0;
  }

  /** Registra uma falha; ao atingir `maxAttempts`, trava por `lockMs` e zera o contador. */
  registerFailure(key: string): void {
    const rec = this.store.get(key) || { count: 0, lockUntil: 0 };
    rec.count += 1;
    if (rec.count >= this.maxAttempts) {
      rec.lockUntil = this.now() + this.lockMs;
      rec.count = 0;
    }
    this.store.set(key, rec);
  }

  /** Sucesso: limpa o histórico da chave. */
  clear(key: string): void {
    this.store.delete(key);
  }
}
