import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";

/**
 * Conector Alterdata/ModaUp — FUNDAÇÃO (ADR-105).
 *
 * Guarda a config da integração por organização (com segredos CIFRADOS), resolve
 * as base URLs por módulo e mantém o cursor do delta-sync por versão. É a base
 * plugável: NÃO faz chamadas HTTP à ModaUp ainda — a autenticação real (emissão/
 * renovação do token) e os jobs de sincronização entram na Fase 1, quando a
 * Alterdata fornecer o contrato do token + o ambiente de homologação.
 *
 * Segurança: `auth_config` e `access_token` nunca trafegam em texto para fora
 * (ver `publicSettings`); o token é decifrado só no momento do uso. Nada roda
 * enquanto `enabled = 0` (padrão).
 */

// Os microserviços da ModaUp e o subdomínio padrão (o base_pattern substitui
// {module} por estes valores). rede/filial vão nos paths, não aqui.
export const ALTERDATA_MODULES: Record<string, string> = {
  supply: "supply",
  price: "price",
  crm: "crm",
  sales: "sales",
  ecommerce: "ecommerce",
  tributario: "tributary",
  receber: "receber",
  logistic: "logistic",
  purchase: "purchase",
  humanresources: "humanresources",
  financial: "financial",
};

export interface AlterdataSettingsInput {
  enabled?: boolean;
  environment?: "homolog" | "prod";
  rede?: string | null;
  filiais?: string[];
  basePattern?: string | null;        // ex.: 'toulon-{module}.apimodaup.com.br'
  moduleBaseUrls?: Record<string, string>;
  authConfig?: Record<string, any> | null; // client_id/secret ou api key — cifrado
  syncIntervalMinutes?: number;
}

export class AlterdataConnectorService {
  private static row(orgId: string): any {
    return db.prepare(`SELECT * FROM alterdata_integration_settings WHERE organization_id = ?`).get(orgId) as any;
  }

  static isEnabled(orgId: string): boolean {
    const r = this.row(orgId);
    return !!(r && r.enabled);
  }

