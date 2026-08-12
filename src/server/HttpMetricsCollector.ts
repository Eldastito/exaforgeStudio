/**
 * HttpMetricsCollector — PRD 7 / ADR-164 F3 (§14-15, §99): instrumentação de SLI HTTP.
 *
 * Mede a EXPERIÊNCIA de entrega (latência/erro por rota) no próprio processo — não
 * precisa de dado de infra. Guarda um BUFFER EM MEMÓRIA limitado (ring) das requisições
 * recentes e deriva, sob demanda, p50/p95/p99, rps e taxa de erro por classe de status.
 *
 * GUARDRAILS:
 *  - RN-PRC-3 (§11): raw NUNCA vai pro SQLite operacional — vive só em memória, bounded,
 *    efêmero; só AGREGADOS (snapshot) são expostos/persistidos (persistência é fase later).
 *  - RN-PRC-5 (§89/§90): controle de cardinalidade — a rota é NORMALIZADA (ids viram `:id`),
 *    nunca guarda URL com id, querystring, body, userId, telefone ou qualquer PII.
 *  - RN-PRC-6 (§15/§96): SLI NÃO é média — reporta p50/p95/p99; sem amostra → `available:false`.
 *  - §46: platform-global (não per-tenant) — é saúde de aplicação, do Admin Master.
 */

interface Sample { at: number; method: string; route: string; status: number; durationMs: number }

// Segmento de path que é um id (numérico, uuid, ou hex/token longo) → colapsa em ":id".
const ID_SEG = /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|[A-Za-z0-9_-]{22,})$/i;

function pct(sortedAsc: number[], p: number): number {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
}

export class HttpMetricsCollector {
  private static buf: Sample[] = [];
  private static maxSamples = 10000;   // teto do ring (memória bounded)

  /** Normaliza método+path pra uma chave de rota de baixa cardinalidade (sem ids/PII). */
  static normalizeRoute(method: string, path: string): string {
    const clean = String(path || "/").split("?")[0];
    const segs = clean.split("/").map((s) => (s && ID_SEG.test(s) ? ":id" : s));
    return `${String(method || "GET").toUpperCase()} ${segs.join("/") || "/"}`;
  }

  /** Registra uma requisição concluída. `at` injetável (determinismo). Nunca lança. */
  static record(s: { method: string; route: string; status: number; durationMs: number; at?: number }): void {
    try {
      this.buf.push({ at: s.at ?? Date.now(), method: s.method, route: s.route, status: Number(s.status) || 0, durationMs: Math.max(0, Number(s.durationMs) || 0) });
      if (this.buf.length > this.maxSamples) this.buf.splice(0, this.buf.length - this.maxSamples);
    } catch { /* instrumentação nunca afeta o fluxo */ }
  }

  /** SLI agregado numa janela. Sem amostra → available:false (RN-PRC-6). */
  static snapshot(opts: { windowMs?: number; now?: number; topRoutes?: number } = {}): {
    available: boolean; reason?: string;
    windowMs: number; sampleCount: number; rps: number;
    latencyMs: { p50: number; p95: number; p99: number; max: number } | null;
    errorRatePct: number; clientErrorRatePct: number;
    byStatusClass: Record<string, number>;
    slowestRoutes: Array<{ route: string; count: number; p95Ms: number }>;
    observedAt: string;
  } {
    const now = opts.now ?? Date.now();
    const windowMs = Math.max(1000, opts.windowMs ?? 5 * 60 * 1000);
    const from = now - windowMs;
    const win = this.buf.filter((s) => s.at >= from && s.at <= now);
    const observedAt = new Date(now).toISOString();
    if (!win.length) {
      return { available: false, reason: "no_data", windowMs, sampleCount: 0, rps: 0, latencyMs: null, errorRatePct: 0, clientErrorRatePct: 0, byStatusClass: {}, slowestRoutes: [], observedAt };
    }
    const durs = win.map((s) => s.durationMs).sort((a, b) => a - b);
    const cls = (st: number) => `${Math.floor(st / 100)}xx`;
    const byStatusClass: Record<string, number> = {};
    let e5 = 0, e4 = 0;
    for (const s of win) { const c = cls(s.status); byStatusClass[c] = (byStatusClass[c] || 0) + 1; if (s.status >= 500) e5++; else if (s.status >= 400) e4++; }

    // p95 por rota (top rotas mais lentas).
    const byRoute = new Map<string, number[]>();
    for (const s of win) { const a = byRoute.get(s.route) || []; a.push(s.durationMs); byRoute.set(s.route, a); }
    const slowestRoutes = [...byRoute.entries()]
      .map(([route, ds]) => ({ route, count: ds.length, p95Ms: Math.round(pct(ds.slice().sort((a, b) => a - b), 0.95) * 100) / 100 }))
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, opts.topRoutes ?? 5);

    const round2 = (n: number) => Math.round(n * 100) / 100;
    return {
      available: true, windowMs, sampleCount: win.length,
      rps: round2(win.length / (windowMs / 1000)),
      latencyMs: { p50: round2(pct(durs, 0.5)), p95: round2(pct(durs, 0.95)), p99: round2(pct(durs, 0.99)), max: round2(durs[durs.length - 1]) },
      errorRatePct: round2((e5 / win.length) * 100),
      clientErrorRatePct: round2((e4 / win.length) * 100),
      byStatusClass, slowestRoutes, observedAt,
    };
  }

  static size(): number { return this.buf.length; }
  static setMaxSamples(n: number): void { this.maxSamples = Math.max(1, n); }
  static reset(): void { this.buf = []; this.maxSamples = 10000; }
}

/**
 * Middleware Express que alimenta o coletor sem custo pro caminho da resposta:
 * mede em `res.on('finish')` (depois da resposta enviada) e nunca lança. Registra
 * SEMPRE em memória (barato, bounded); a EXPOSIÇÃO do snapshot é Admin Master (fase later).
 */
export function httpMetricsMiddleware(req: any, res: any, next: any): void {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    try {
      const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
      const route = HttpMetricsCollector.normalizeRoute(req.method, req.originalUrl || req.url || req.path || "/");
      HttpMetricsCollector.record({ method: req.method, route, status: res.statusCode, durationMs });
    } catch { /* instrumentação nunca afeta a resposta */ }
  });
  next();
}

export default HttpMetricsCollector;
