/**
 * NodeHostTelemetryProvider — PRD 7 / ADR-164 F2 (§12 Camadas 1-2, fatia PROCESSO/RUNTIME).
 *
 * Um provider REAL que satisfaz o contrato da F1 lendo APENAS o que o runtime Node observa
 * DIRETAMENTE (`os` + `process` + event-loop delay) — ZERO configuração, não depende de
 * nenhum dado de infra do operador e NÃO INVENTA nada. Entrega instantâneos de:
 *   - processo: RSS/heap/external, CPU acumulada, uptime, event-loop lag;
 *   - host visível ao Node: loadavg, memória total/livre, nº de CPUs.
 *
 * O que o Node NÃO vê (disco, rede, swap, limites de container, IOPS) é reportado
 * HONESTAMENTE como `available:false` + `requires_host_provider` (RN-PRC-6 — ausência
 * nunca vira saúde) — isso é a fatia de HOST/INFRA da F2, que espera o provider real
 * (host/Prometheus/OTel) e os dados de ambiente do operador.
 *
 * RN-PRC-3: leitura ao vivo, on-demand — NÃO persiste raw no SQLite. Séries temporais
 * (`queryRange`) exigem um TSDB de verdade; aqui o Node só dá instantâneos, então
 * `queryRange` responde `available:false`/`no_history` (honesto, não fabrica histórico).
 */
import os from "os";
import { monitorEventLoopDelay } from "perf_hooks";
import {
  PlatformTelemetryProvider, MetricQuery, MetricResult, MetricRangeResult, TelemetryProviderHealth,
} from "./PlatformTelemetryContract.js";

// Métricas instantâneas que o Node lê direto. Valor `null` → indisponível agora.
type Reader = () => number | null;

export class NodeHostTelemetryProvider implements PlatformTelemetryProvider {
  readonly name = "node_host";
  private eld: ReturnType<typeof monitorEventLoopDelay>;
  private readonly readers: Record<string, Reader>;

  constructor(private readonly nowFn: () => string = () => new Date().toISOString()) {
    // Monitor de event-loop delay (resolução 20ms). Acumula enquanto o processo vive.
    this.eld = monitorEventLoopDelay({ resolution: 20 });
    this.eld.enable();

    this.readers = {
      // ── processo (Camada 2) ──
      "proc.mem.rss": () => process.memoryUsage().rss,
      "proc.mem.heapUsed": () => process.memoryUsage().heapUsed,
      "proc.mem.heapTotal": () => process.memoryUsage().heapTotal,
      "proc.mem.external": () => process.memoryUsage().external,
      "proc.cpu.userUs": () => process.cpuUsage().user,
      "proc.cpu.systemUs": () => process.cpuUsage().system,
      "proc.uptime.s": () => Math.round(process.uptime()),
      // event-loop lag médio em ms; só quando há amostras (senão warming_up).
      "proc.eventloop.lag.ms": () => (this.eld.count > 0 ? Math.round((this.eld.mean / 1e6) * 100) / 100 : null),
      // ── host visível ao Node (fatia da Camada 1) ──
      "host.load.1m": () => os.loadavg()[0],
      "host.load.5m": () => os.loadavg()[1],
      "host.load.15m": () => os.loadavg()[2],
      "host.mem.total": () => os.totalmem(),
      "host.mem.free": () => os.freemem(),
      "host.mem.usedPct": () => { const t = os.totalmem(); return t > 0 ? Math.round(((t - os.freemem()) / t) * 10000) / 100 : null; },
      "host.cpu.count": () => os.cpus().length,
    };
  }

  /** Métricas que ESTE provider suporta (o resto exige o provider de host real). */
  supported(): string[] { return Object.keys(this.readers); }

  queryMetric(query: MetricQuery): MetricResult {
    const reader = this.readers[query.metric];
    if (!reader) {
      // Disco/rede/swap/limites de container: honesto — não é deste provider.
      return { metric: query.metric, available: false, value: null, observedAt: null, source: this.name, reason: "requires_host_provider" };
    }
    let value: number | null = null;
    try { value = reader(); } catch { value = null; }
    if (value == null || Number.isNaN(value)) {
      return { metric: query.metric, available: false, value: null, observedAt: null, source: this.name, reason: query.metric === "proc.eventloop.lag.ms" ? "warming_up" : "no_data" };
    }
    return { metric: query.metric, available: true, value, observedAt: this.nowFn(), source: this.name };
  }

  queryRange(query: MetricQuery): MetricRangeResult {
    // Node dá instantâneos, não histórico. Séries temporais exigem TSDB (provider real F2+).
    return { metric: query.metric, available: false, points: [], source: this.name, reason: "no_history" };
  }

  health(): TelemetryProviderHealth {
    // O processo é sempre legível — este provider está disponível por definição.
    return { available: true, source: this.name, checkedAt: this.nowFn() };
  }
}

export default NodeHostTelemetryProvider;
