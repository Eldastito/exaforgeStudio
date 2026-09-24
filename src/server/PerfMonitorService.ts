/**
 * PerfMonitorService — instrumentação LEVE pra achar a causa do "servidor
 * instável / API sem resposta". O backend roda tudo num único event-loop e o
 * better-sqlite3 é síncrono: qualquer rajada síncrona longa congela a API
 * inteira (inclusive o probe /api/health/ping). Este serviço MEDE isso, sem
 * mudar nenhum comportamento:
 *
 *   1) Lag do event-loop via perf_hooks.monitorEventLoopDelay (nativo do Node,
 *      custo desprezível): a cada 10s, se o loop travou acima do limiar, loga e
 *      guarda o evento.
 *   2) Requests lentas: o middleware (server.ts) chama recordRequest ao terminar
 *      cada request; acima do limiar vira log + evento.
 *
 * Os últimos eventos ficam num ring buffer em memória, expostos read-only em
 * GET /api/admin/perf (requireMasterAdmin) — o dono vê QUAL rota/tarefa trava
 * sem precisar de acesso ao host. Kill-switch: PERF_MONITOR_DISABLED=1.
 *
 * NÃO persiste em banco (não adiciona escrita ao processo que já sofre com I/O),
 * NÃO toca dado de tenant, NÃO altera resposta nenhuma.
 */
import { monitorEventLoopDelay, type IntervalHistogram, performance } from "perf_hooks";

export type PerfEvent = { at: number; kind: "request" | "loop"; label: string; ms: number };

const RING_MAX = 120;

class PerfMonitorImpl {
  private hist: IntervalHistogram | null = null;
  private ring: PerfEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly loopStallMs = Number(process.env.PERF_LOOP_STALL_MS) || 1000;
  private readonly slowReqMs = Number(process.env.PERF_SLOW_REQ_MS) || 1500;

  /** Kill-switch por env — desliga TODA a instrumentação sem redeploy de código. */
  disabled(): boolean {
    return /^(1|true|yes|on)$/i.test(String(process.env.PERF_MONITOR_DISABLED || ""));
  }

  /** Liga o histograma de lag + o relatório periódico. Idempotente. */
  start(): void {
    if (this.disabled() || this.timer) return;
    try {
      this.hist = monitorEventLoopDelay({ resolution: 20 });
      this.hist.enable();
    } catch { this.hist = null; }
    this.timer = setInterval(() => this.sampleLoop(), 10_000);
    // unref: o monitor NUNCA segura o processo vivo no shutdown.
    if (this.timer.unref) this.timer.unref();
  }

  /** Para o monitor (usado em teste). */
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    try { this.hist?.disable(); } catch { /* noop */ }
    this.hist = null;
  }

  private sampleLoop(): void {
    if (!this.hist) return;
    try {
      const maxMs = this.hist.max / 1e6;
      const p99Ms = this.hist.percentile(99) / 1e6;
      const meanMs = this.hist.mean / 1e6;
      this.hist.reset();
      if (maxMs >= this.loopStallMs) {
        const ev: PerfEvent = { at: Date.now(), kind: "loop", label: `p99=${p99Ms.toFixed(0)}ms mean=${meanMs.toFixed(0)}ms`, ms: Math.round(maxMs) };
        this.push(ev);
        console.warn(`[PERF] Event-loop travou até ${ev.ms}ms nos últimos 10s (${ev.label}) — alguma tarefa síncrona segurou o processo.`);
      }
    } catch { /* noop — instrumentação nunca derruba o servidor */ }
  }

  /** Chamado pelo middleware ao FIM de cada request. Só registra as lentas. */
  recordRequest(method: string, path: string, ms: number): void {
    if (this.disabled() || ms < this.slowReqMs) return;
    const label = `${method} ${String(path).slice(0, 120)}`;
    const ev: PerfEvent = { at: Date.now(), kind: "request", label, ms: Math.round(ms) };
    this.push(ev);
    console.warn(`[PERF] Request lenta ${label} levou ${ev.ms}ms (limiar ${this.slowReqMs}ms).`);
  }

  private push(ev: PerfEvent): void {
    this.ring.push(ev);
    if (this.ring.length > RING_MAX) this.ring.shift();
  }

  /** Leitura read-only pro endpoint admin. Não muda estado. */
  snapshot(): {
    enabled: boolean;
    thresholds: { loopStallMs: number; slowReqMs: number };
    loopNow: { maxMs: number; p99Ms: number; meanMs: number } | null;
    memoryRssMb: number;
    recent: PerfEvent[];
  } {
    let loopNow: { maxMs: number; p99Ms: number; meanMs: number } | null = null;
    if (this.hist) {
      try { loopNow = { maxMs: Math.round(this.hist.max / 1e6), p99Ms: Math.round(this.hist.percentile(99) / 1e6), meanMs: Math.round(this.hist.mean / 1e6) }; } catch { /* noop */ }
    }
    return {
      enabled: !this.disabled(),
      thresholds: { loopStallMs: this.loopStallMs, slowReqMs: this.slowReqMs },
      loopNow,
      memoryRssMb: Math.round(process.memoryUsage().rss / 1048576),
      recent: this.ring.slice().reverse(), // mais novo primeiro
    };
  }
}

export const PerfMonitor = new PerfMonitorImpl();
export { performance as perfNow };
export default PerfMonitor;
