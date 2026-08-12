/**
 * OperationalHealthService — PRD 7 / ADR-164 F5 (§6/§48, D1): Operational Health.
 *
 * NÃO duplica o `ProductionReadinessService` (CA20). Compõe a pirâmide do §6 num
 * snapshot único pro Admin Master:
 *   Configuration Readiness (JÁ EXISTE — reusa `ProductionReadinessService.report`)
 *   + Operational Health (NOVO — runtime F2 + SLI HTTP F3 + dependências F4)
 *   + Capacity Intelligence (F7+, ainda `not_available` — honesto).
 *
 * O estado operacional é derivado por limiar DETERMINÍSTICO e ABSOLUTO, marcado como
 * PROVISÓRIO: latência p95/p99 é REPORTADA mas NÃO classifica estado sozinha — isso
 * exige SLO/baseline (§14, F3.4/F6). Só o que dá pra julgar sem baseline entra no
 * estado: erro 5xx, event-loop lag e a saúde das dependências (F4).
 *
 * GUARDRAILS: RN-PRC-6 (sub-sinal indisponível → `unknown`, nunca "saúde"); §46
 * platform-global (Admin Master); RN-PRC-3 (só leitura/derivação). Determinístico.
 */
import { ProductionReadinessService } from "./ProductionReadinessService.js";
import { NodeHostTelemetryProvider } from "./NodeHostTelemetryProvider.js";
import { HttpMetricsCollector } from "./HttpMetricsCollector.js";
import { DependencyHealthService, HealthState } from "./DependencyHealthService.js";
import { SloDefinitionService } from "./SloDefinitionService.js";

// Limiares ABSOLUTOS e provisórios (até SLO/baseline os refinarem — §14/F6).
const EVENTLOOP_WATCH_MS = 50, EVENTLOOP_DEGRADED_MS = 200;
const ERR_WATCH_PCT = 1, ERR_DEGRADED_PCT = 5;

function worstKnown(states: Array<HealthState | "unknown">): HealthState {
  const order: HealthState[] = ["healthy", "watch", "degraded", "unavailable"];
  const known = states.filter((s): s is HealthState => s !== "unknown");
  return known.reduce((acc, s) => (order.indexOf(s) > order.indexOf(acc) ? s : acc), "healthy");
}

export class OperationalHealthService {
  // Um provider de runtime só-leitura (o monitor de event-loop é process-global).
  private static runtime = new NodeHostTelemetryProvider();

  static snapshot(opts: { now?: number } = {}): any {
    const now = opts.now ?? Date.now();

    // ── Configuration Readiness (reuso) ──
    const report = ProductionReadinessService.report();
    const configuration = {
      status: report.status, // ready | degraded | blocked
      blockersFailing: report.checks.filter((c: any) => c.level === "blocker" && !c.ok).length,
      recommendedFailing: report.checks.filter((c: any) => c.level === "recommended" && !c.ok).length,
    };

    // ── Runtime (F2) ──
    const m = (metric: string) => this.runtime.queryMetric({ metric });
    const eldR = m("proc.eventloop.lag.ms");
    const runtime = {
      rssBytes: m("proc.mem.rss").value,
      heapUsedBytes: m("proc.mem.heapUsed").value,
      eventLoopLagMs: eldR.available ? eldR.value : null,
      load1m: m("host.load.1m").value,
      hostMemUsedPct: m("host.mem.usedPct").value,
    };

    // ── Aplicação / SLI (F3) ──
    const sli = HttpMetricsCollector.snapshot({ now });
    const application = sli.available
      ? { available: true, rps: sli.rps, p95Ms: sli.latencyMs!.p95, p99Ms: sli.latencyMs!.p99, errorRatePct: sli.errorRatePct, sampleCount: sli.sampleCount }
      : { available: false, reason: sli.reason };

    // ── Dependências (F4) ──
    const dependencies = DependencyHealthService.snapshot({ now });

    // ── SLO (F3.4) — a latência p95 finalmente CLASSIFICA estado, mas só contra um alvo do
    // operador (§14). Sem SLO definido → sloState 'unknown' (não afeta o estado; a latência
    // segue só reportada, comportamento pré-F3.4). Com SLO → violação rebaixa o estado.
    const slo = SloDefinitionService.evaluate({
      p95Ms: sli.available ? sli.latencyMs!.p95 : null,
      errorRatePct: sli.available ? sli.errorRatePct : null,
    });
    const sloState: HealthState | "unknown" = !slo.defined ? "unknown"
      : slo.state === "degraded" ? "degraded" : slo.state === "watch" ? "watch"
      : slo.state === "ok" ? "healthy" : "unknown";

    // ── Estado operacional ──
    const runtimeState: HealthState | "unknown" = runtime.eventLoopLagMs == null ? "unknown"
      : runtime.eventLoopLagMs > EVENTLOOP_DEGRADED_MS ? "degraded"
      : runtime.eventLoopLagMs > EVENTLOOP_WATCH_MS ? "watch" : "healthy";
    const appState: HealthState | "unknown" = !sli.available ? "unknown"
      : sli.errorRatePct > ERR_DEGRADED_PCT ? "degraded"
      : sli.errorRatePct > ERR_WATCH_PCT ? "watch" : "healthy";
    const operationalState = worstKnown([runtimeState, appState, sloState, dependencies.overall]);

    return {
      configuration,
      operational: { state: operationalState, runtime, application, dependencies, slo },
      // Capacity Intelligence entra na F7+ e depende de baseline/ambiente — honesto.
      capacity: { state: "not_available", reason: "requires_baseline_and_env" },
      note: slo.defined
        ? "Operational Health com SLO: a latência p95 classifica estado contra o alvo do operador (§14, F3.4)."
        : "Operational Health provisório: latência p95/p99 é reportada mas não classifica estado sem SLO/baseline (§14, F3.4/F6). Defina o SLO em /api/admin/slo.",
      generatedAt: new Date(now).toISOString(),
    };
  }
}

export default OperationalHealthService;
