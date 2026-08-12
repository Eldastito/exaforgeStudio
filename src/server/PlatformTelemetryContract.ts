/**
 * PlatformTelemetryContract — PRD 7 / ADR-164 F1 (§9/§10): o contrato de telemetria
 * PROVIDER-AGNÓSTICO. O domínio do ZapFlow NUNCA se acopla a Prometheus/Coolify/OTel;
 * consome telemetria NORMALIZADA por trás desta interface. As implementações reais
 * (host/Prometheus/OTel) entram nas fases seguintes, escolhidas na F0-ambiente.
 *
 * GUARDRAIL RN-PRC-6 (§95/§96): telemetria ausente/stale NUNCA vira "saudável". Todo
 * ponto/série carrega `available` + `source` + `observedAt`; o provider padrão
 * (`NullTelemetryProvider`) responde honestamente `available:false` até haver um provider
 * real configurado. GUARDRAIL RN-PRC-3 (§11): este contrato é só LEITURA de telemetria —
 * o raw vive no backend de observabilidade, nunca no SQLite operacional.
 */

/** Uma amostra normalizada de uma métrica num instante. */
export interface MetricPoint {
  ts: string;             // ISO 8601 (UTC) do instante amostrado
  value: number;
}

/** Consulta de métrica: nome canônico + labels + janela opcional. */
export interface MetricQuery {
  metric: string;         // nome canônico normalizado (ex.: "host.cpu.util", "app.http.p95")
  labels?: Record<string, string>;
  /** Janela pra queryRange (ISO); ignorada em queryMetric (instantâneo). */
  from?: string;
  to?: string;
  stepSeconds?: number;
}

/** Resultado instantâneo (valor mais recente) — sempre com proveniência + frescor. */
export interface MetricResult {
  metric: string;
  available: boolean;     // false = sem dado/sem provider (RN-PRC-6 — nunca "saúde")
  value: number | null;
  observedAt: string | null;
  source: string;         // "null" | "prometheus" | "host" | ... (proveniência)
  reason?: string;        // quando available=false: por quê ("not_configured"|"stale"|"no_data")
}

/** Resultado de série temporal — mesma disciplina de proveniência/frescor. */
export interface MetricRangeResult {
  metric: string;
  available: boolean;
  points: MetricPoint[];
  source: string;
  reason?: string;
}

/** Saúde do próprio provider de telemetria (observabilidade da observabilidade). */
export interface TelemetryProviderHealth {
  available: boolean;     // o provider está acessível?
  source: string;
  reason?: string;
  checkedAt: string;
}

/**
 * O contrato. Uma implementação (host/Prometheus/OTel) o satisfaz; o domínio só conhece
 * esta forma. `name` é a proveniência que aparece em `source`.
 */
export interface PlatformTelemetryProvider {
  readonly name: string;
  queryMetric(query: MetricQuery): MetricResult;
  queryRange(query: MetricQuery): MetricRangeResult;
  health(): TelemetryProviderHealth;
}

/**
 * Provider PADRÃO — sem backend real. Responde SEMPRE `available:false` (nunca finge
 * saúde, RN-PRC-6). É o estado correto enquanto a F0-ambiente não fornecer os dados de
 * infra e a F2+ não plugar um provider real. `now` injetável (determinismo em teste).
 */
export class NullTelemetryProvider implements PlatformTelemetryProvider {
  readonly name = "null";
  constructor(private readonly nowFn: () => string = () => new Date().toISOString()) {}

  queryMetric(query: MetricQuery): MetricResult {
    return { metric: query.metric, available: false, value: null, observedAt: null, source: this.name, reason: "not_configured" };
  }
  queryRange(query: MetricQuery): MetricRangeResult {
    return { metric: query.metric, available: false, points: [], source: this.name, reason: "not_configured" };
  }
  health(): TelemetryProviderHealth {
    return { available: false, source: this.name, reason: "not_configured", checkedAt: this.nowFn() };
  }
}
