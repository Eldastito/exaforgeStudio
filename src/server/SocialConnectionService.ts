/**
 * SocialConnectionService (PRD 10 / ADR-167 F2 — Social Connection Hub) — dono da
 * CONFIG e do ESTADO por-org de uma conexão de CANAL SOCIAL (Instagram/Facebook/
 * TikTok/…). Espelha DELIBERADAMENTE o `ReputationConnectorService` (ADR-162): isola o
 * transporte (o `SocialChannelProvider` da F1) do domínio e resolve, pra uma org, uma
 * instância de provider JÁ CONFIGURADA (ou o stub não-conectado que degrada — §6).
 *
 * SEGREDOS (RN-SI-05): `config_enc` é o JSON de credenciais CIFRADO campo-a-campo via
 * `EncryptionService` (AES-GCM, ADR-054). NUNCA devolvido cru numa rota — `status()`/
 * `list()` REDIGEM (só `hasToken`/escopos/capacidades/estado). O OAuth real (troca de
 * código→token) entra da F3 em diante; aqui a config é gravada server-side já cifrada.
 *
 * ESTADO OBSERVÁVEL (§5): `connection_state` reflete a saúde REAL do provider — token
 * vencido vira `auth_expired`, NUNCA "connected" (RN-SI: honestidade). CAPABILITY É
 * DESCOBERTA, não presumida (RN-SI-06): `capabilities_json` cacheia o que o provider
 * DECLAROU no último `health`, e as flags grossas (§7) derivam disso.
 *
 * REGRA (§42): este service NÃO cria segundo Scheduler/JobQueue/Decision/Approval Engine,
 * nem tabela de alerta paralela, nem 2º Estúdio. É só o hub de conexão (config+estado).
 * Isolamento multi-tenant (convenção #1): `orgId` é sempre o 1º arg; toda query filtra
 * `organization_id`; UNIQUE(org,channel) garante 1 conexão por canal por org.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import {
  SocialChannelProvider,
  SocialChannelCapability,
  SocialConnectionState,
  StubSocialChannelProvider,
  deriveCapabilityFlags,
  SocialChannelCapabilityFlags,
} from "./SocialChannelProvider.js";
import { InstagramChannelProvider } from "./InstagramChannelProvider.js";
import { FacebookChannelProvider } from "./FacebookChannelProvider.js";

interface ConnectionRow {
  id: string;
  organization_id: string;
  channel: string;
  provider: string;
  config_enc: string | null;
  capabilities_json: string | null;
  scopes_json: string | null;
  connection_state: string | null;
  state_detail: string | null;
  health_checked_at: string | null;
  enabled: number;
}

/** Status REDIGIDO — o que uma rota pode devolver (nunca vaza o token). */
export interface SocialConnectionStatus {
  channel: string;
  provider: string;
  configured: boolean;
  enabled: boolean;
  hasToken: boolean;
  scopes: string[];
  state: SocialConnectionState;
  stateDetail: string | null;
  capabilities: SocialChannelCapability[];
  capabilityFlags: SocialChannelCapabilityFlags;
  healthCheckedAt: string | null;
}

const KNOWN_CHANNELS = new Set(["instagram", "facebook", "tiktok", "linkedin", "youtube", "x", "stub"]);

export class SocialConnectionService {
  /** Canal é conhecido? (a rota valida forma; providers reais entram da F3). */
  static isKnownChannel(channel: string): boolean {
    return KNOWN_CHANNELS.has(channel);
  }

  private static row(orgId: string, channel: string): ConnectionRow | undefined {
    return db.prepare(`SELECT * FROM social_connections WHERE organization_id = ? AND channel = ?`).get(orgId, channel) as any;
  }

