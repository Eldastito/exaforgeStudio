/**
 * ReputationConnectorService (ADR-162 / PRD 5 §66-§67, F2) — dono da CONFIG e do
 * ESTADO por-org de um conector de reputação (credenciais, cursor, health). Isola o
 * transporte (provider) do domínio: resolve, pra uma org, uma instância de provider
 * JÁ CONFIGURADA (ou o stub / um provider não-configurado que degrada).
 *
 * Segredos: `config_enc` é o JSON de config CIFRADO campo-a-campo via
 * `EncryptionService` (ADR-054). NUNCA devolvido cru numa rota — `status()` redige o
 * token. `cursor`/`last_synced_at` movem a leitura incremental (§70); `health_*`
 * guarda a saúde do conector (§67), sempre por org (convenção #1).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import { ReputationProvider } from "./ReputationProvider.js";
import { StubReputationProvider } from "./ReputationProvider.js";
import { ReclameAquiProvider, ReclameAquiConfig } from "./ReclameAquiProvider.js";

export type ReputationHealthStatus = "unknown" | "connected" | "auth_expired" | "rate_limited" | "degraded" | "unavailable";

interface ConnectorRow {
  id: string; organization_id: string; provider: string; config_enc: string | null;
  cursor: string | null; last_synced_at: string | null;
  health_status: string | null; health_detail: string | null; enabled: number;
}

export class ReputationConnectorService {
  private static row(orgId: string, provider: string): ConnectorRow | undefined {
    return db.prepare(`SELECT * FROM reputation_connectors WHERE organization_id = ? AND provider = ?`).get(orgId, provider) as any;
  }

  /** Grava/atualiza a config de um conector (credenciais CIFRADAS). Opt-in. */
  static setConfig(orgId: string, provider: string, config: Record<string, any>, opts: { enabled?: boolean } = {}): { ok: true } {
    const existing = this.row(orgId, provider);
    const config_enc = EncryptionService.encrypt(JSON.stringify(config || {}));
    if (existing) {
      db.prepare(`UPDATE reputation_connectors SET config_enc = ?, enabled = COALESCE(?, enabled), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(config_enc, opts.enabled == null ? null : (opts.enabled ? 1 : 0), existing.id);
    } else {
      db.prepare(`INSERT INTO reputation_connectors (id, organization_id, provider, config_enc, enabled) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), orgId, provider, config_enc, opts.enabled ? 1 : 0);
    }
    return { ok: true };
  }

  /** Config decifrada (uso INTERNO — nunca exponha numa rota). */
  static getConfig(orgId: string, provider: string): Record<string, any> | null {
    const r = this.row(orgId, provider);
    if (!r || !r.config_enc) return null;
    const dec = EncryptionService.decrypt(r.config_enc);
    if (!dec) return null;
    try { return JSON.parse(dec); } catch { return null; }
  }

  /** Status REDIGIDO pra rota: nunca vaza o token, só se ele existe. */
  static status(orgId: string, provider: string): {
    provider: string; configured: boolean; enabled: boolean; hasToken: boolean;
    cursor: string | null; lastSyncedAt: string | null; health: ReputationHealthStatus; healthDetail: string | null;
  } {
    const r = this.row(orgId, provider);
    const cfg = this.getConfig(orgId, provider);
    return {
      provider,
      configured: !!(cfg && cfg.baseUrl && cfg.token),
      enabled: !!(r && r.enabled),
      hasToken: !!(cfg && cfg.token),
      cursor: r?.cursor || null,
      lastSyncedAt: r?.last_synced_at || null,
      health: (r?.health_status as ReputationHealthStatus) || "unknown",
      healthDetail: r?.health_detail || null,
    };
  }

  static getCursor(orgId: string, provider: string): string | null { return this.row(orgId, provider)?.cursor || null; }

  static setCursor(orgId: string, provider: string, cursor: string | null): void {
    const existing = this.row(orgId, provider);
    if (existing) {
      db.prepare(`UPDATE reputation_connectors SET cursor = ?, last_synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(cursor, existing.id);
    } else {
      db.prepare(`INSERT INTO reputation_connectors (id, organization_id, provider, cursor, last_synced_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .run(randomUUID(), orgId, provider, cursor);
    }
  }

  /** Registra saúde do conector (§67) — best-effort, nunca lança. */
  static recordHealth(orgId: string, provider: string, status: ReputationHealthStatus, detail?: string | null): void {
    try {
      const existing = this.row(orgId, provider);
      if (existing) {
        db.prepare(`UPDATE reputation_connectors SET health_status = ?, health_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(status, detail || null, existing.id);
      } else {
        db.prepare(`INSERT INTO reputation_connectors (id, organization_id, provider, health_status, health_detail) VALUES (?, ?, ?, ?, ?)`)
          .run(randomUUID(), orgId, provider, status, detail || null);
      }
    } catch { /* health é best-effort */ }
  }

  /**
   * Resolve o PROVIDER configurado pra esta org. `stub` = provider determinístico
   * (shadow/teste). `reclame_aqui` = conector real com a config decifrada; SEM config
   * devolve um ReclameAquiProvider NÃO-CONFIGURADO (degrada — §6), nunca lança.
   */
  static providerFor(orgId: string, provider: string): ReputationProvider {
    if (provider === "stub") return new StubReputationProvider();
    if (provider === "reclame_aqui") {
      const cfg = this.getConfig(orgId, provider) as ReclameAquiConfig | null;
      return new ReclameAquiProvider(cfg && cfg.baseUrl && cfg.token ? cfg : null);
    }
    // Provider desconhecido → não-configurado (degrada), nunca inventa transporte.
    return new ReclameAquiProvider(null);
  }
}

export default ReputationConnectorService;
