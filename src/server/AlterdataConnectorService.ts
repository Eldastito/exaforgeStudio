import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import { AlterdataProfileService, type AlterdataEnvironment } from "./AlterdataProfileService.js";

/**
 * Conector Alterdata/ModaUp — FACHADA legada (ADR-105 + ADR-198).
 *
 * A partir de PRD-ZF-ALTERDATA-GOLIVE-01 PR 2, este serviço vira uma
 * FACHADA ADITIVA sobre {@link AlterdataProfileService}. Preserva a API antiga
 * (chamadas por `orgId` sem `environment`) resolvendo o environment corrente
 * a partir de `alterdata_integration_settings.environment` e delegando todas
 * as operações env-escopadas (token, cursor, URL, credencial) pro profile
 * correspondente.
 *
 * Resultado prático:
 *   - Trocar `environment` no dropdown troca INSTANTANEAMENTE token, cursor,
 *     credencial e URL usados — antes ficavam grudados no que foi salvo uma
 *     vez.
 *   - Homolog e prod ficam isolados: cursor que avançou em homolog NUNCA é
 *     lido em prod.
 *   - `enabled` e `sync_interval_minutes` seguem globais por org (não
 *     env-escopados) — continuam na tabela legada.
 *
 * Compatibilidade:
 *   - Callers antigos (`AlterdataSyncRunner`, `AlterdataSyncService`, UI)
 *     continuam chamando `getCursor(org, mod, res, fil)` sem alteração.
 *   - Backfill on-demand: primeira leitura do profile do env corrente
 *     copia a linha do legado (idempotente).
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
  environment?: AlterdataEnvironment;
  rede?: string | null;
  filiais?: string[];
  basePattern?: string | null;        // ex.: 'toulon-{module}.apimodaup.com.br'
  moduleBaseUrls?: Record<string, string>;
  authConfig?: Record<string, any> | null; // client_id/secret ou api key — cifrado
  syncIntervalMinutes?: number;
  priceTable?: string | null;               // nº da tabela de preço da rede (módulo Price)
}

export class AlterdataConnectorService {
  private static row(orgId: string): any {
    return db.prepare(`SELECT * FROM alterdata_integration_settings WHERE organization_id = ?`).get(orgId) as any;
  }

  /**
   * Environment corrente da org (baseado na linha legada, que é a "seleção
   * ativa" do dropdown). Fallback pra 'homolog' quando não há linha.
   */
  private static currentEnv(orgId: string): AlterdataEnvironment {
    const r = this.row(orgId);
    return r?.environment === "prod" ? "prod" : "homolog";
  }

  static isEnabled(orgId: string): boolean {
    const r = this.row(orgId);
    return !!(r && r.enabled);
  }

  /**
   * Cria/atualiza a config. `enabled` e `sync_interval_minutes` são globais
   * por org (permanecem na tabela legada). O restante é env-escopado e vai
   * pro profile do env resolvido (input.environment ou o corrente).
   */
  static saveSettings(orgId: string, input: AlterdataSettingsInput): void {
    const cur = this.row(orgId);
    const nextEnv: AlterdataEnvironment = input.environment && ["homolog", "prod"].includes(input.environment)
      ? input.environment
      : (cur?.environment === "prod" ? "prod" : "homolog");

    const legacyNext = {
      enabled: input.enabled != null ? (input.enabled ? 1 : 0) : (cur?.enabled ?? 0),
      environment: nextEnv,
      rede: input.rede !== undefined ? (input.rede || null) : (cur?.rede ?? null),
      filiais_json: input.filiais !== undefined ? JSON.stringify(input.filiais || []) : (cur?.filiais_json ?? null),
      base_pattern: input.basePattern !== undefined ? (input.basePattern || null) : (cur?.base_pattern ?? null),
      module_base_urls_json: input.moduleBaseUrls !== undefined ? JSON.stringify(input.moduleBaseUrls || {}) : (cur?.module_base_urls_json ?? null),
      auth_config_enc: input.authConfig !== undefined ? (input.authConfig ? EncryptionService.encrypt(JSON.stringify(input.authConfig)) : null) : (cur?.auth_config_enc ?? null),
      sync_interval_minutes: input.syncIntervalMinutes != null ? Math.max(1, Math.floor(input.syncIntervalMinutes)) : (cur?.sync_interval_minutes ?? 15),
      price_table: input.priceTable !== undefined ? (input.priceTable ? String(input.priceTable).trim() : null) : (cur?.price_table ?? null),
    };
    if (cur) {
      db.prepare(
        `UPDATE alterdata_integration_settings SET enabled=?, environment=?, rede=?, filiais_json=?, base_pattern=?, module_base_urls_json=?, auth_config_enc=?, sync_interval_minutes=?, price_table=?, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`
      ).run(legacyNext.enabled, legacyNext.environment, legacyNext.rede, legacyNext.filiais_json, legacyNext.base_pattern, legacyNext.module_base_urls_json, legacyNext.auth_config_enc, legacyNext.sync_interval_minutes, legacyNext.price_table, orgId);
    } else {
      db.prepare(
        `INSERT INTO alterdata_integration_settings (organization_id, enabled, environment, rede, filiais_json, base_pattern, module_base_urls_json, auth_config_enc, sync_interval_minutes, price_table) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(orgId, legacyNext.enabled, legacyNext.environment, legacyNext.rede, legacyNext.filiais_json, legacyNext.base_pattern, legacyNext.module_base_urls_json, legacyNext.auth_config_enc, legacyNext.sync_interval_minutes, legacyNext.price_table);
    }

    // Espelha os campos env-escopados no profile do env resolvido. Só
    // repassa o que veio no input — não sobrescreve outros campos do profile.
    const profilePatch: Parameters<typeof AlterdataProfileService.saveProfile>[2] = {};
    if (input.basePattern !== undefined) profilePatch.basePattern = input.basePattern;
    if (input.moduleBaseUrls !== undefined) profilePatch.moduleBaseUrls = input.moduleBaseUrls;
    if (input.authConfig !== undefined) profilePatch.authConfig = input.authConfig;
    if (input.rede !== undefined) profilePatch.rede = input.rede;
    if (input.filiais !== undefined) profilePatch.filiais = input.filiais;
    if (input.priceTable !== undefined) profilePatch.priceTable = input.priceTable;
    if (Object.keys(profilePatch).length > 0) {
      AlterdataProfileService.saveProfile(orgId, nextEnv, profilePatch);
    }
  }

  /** Visão SEM segredos (para a UI/API) — nunca devolve token/credencial em texto. */
  static publicSettings(orgId: string): any {
    const r = this.row(orgId);
    if (!r) {
      return { configured: false, enabled: false, environment: "homolog", rede: null, filiais: [], hasCredentials: false, hasToken: false, tokenExpiresAt: null, syncIntervalMinutes: 15, modules: Object.keys(ALTERDATA_MODULES) };
    }
    const env: AlterdataEnvironment = r.environment === "prod" ? "prod" : "homolog";
    // Prefere dados do profile do env corrente; cai no legado se profile não existir.
    const profile = AlterdataProfileService.publicProfileFor(orgId, env);
    let legacyFiliais: string[] = [];
    try { legacyFiliais = JSON.parse(r.filiais_json || "[]"); } catch { /* noop */ }
    return {
      configured: true,
      enabled: !!r.enabled,
      environment: env,
      rede: profile.configured ? profile.rede : (r.rede || null),
      filiais: profile.configured ? profile.filiais : legacyFiliais,
      basePattern: profile.configured ? profile.basePattern : (r.base_pattern || null),
      priceTable: profile.configured ? profile.priceTable : (r.price_table || null),
      hasCredentials: profile.hasCredentials || !!r.auth_config_enc,
      hasToken: profile.hasToken || !!r.access_token_enc,
      tokenExpiresAt: profile.tokenExpiresAt || r.token_expires_at || null,
      syncIntervalMinutes: r.sync_interval_minutes || 15,
      modules: Object.keys(ALTERDATA_MODULES),
    };
  }

  /**
   * Credencial decifrada do env corrente. Prefere profile (isolado por env);
   * cai no legado se profile ainda não tem — mantém zero-regressão.
   */
  static getAuthConfig(orgId: string): Record<string, any> | null {
    const env = this.currentEnv(orgId);
    const fromProfile = AlterdataProfileService.getAuthConfig(orgId, env);
    if (fromProfile) return fromProfile;
    const r = this.row(orgId);
    if (!r?.auth_config_enc) return null;
    const dec = EncryptionService.decrypt(r.auth_config_enc);
    if (!dec) return null;
    try { return JSON.parse(dec); } catch { return null; }
  }

  /**
   * Grava o token corrente (cifrado) + validade NO PROFILE do env corrente.
   * Homolog e prod ficam isolados: nunca mais sobrescreve o token do outro.
   */
  static setAccessToken(orgId: string, token: string, expiresAt: Date | string | null): void {
    if (!this.row(orgId)) this.saveSettings(orgId, {}); // garante a linha legada
    const env = this.currentEnv(orgId);
    AlterdataProfileService.setAccessToken(orgId, env, token, expiresAt);
  }

  /**
   * Token válido do env corrente. Prefere profile; cai no legado só se
   * ninguém escreveu no profile ainda (compat).
   */
  static getAccessToken(orgId: string): string | null {
    const env = this.currentEnv(orgId);
    const fromProfile = AlterdataProfileService.getAccessToken(orgId, env);
    if (fromProfile) return fromProfile;
    const r = this.row(orgId);
    if (!r?.access_token_enc) return null;
    if (r.token_expires_at && new Date(r.token_expires_at).getTime() <= Date.now()) return null;
    return EncryptionService.decrypt(r.access_token_enc);
  }

  /** Base URL (https) de um módulo no env corrente. */
  static moduleBaseUrl(orgId: string, moduleKey: string): string | null {
    const env = this.currentEnv(orgId);
    const fromProfile = AlterdataProfileService.moduleBaseUrl(orgId, env, moduleKey, ALTERDATA_MODULES);
    if (fromProfile) return fromProfile;
    // Fallback pro legado (zero-regressão pra org que ainda não tem profile).
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

  // ---- Fechamento automático pelo PDV (Fase 2) ----
  // Quando ligado, o sync preenche o fechamento diário PENDENTE com o total (e
  // formas de pagamento) do PDV — a loja não precisa digitar; quem informar
  // manualmente antes continua valendo (modo supervisionado por fechamento).
  static isPdvAutoClosing(orgId: string): boolean {
    return this.getCursor(orgId, "_meta", "pdvAutoClosing", "") === "1";
  }
  static setPdvAutoClosing(orgId: string, on: boolean): void {
    this.setCursor(orgId, "_meta", "pdvAutoClosing", "", on ? "1" : "0");
  }

  // Importar a base de CLIENTES do PDV (ClienteMalote → retail_pdv_customers).
  // Opt-in por LGPD: dado pessoal só entra com autorização explícita, e numa
  // base SEPARADA (não polui os contatos/inbox do WhatsApp).
  static isPdvCustomerImport(orgId: string): boolean {
    return this.getCursor(orgId, "_meta", "pdvCustomerImport", "") === "1";
  }
  static setPdvCustomerImport(orgId: string, on: boolean): void {
    this.setCursor(orgId, "_meta", "pdvCustomerImport", "", on ? "1" : "0");
  }

  // ---- cursor do delta-sync (env-escopado via profile) ----

  static getCursor(orgId: string, module: string, resource: string, filial = ""): string {
    const env = this.currentEnv(orgId);
    return AlterdataProfileService.getCursor(orgId, env, module, resource, filial);
  }

  /**
   * Zera os cursores de delta do ENV CORRENTE (menos o `_meta`/lastRun). O
   * outro env fica intacto — troca no dropdown pra limpar aquele.
   */
  static clearCursors(orgId: string): number {
    const env = this.currentEnv(orgId);
    return AlterdataProfileService.clearCursors(orgId, env);
  }

  static setCursor(orgId: string, module: string, resource: string, filial: string, version: string | number): void {
    const env = this.currentEnv(orgId);
    AlterdataProfileService.setCursor(orgId, env, module, resource, filial, version);
  }

  /**
   * Emissão/renovação do token pelo GUARDIAN da ModaUp (ADR-105 — contrato
   * recebido). Fluxo OAuth2 `client_credentials`:
   *   POST https://guardian.apimodaup.com.br/connect/token
   *   grant_type=client_credentials, client_id=<e-mail>, client_secret=<senha>,
   *   scope=<módulos>  (application/x-www-form-urlencoded)
   * O client_id/secret são o e-mail/senha de um usuário de RETAGUARDA com acesso
   * total (Cadastros › ...). Grava o access_token cifrado + validade e o devolve.
   * O cliente HTTP é injetável (teste offline, sem tocar a rede).
   */
  static async acquireToken(orgId: string): Promise<{ accessToken: string; expiresAt: string }> {
    const auth = this.getAuthConfig(orgId);
    const clientId = auth?.clientId || auth?.client_id;
    const clientSecret = auth?.clientSecret || auth?.client_secret;
    if (!clientId || !clientSecret) {
      throw new Error("Alterdata Guardian: credenciais ausentes. Informe client_id (e-mail) e client_secret (senha) de um usuário de retaguarda com acesso total.");
    }
    const tokenUrl = auth?.tokenUrl || auth?.token_url || GUARDIAN_TOKEN_URL;
    const scope = auth?.scope || GUARDIAN_DEFAULT_SCOPE;
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: String(clientId),
      client_secret: String(clientSecret),
      scope: String(scope),
    }).toString();

    const http: TokenHttp = _tokenHttp || ((url, init) => fetch(url, init) as any);
    const res = await http(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Alterdata Guardian: falha ao emitir token (HTTP ${res.status}). ${String(txt).slice(0, 300)}`);
    }
    const data: any = await res.json();
    const accessToken = data?.access_token;
    if (!accessToken) throw new Error("Alterdata Guardian: resposta sem access_token.");
    const expiresIn = Number(data?.expires_in || 3600);
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();
    this.setAccessToken(orgId, accessToken, expiresAt);
    return { accessToken, expiresAt };
  }

  /** Token válido, renovando pelo Guardian se ausente/expirado (uso na Fase 1). */
  static async getOrRefreshToken(orgId: string): Promise<string> {
    const cached = this.getAccessToken(orgId);
    if (cached) return cached;
    const { accessToken } = await this.acquireToken(orgId);
    return accessToken;
  }
}

// Endpoint do Guardian (OpenID Connect token endpoint) e escopo padrão com todos
// os módulos licenciáveis da ModaUp (a TOULON usa um subconjunto; o escopo pode
// ser sobrescrito em auth_config.scope).
export const GUARDIAN_TOKEN_URL = "https://guardian.apimodaup.com.br/connect/token";
export const GUARDIAN_DEFAULT_SCOPE = [
  "APIHumanResourcesModule", "APILogisticModule", "APISalesModule", "APISupplyModule",
  "ReportViewModule", "MaestroServer", "APIPurchaseModule", "APICRMModule",
  "APIPriceModule", "APIeCommerceModule", "APITributaryModule",
].join(" ");

// Cliente HTTP do token — injetável para testes (sem tocar a rede).
export type TokenHttp = (url: string, init: any) => Promise<{ ok: boolean; status: number; json: () => Promise<any>; text: () => Promise<string> }>;
let _tokenHttp: TokenHttp | null = null;
export function __setAlterdataTokenHttpForTests(fn: TokenHttp | null): void { _tokenHttp = fn; }