  /** Grava/atualiza a config de uma conexão (credenciais CIFRADAS). Opt-in. */
  static setConfig(
    orgId: string,
    channel: string,
    config: Record<string, any>,
    opts: { provider?: string; enabled?: boolean; scopes?: string[] } = {},
  ): { ok: true } {
    const existing = this.row(orgId, channel);
    const config_enc = EncryptionService.encrypt(JSON.stringify(config || {}));
    const scopes_json = opts.scopes ? JSON.stringify(opts.scopes) : null;
    if (existing) {
      db.prepare(
        `UPDATE social_connections SET config_enc = ?, provider = COALESCE(?, provider),
           scopes_json = COALESCE(?, scopes_json), enabled = COALESCE(?, enabled),
           updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(config_enc, opts.provider || null, scopes_json, opts.enabled == null ? null : opts.enabled ? 1 : 0, existing.id);
    } else {
      db.prepare(
        `INSERT INTO social_connections (id, organization_id, channel, provider, config_enc, scopes_json, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(randomUUID(), orgId, channel, opts.provider || "stub", config_enc, scopes_json, opts.enabled ? 1 : 0);
    }
    return { ok: true };
  }

  /** Config DECIFRADA (uso INTERNO — nunca exponha numa rota). */
  static getConfig(orgId: string, channel: string): Record<string, any> | null {
    const r = this.row(orgId, channel);
    if (!r || !r.config_enc) return null;
    const dec = EncryptionService.decrypt(r.config_enc);
    if (!dec) return null;
    try { return JSON.parse(dec); } catch { return null; }
  }

  private static parseCaps(json: string | null): SocialChannelCapability[] {
    if (!json) return [];
    try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; }
  }
  private static parseScopes(json: string | null): string[] {
    if (!json) return [];
    try { const a = JSON.parse(json); return Array.isArray(a) ? a : []; } catch { return []; }
  }

  /** Status REDIGIDO pra rota: nunca vaza o token, só se ele existe. */
  static status(orgId: string, channel: string): SocialConnectionStatus {
    const r = this.row(orgId, channel);
    const cfg = this.getConfig(orgId, channel);
    const caps = this.parseCaps(r?.capabilities_json || null);
    return {
      channel,
      provider: r?.provider || "stub",
      configured: !!(cfg && (cfg.token || cfg.accessToken || cfg.access_token)),
      enabled: !!(r && r.enabled),
      hasToken: !!(cfg && (cfg.token || cfg.accessToken || cfg.access_token)),
      scopes: this.parseScopes(r?.scopes_json || null),
      state: (r?.connection_state as SocialConnectionState) || "not_connected",
      stateDetail: r?.state_detail || null,
      capabilities: caps,
      capabilityFlags: deriveCapabilityFlags(caps),
      healthCheckedAt: r?.health_checked_at || null,
    };
  }

  /** Todas as conexões da org, REDIGIDAS (nunca vaza token). */
  static list(orgId: string): SocialConnectionStatus[] {
    const rows = db.prepare(`SELECT channel FROM social_connections WHERE organization_id = ? ORDER BY channel`).all(orgId) as any[];
    return rows.map((r) => this.status(orgId, r.channel));
  }

  /** Persiste o estado de conexão observável (§5). Best-effort, nunca lança. */
  static recordState(orgId: string, channel: string, state: SocialConnectionState, detail?: string | null): void {
    try {
      const existing = this.row(orgId, channel);
      if (existing) {
        db.prepare(`UPDATE social_connections SET connection_state = ?, state_detail = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(state, detail || null, existing.id);
      } else {
        db.prepare(`INSERT INTO social_connections (id, organization_id, channel, connection_state, state_detail) VALUES (?, ?, ?, ?, ?)`)
          .run(randomUUID(), orgId, channel, state, detail || null);
      }
    } catch { /* estado é best-effort */ }
  }

  /** Cacheia as capacidades DESCOBERTAS do provider (RN-SI-06). Best-effort. */
  static recordCapabilities(orgId: string, channel: string, caps: SocialChannelCapability[]): void {
    try {
      const existing = this.row(orgId, channel);
      const json = JSON.stringify(caps || []);
      if (existing) {
        db.prepare(`UPDATE social_connections SET capabilities_json = ?, health_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(json, existing.id);
      } else {
        db.prepare(`INSERT INTO social_connections (id, organization_id, channel, capabilities_json, health_checked_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`)
          .run(randomUUID(), orgId, channel, json);
      }
    } catch { /* best-effort */ }
  }

  /**
   * Resolve o PROVIDER configurado pra esta org/canal. Constrói uma instância FRESCA
   * (não a singleton do registry) com a config decifrada. Hoje só o `stub` existe;
   * providers reais (Instagram etc.) entram da F3 em diante e passam a ser construídos
   * aqui com a config decifrada. SEM config → stub não-conectado (degrada — §6),
   * NUNCA inventa transporte nem finge capacidade (RN-SI-06).
   *
   * As capacidades do stub podem ser moduladas por `config.capabilities` (hints
   * gravados na conexão), o que permite representar contas com capacidades diferentes
   * (uma conta lê mas não publica) sem tocar código.
   */
  static providerFor(orgId: string, channel: string): SocialChannelProvider {
    const r = this.row(orgId, channel);
    const providerName = r?.provider || "stub";
    const cfg = this.getConfig(orgId, channel) || {};
    // Provider REAL do Instagram (F3): rota só quando a conexão pede `instagram`
    // explicitamente. A credencial vem do `channels` (OAuth existente), não daqui —
    // sem 2ª tela de credenciais (§42). Default `stub` mantém 0-regressão (opt-in).
    if (channel === "instagram" && providerName === "instagram") {
      return new InstagramChannelProvider(orgId);
    }
    // Provider REAL do Facebook (F14): mesmo padrão do IG (opt-in, credencial no `channels`).
    if (channel === "facebook" && providerName === "facebook") {
      return new FacebookChannelProvider(orgId);
    }
    if (providerName === "stub" || !this.isKnownChannel(channel) || channel === "stub") {
      const c = cfg.capabilities || {};
      return new StubSocialChannelProvider({
        canPublish: c.canPublish,
        canSchedule: c.canSchedule,
        canAnalytics: c.canAnalytics,
        canAds: c.canAds,
        canCompetitor: c.canCompetitor,
      });
    }
    // Providers reais entram da F3; sem impl. registrada, degrada pro stub não-configurado.
    return new StubSocialChannelProvider({ canPublish: false, canSchedule: false, canAnalytics: false });
  }

  /**
   * Faz o passe de saúde: resolve o provider, chama `connect`+`health`, PERSISTE o
   * estado observável (§5) e as capacidades DESCOBERTAS (RN-SI-06), e devolve o status
   * REDIGIDO. Token vencido → `auth_expired`/`token_expiring`, nunca "connected".
   */
  static async refreshHealth(orgId: string, channel: string): Promise<SocialConnectionStatus> {
    const provider = this.providerFor(orgId, channel);
    const scopes = this.parseScopes(this.row(orgId, channel)?.scopes_json || null);
    try {
      await provider.connect({ orgId, scopes });
      const health = await provider.health();
      this.recordCapabilities(orgId, channel, provider.capabilities);
      this.recordState(orgId, channel, health.state, health.detail || null);
    } catch (e: any) {
      // Provider fora → estado honesto `unavailable`, nunca "connected".
      this.recordState(orgId, channel, "unavailable", String(e?.message || e));
    }
    return this.status(orgId, channel);
  }

  /** Desconecta: zera a config e marca `not_connected` (mantém a linha p/ histórico). */
  static disconnect(orgId: string, channel: string): { ok: true } {
    const existing = this.row(orgId, channel);
    if (existing) {
      db.prepare(
        `UPDATE social_connections SET config_enc = NULL, connection_state = 'not_connected',
           state_detail = NULL, enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).run(existing.id);
    }
    return { ok: true };
  }
}

export default SocialConnectionService;
