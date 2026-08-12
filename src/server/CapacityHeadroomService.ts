/**
 * CapacityHeadroomService — PRD 7 / ADR-164 F7 (§25-§27): headroom por recurso.
 *
 * Headroom = a FOLGA entre a operação atual e a zona insegura, **por recurso** — §26:
 * não existe headroom universal; cada recurso tem semântica própria. As zonas (§27) são
 * HEALTHY → OBSERVE → PLAN → ACT → CRITICAL.
 *
 * Escopo honesto: calcula só o que o processo já observa (memória do host em %, load por
 * core — Node dá `os.totalmem/freemem/loadavg/cpus`); recurso que exige o provider de
 * host (disco/rede/swap/limites de container) responde `not_available` (RN-PRC-6). O
 * `trend` vem do baseline da F6 quando há histórico; sem histórico → `insufficient_history`
 * (§59, não inventa). Limiares por-recurso são PROVISÓRIOS (refinados por baseline/VPS spec).
 * Determinístico; runtime injetável. Sem LLM (§56). Platform-global (§46).
 */
import { NodeHostTelemetryProvider } from "./NodeHostTelemetryProvider.js";
import { PlatformBaselineService } from "./PlatformBaselineService.js";
import { VpsSpecProfileService } from "./VpsSpecProfileService.js";

export type Zone = "HEALTHY" | "OBSERVE" | "PLAN" | "ACT" | "CRITICAL" | "NOT_AVAILABLE";
const ZONE_ORDER: Zone[] = ["HEALTHY", "OBSERVE", "PLAN", "ACT", "CRITICAL"];

interface Thresholds { observe: number; plan: number; act: number; critical: number }

// Modelo por-recurso (§26 — cada um com seus próprios limiares, provisórios).
const MODELS: Record<string, { unit: string; thresholds: Thresholds; baselineMetric: string; label: string }> = {
  "host.mem_used_pct": { unit: "%", label: "Memória do host", thresholds: { observe: 70, plan: 80, act: 88, critical: 94 }, baselineMetric: "host.mem_used_pct" },
  "host.load_per_core": { unit: "load/core", label: "CPU (load por core)", thresholds: { observe: 0.7, plan: 1.0, act: 1.5, critical: 2.0 }, baselineMetric: "host.load1m" },
};
// Recursos que dependem do provider de host (fatia host/infra da F2) — honesto.
const HOST_ONLY = ["disk.used_pct", "disk.io_saturation", "network.saturation", "host.swap_used", "container.cpu_limit", "container.mem_limit"];

const rt = new NodeHostTelemetryProvider();

export class CapacityHeadroomService {
  /** Classifica um valor numa zona pelo modelo do recurso (função pura, testável). */
  static zoneOf(value: number, t: Thresholds): Zone {
    if (value < t.observe) return "HEALTHY";
    if (value < t.plan) return "OBSERVE";
    if (value < t.act) return "PLAN";
    if (value < t.critical) return "ACT";
    return "CRITICAL";
  }

  private static worseZone(a: Zone, b: Zone): Zone {
    const ia = ZONE_ORDER.indexOf(a), ib = ZONE_ORDER.indexOf(b);
    if (ia < 0) return b; if (ib < 0) return a;
    return ib > ia ? b : a;
  }

