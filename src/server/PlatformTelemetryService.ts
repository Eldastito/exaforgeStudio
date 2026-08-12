/**
 * PlatformTelemetryService — PRD 7 / ADR-164 F1 (§9): a FACHADA de telemetria de
 * plataforma. Ponto único por onde o domínio consulta métricas normalizadas, sem
 * conhecer o provider concreto. Mantém um REGISTRY de providers (padrão: o Null da F1);
 * a F2+ registra o provider real (host/Prometheus/OTel) escolhido na F0-ambiente.
 *
 * PLATFORM-GLOBAL, NÃO per-tenant (RN-PRC-4/§46): telemetria de infra é do Admin Master;
 * o toggle e o provider ativo vivem em `platform_settings` (KV global), JAMAIS em
 * `organization_settings`. Sem a flag `platform_telemetry_enabled`, as consultas
 * respondem `available:false` (RN-PRC-6 — ausência nunca vira saúde). Determinístico,
 * sem gravar raw no SQLite (RN-PRC-3).
 */
import db from "./db.js";
import {
  PlatformTelemetryProvider, NullTelemetryProvider,
  MetricQuery, MetricResult, MetricRangeResult, TelemetryProviderHealth,
} from "./PlatformTelemetryContract.js";

const ENABLED_KEY = "platform_telemetry_enabled";   // '1' liga; default desligado
const PROVIDER_KEY = "platform_telemetry_provider"; // nome do provider ativo; default 'null'

export class PlatformTelemetryService {
  // Registry em memória. O Null está sempre presente (fallback honesto).
  private static providers = new Map<string, PlatformTelemetryProvider>([["null", new NullTelemetryProvider()]]);

  private static getSetting(key: string): string | null {
    const row = db.prepare("SELECT value FROM platform_settings WHERE key = ?").get(key) as any;
    return row ? row.value : null;
  }
  private static setSetting(key: string, value: string): void {
    db.prepare(`INSERT INTO platform_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).run(key, value);
  }

  static isEnabled(): boolean { return this.getSetting(ENABLED_KEY) === "1"; }
  static setEnabled(on: boolean): void { this.setSetting(ENABLED_KEY, on ? "1" : "0"); }

  /** Registra um provider real (F2+). Idempotente por nome. */
  static register(provider: PlatformTelemetryProvider): void {
    if (!provider?.name) throw new Error("Provider precisa de name.");
    this.providers.set(provider.name, provider);
  }

  /** Nomes registrados (observabilidade). */
  static registered(): string[] { return [...this.providers.keys()]; }

  /** Define o provider ativo (persistido). Recusa nome não registrado. */
  static setActiveProvider(name: string): void {
    if (!this.providers.has(name)) throw new Error(`Provider não registrado: ${name}.`);
    this.setSetting(PROVIDER_KEY, name);
  }

  /** O provider ativo — cai no Null se desligado, não configurado ou nome órfão. */
  static activeProvider(): PlatformTelemetryProvider {
    if (!this.isEnabled()) return this.providers.get("null")!;
    const name = this.getSetting(PROVIDER_KEY) || "null";
    return this.providers.get(name) || this.providers.get("null")!;
  }

  static queryMetric(query: MetricQuery): MetricResult { return this.activeProvider().queryMetric(query); }
  static queryRange(query: MetricQuery): MetricRangeResult { return this.activeProvider().queryRange(query); }

  /** Saúde da telemetria + contexto (flag/provider ativo) pro Admin Master. */
  static providerHealth(): TelemetryProviderHealth & { enabled: boolean; activeProvider: string } {
    const p = this.activeProvider();
    return { ...p.health(), enabled: this.isEnabled(), activeProvider: p.name };
  }

  /** Reset do registry pro estado da F1 (só Null) — usado em teste/reinit. */
  static resetProviders(): void {
    this.providers = new Map([["null", new NullTelemetryProvider()]]);
  }
}

export default PlatformTelemetryService;