  /** Cria/atualiza a config. Cifra os segredos antes de gravar. */
  static saveSettings(orgId: string, input: AlterdataSettingsInput): void {
    const cur = this.row(orgId);
    const next = {
      enabled: input.enabled != null ? (input.enabled ? 1 : 0) : (cur?.enabled ?? 0),
      environment: input.environment && ["homolog", "prod"].includes(input.environment) ? input.environment : (cur?.environment ?? "homolog"),
      rede: input.rede !== undefined ? (input.rede || null) : (cur?.rede ?? null),
      filiais_json: input.filiais !== undefined ? JSON.stringify(input.filiais || []) : (cur?.filiais_json ?? null),
      base_pattern: input.basePattern !== undefined ? (input.basePattern || null) : (cur?.base_pattern ?? null),
      module_base_urls_json: input.moduleBaseUrls !== undefined ? JSON.stringify(input.moduleBaseUrls || {}) : (cur?.module_base_urls_json ?? null),
      // Segredo cifrado: só reescreve se veio no input (null explícito limpa).
      auth_config_enc: input.authConfig !== undefined ? (input.authConfig ? EncryptionService.encrypt(JSON.stringify(input.authConfig)) : null) : (cur?.auth_config_enc ?? null),
      sync_interval_minutes: input.syncIntervalMinutes != null ? Math.max(1, Math.floor(input.syncIntervalMinutes)) : (cur?.sync_interval_minutes ?? 15),
    };
    if (cur) {
      db.prepare(
        `UPDATE alterdata_integration_settings SET enabled=?, environment=?, rede=?, filiais_json=?, base_pattern=?, module_base_urls_json=?, auth_config_enc=?, sync_interval_minutes=?, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`
      ).run(next.enabled, next.environment, next.rede, next.filiais_json, next.base_pattern, next.module_base_urls_json, next.auth_config_enc, next.sync_interval_minutes, orgId);
    } else {
      db.prepare(
        `INSERT INTO alterdata_integration_settings (organization_id, enabled, environment, rede, filiais_json, base_pattern, module_base_urls_json, auth_config_enc, sync_interval_minutes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(orgId, next.enabled, next.environment, next.rede, next.filiais_json, next.base_pattern, next.module_base_urls_json, next.auth_config_enc, next.sync_interval_minutes);
    }
  }

  /** Visão SEM segredos (para a UI/API) — nunca devolve token/credencial em texto. */
  static publicSettings(orgId: string): any {
    const r = this.row(orgId);
    if (!r) {
      return { configured: false, enabled: false, environment: "homolog", rede: null, filiais: [], hasCredentials: false, hasToken: false, tokenExpiresAt: null, syncIntervalMinutes: 15, modules: Object.keys(ALTERDATA_MODULES) };
    }
    let filiais: string[] = [];
    try { filiais = JSON.parse(r.filiais_json || "[]"); } catch { /* noop */ }
    return {
      configured: true,
      enabled: !!r.enabled,
      environment: r.environment || "homolog",
      rede: r.rede || null,
      filiais,
      basePattern: r.base_pattern || null,
      hasCredentials: !!r.auth_config_enc,
      hasToken: !!r.access_token_enc,
      tokenExpiresAt: r.token_expires_at || null,
      syncIntervalMinutes: r.sync_interval_minutes || 15,
      modules: Object.keys(ALTERDATA_MODULES),
    };
  }

  /** Credencial decifrada (client_id/secret ou api key) — uso interno na Fase 1. */
  static getAuthConfig(orgId: string): Record<string, any> | null {
    const r = this.row(orgId);
    if (!r?.auth_config_enc) return null;
    const dec = EncryptionService.decrypt(r.auth_config_enc);
    if (!dec) return null;
    try { return JSON.parse(dec); } catch { return null; }
  }

  /** Grava o token corrente (cifrado) + validade. Chamado pela rotina de auth (Fase 1). */
  static setAccessToken(orgId: string, token: string, expiresAt: Date | string | null): void {
    if (!this.row(orgId)) this.saveSettings(orgId, {}); // garante a linha
    const exp = expiresAt ? (typeof expiresAt === "string" ? expiresAt : expiresAt.toISOString()) : null;
    db.prepare(`UPDATE alterdata_integration_settings SET access_token_enc=?, token_expires_at=?, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`)
      .run(EncryptionService.encrypt(token), exp, orgId);
  }

  /** Token válido decifrado, ou null se ausente/expirado. NÃO renova (Fase 1). */
  static getAccessToken(orgId: string): string | null {
    const r = this.row(orgId);
    if (!r?.access_token_enc) return null;
    if (r.token_expires_at && new Date(r.token_expires_at).getTime() <= Date.now()) return null;
    return EncryptionService.decrypt(r.access_token_enc);
  }

  /** Base URL (https) de um módulo, a partir do override ou do base_pattern. */
  static moduleBaseUrl(orgId: string, moduleKey: string): string | null {
    const sub = ALTERDATA_MODULES[moduleKey];
    if (!sub) return null;
    const r = this.row(orgId);
    if (r?.module_base_urls_json) {
      try { const map = JSON.parse(r.module_base_urls_json); if (map[moduleKey]) return String(map[moduleKey]).replace(/\/$/, ""); } catch { /* noop */ }
    }
    const pattern = r?.base_pattern;
    if (!pattern) return null;
    const host = String(pattern).replace("{module}", sub);
    return `https://${host.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }

  // ---- cursor do delta-sync ----

  static getCursor(orgId: string, module: string, resource: string, filial = ""): string {
    const r = db.prepare(`SELECT version FROM alterdata_sync_cursors WHERE organization_id=? AND module=? AND resource=? AND filial=?`).get(orgId, module, resource, filial) as any;
    return r?.version ?? "0";
  }

  static setCursor(orgId: string, module: string, resource: string, filial: string, version: string | number): void {
    const v = String(version);
    const existing = db.prepare(`SELECT id FROM alterdata_sync_cursors WHERE organization_id=? AND module=? AND resource=? AND filial=?`).get(orgId, module, resource, filial) as any;
    if (existing) {
      db.prepare(`UPDATE alterdata_sync_cursors SET version=?, last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(v, existing.id);
    } else {
      db.prepare(`INSERT INTO alterdata_sync_cursors (id, organization_id, module, resource, filial, version, last_synced_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`)
        .run(uuidv4(), orgId, module, resource, filial, v);
    }
  }

  /**
   * Emissão/renovação do token — PENDENTE (ADR-105, pergunta A à Alterdata):
   * nenhum spec documenta como emitir o token. Fica explicitamente não
   * implementado para não simular uma integração que não existe. Entra na Fase 1
   * assim que a Alterdata devolver o contrato (endpoint/fluxo).
   */
  static async acquireToken(_orgId: string): Promise<never> {
    throw new Error("Alterdata: emissão de token ainda não definida (ADR-105, pergunta A — aguardando contrato da Alterdata).");
  }
}