  /** Snapshot de headroom por recurso. `runtime` e `spec` injetáveis (determinismo). */
  static snapshot(opts: { now?: number; runtime?: { memUsedPct?: number | null; load1m?: number | null; cpuCount?: number | null }; spec?: any } = {}): {
    resources: any[]; firstBottleneck: string | null; capacityContext: any; generatedAt: string;
  } {
    const now = opts.now ?? Date.now();
    // ADR-164 F2 (host/infra) — o VPS Spec Profile dá os limites REAIS. `cpuBasis` diz de
    // onde veio o nº de cores: 'spec' (container/vCPU do operador) > 'node' (os.cpus, que
    // sob container mente). Sem perfil → comportamento idêntico ao pré-F2 (honesto).
    const spec = opts.spec ?? VpsSpecProfileService.get();
    const specCpu = spec?.configured ? (spec.containerCpuLimit ?? spec.vcpu ?? null) : null;
    const memUsedPct = opts.runtime?.memUsedPct ?? rt.queryMetric({ metric: "host.mem.usedPct" }).value;
    const load1m = opts.runtime?.load1m ?? rt.queryMetric({ metric: "host.load.1m" }).value;
    const nodeCpu = opts.runtime?.cpuCount ?? rt.queryMetric({ metric: "host.cpu.count" }).value ?? 1;
    const cpuCount = specCpu ?? nodeCpu;
    const cpuBasis = specCpu != null ? "spec" : "node";

    const values: Record<string, number | null> = {
      "host.mem_used_pct": memUsedPct,
      "host.load_per_core": load1m != null && cpuCount ? load1m / cpuCount : null,
    };

    const resources: any[] = [];
    let worst: Zone = "HEALTHY"; let firstBottleneck: string | null = null;

    for (const [key, model] of Object.entries(MODELS)) {
      const v = values[key];
      if (v == null || !Number.isFinite(v)) {
        resources.push({ resource: key, label: model.label, available: false, zone: "NOT_AVAILABLE" as Zone, reason: "no_data" });
        continue;
      }
      const zone = this.zoneOf(v, model.thresholds);
      const headroomToCritical = Math.round((model.thresholds.critical - v) * 1000) / 1000;
      resources.push({
        resource: key, label: model.label, available: true, unit: model.unit,
        value: Math.round(v * 1000) / 1000, zone, headroomToCritical,
        thresholds: model.thresholds, provisional: true,
        trend: this.trendOf(model.baselineMetric, v, now),
        ...(key === "host.load_per_core" ? { cpuBasis, cpuCount } : {}),
      });
      if (this.worseZone(worst, zone) === zone && ZONE_ORDER.indexOf(zone) >= ZONE_ORDER.indexOf(worst)) {
        if (firstBottleneck == null || ZONE_ORDER.indexOf(zone) > ZONE_ORDER.indexOf(worst)) { worst = zone; firstBottleneck = key; }
      }
    }

    // Recursos que exigem o provider de host — declarados, não inventados (RN-PRC-6). Com o
    // VPS Spec Profile, o LIMITE fica conhecido (útil ao operador); o USO corrente ainda exige
    // provider de host, então segue not_available (honesto — não inventa uso).
    const limitOf: Record<string, number | null> = spec?.configured
      ? { "disk.used_pct": spec.storageGb, "container.cpu_limit": spec.containerCpuLimit, "container.mem_limit": spec.containerMemMb }
      : {};
    for (const key of HOST_ONLY) {
      const limit = limitOf[key] ?? null;
      resources.push({ resource: key, available: false, zone: "NOT_AVAILABLE" as Zone, reason: "requires_host_provider", ...(limit != null ? { configuredLimit: limit } : {}) });
    }

    // Contexto de capacidade a partir do VPS Spec Profile (denominadores reais).
    const capacityContext = spec?.configured
      ? {
          configured: true, cpuBasis, effectiveCpuCount: cpuCount,
          vcpu: spec.vcpu ?? null, ramMb: spec.ramMb ?? null, storageGb: spec.storageGb ?? null,
          containerCpuLimit: spec.containerCpuLimit ?? null, containerMemMb: spec.containerMemMb ?? null,
          orchestration: spec.orchestration ?? null,
          // Uso absoluto de memória DERIVADO do % medido × RAM do perfil (honesto: só se ambos existem).
          memUsedMb: (memUsedPct != null && spec.ramMb) ? Math.round((memUsedPct / 100) * spec.ramMb) : null,
        }
      : { configured: false, cpuBasis, effectiveCpuCount: cpuCount };

    return { resources, firstBottleneck, capacityContext, generatedAt: new Date(now).toISOString() };
  }

  /** Tendência vs baseline da F6: rising/below/within; sem histórico → insufficient_history. */
  private static trendOf(metric: string, current: number, now: number): { state: string; baselineP95?: number } {
    const b = PlatformBaselineService.baseline(metric, { now });
    if (!b.available) return { state: "insufficient_history" };
    if (current > b.p95) return { state: "rising_above_p95", baselineP95: b.p95 };
    if (current < b.mean) return { state: "below_baseline", baselineP95: b.p95 };
    return { state: "within_baseline", baselineP95: b.p95 };
  }
}

export default CapacityHeadroomService;
