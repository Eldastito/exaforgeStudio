/**
 * AlterdataProfileService — PRD-ZF-ALTERDATA-GOLIVE-01 (PR 2).
 *
 * Fonte da verdade para as configurações da integração Alterdata POR
 * (organization_id, environment). Substitui gradualmente a leitura direta
 * de `alterdata_integration_settings` — este arquivo é a ÚNICA porta pra
 * ler/escrever profile, token, cursor e URL a partir do PR 2 em diante.
 *
 * Estratégia de convivência (RF-01/02/03):
 *   - Grava sempre em `alterdata_integration_profiles` (PK = org+env)
 *   - Lê PREFERIDO de `alterdata_integration_profiles`
 *   - Se o profile do env pedido não existir E existir uma linha no legado
 *     `alterdata_integration_settings`, faz BACKFILL on-demand (idempotente):
 *     copia a linha do legado pra o profile do `settings.environment`, e usa.
 *   - `AlterdataConnectorService` (legado) vira fachada aditiva sobre este.
 *
 * Rollback: se este serviço tiver problema, o Connector antigo continua
 * funcionando lendo `alterdata_integration_settings` diretamente — os
 * profiles ficam inertes até alguém ler de novo (idempotente).
 */
import { v4 as uuidv4 } from "uuid";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";

export type AlterdataEnvironment = "homolog" | "prod";

export interface AlterdataProfileInput {
  basePattern?: string | null;
  moduleBaseUrls?: Record<string, string> | null;
  authConfig?: Record<string, any> | null;
  scopes?: string[] | null;
  rede?: string | null;
  filiais?: string[] | null;
  priceTable?: string | null;
  validationStatus?: "unvalidated" | "validated" | "failed";
}

export interface AlterdataProfileRow {
  organization_id: string;
  environment: string;
  base_pattern: string | null;
  module_base_urls_json: string | null;
  auth_config_enc: string | null;
  access_token_enc: string | null;
  token_expires_at: string | null;
  scopes_json: string | null;
  rede: string | null;
  filiais_json: string | null;
  price_table: string | null;
  validation_status: string;
  last_validated_at: string | null;
  approved_by: string | null;
  approved_at: string | null;
  created_at: string;
  updated_at: string;
}

export class AlterdataProfileService {
  /**
   * Lê profile por (org, env) com backfill on-demand a partir do legado.
   * NUNCA cria o profile do OUTRO env — só do env pedido, e SOMENTE se o
   * legado apontar pra esse mesmo env. Isso preserva o isolamento: uma org
   * que só tem homolog configurada não gera prod fantasma.
   */
  static getProfile(orgId: string, environment: AlterdataEnvironment): AlterdataProfileRow | null {
    const direct = db.prepare(
      `SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment=?`
    ).get(orgId, environment) as AlterdataProfileRow | undefined;
    if (direct) return direct;

    // Backfill on-demand: se o legado existe E tem `environment` == env pedido,
    // migra pro profile. Idempotente — se rodar de novo com legado inalterado,
    // o UPSERT abaixo mantém dados iguais.
    const legacy = db.prepare(
      `SELECT * FROM alterdata_integration_settings WHERE organization_id=?`
    ).get(orgId) as any;
    if (!legacy) return null;
    const legacyEnv: AlterdataEnvironment = legacy.environment === "prod" ? "prod" : "homolog";
    if (legacyEnv !== environment) return null; // outro env: não fabrica

    this.upsertRawFromLegacy(orgId, environment, legacy);
    return db.prepare(
      `SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment=?`
    ).get(orgId, environment) as AlterdataProfileRow;
  }

  /**
   * Backfill em batch: migra TODAS as linhas do legado que ainda não têm
   * profile correspondente. Usado por script pontual (não roda em request).
   * Retorna quantas linhas foram criadas.
   */
  static backfillFromLegacy(): number {
    const legacyRows = db.prepare(`SELECT * FROM alterdata_integration_settings`).all() as any[];
    let created = 0;
    for (const legacy of legacyRows) {
      const env: AlterdataEnvironment = legacy.environment === "prod" ? "prod" : "homolog";
      const exists = db.prepare(
        `SELECT 1 FROM alterdata_integration_profiles WHERE organization_id=? AND environment=?`
      ).get(legacy.organization_id, env);
      if (exists) continue;
      this.upsertRawFromLegacy(legacy.organization_id, env, legacy);
      created++;
    }
    return created;
  }

  private static upsertRawFromLegacy(orgId: string, env: AlterdataEnvironment, legacy: any): void {
    db.prepare(
      `INSERT OR REPLACE INTO alterdata_integration_profiles
       (organization_id, environment, base_pattern, module_base_urls_json,
        auth_config_enc, access_token_enc, token_expires_at, scopes_json,
        rede, filiais_json, price_table, validation_status,
        last_validated_at, approved_by, approved_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`
    ).run(
      orgId, env,
      legacy.base_pattern || null,
      legacy.module_base_urls_json || null,
      legacy.auth_config_enc || null,
      legacy.access_token_enc || null,
      legacy.token_expires_at || null,
      null, // scopes_json — legado não tem
      legacy.rede || null,
      legacy.filiais_json || null,
      legacy.price_table || null,
      "unvalidated",
      null, null, null,
    );
  }

  /**
   * Cria/atualiza profile por (org, env). Cifra segredos. Não mexe em
   * cursor. Se um profile já existe no OUTRO env, ele fica intacto.
   */
  static saveProfile(orgId: string, environment: AlterdataEnvironment, input: AlterdataProfileInput): void {
    const cur = db.prepare(
      `SELECT * FROM alterdata_integration_profiles WHERE organization_id=? AND environment=?`
    ).get(orgId, environment) as AlterdataProfileRow | undefined;

    const next = {
      base_pattern: input.basePattern !== undefined ? (input.basePattern || null) : (cur?.base_pattern ?? null),
      module_base_urls_json: input.moduleBaseUrls !== undefined
        ? (input.moduleBaseUrls ? JSON.stringify(input.moduleBaseUrls) : null)
        : (cur?.module_base_urls_json ?? null),
      auth_config_enc: input.authConfig !== undefined
        ? (input.authConfig ? EncryptionService.encrypt(JSON.stringify(input.authConfig)) : null)
        : (cur?.auth_config_enc ?? null),
      scopes_json: input.scopes !== undefined
        ? (input.scopes ? JSON.stringify(input.scopes) : null)
        : (cur?.scopes_json ?? null),
      rede: input.rede !== undefined ? (input.rede || null) : (cur?.rede ?? null),
      filiais_json: input.filiais !== undefined
        ? (input.filiais ? JSON.stringify(input.filiais) : null)
        : (cur?.filiais_json ?? null),
      price_table: input.priceTable !== undefined
        ? (input.priceTable ? String(input.priceTable).trim() : null)
        : (cur?.price_table ?? null),
      validation_status: input.validationStatus ?? cur?.validation_status ?? "unvalidated",
    };

    if (cur) {
      db.prepare(
        `UPDATE alterdata_integration_profiles
         SET base_pattern=?, module_base_urls_json=?, auth_config_enc=?, scopes_json=?,
             rede=?, filiais_json=?, price_table=?, validation_status=?, updated_at=CURRENT_TIMESTAMP
         WHERE organization_id=? AND environment=?`
      ).run(
        next.base_pattern, next.module_base_urls_json, next.auth_config_enc, next.scopes_json,
        next.rede, next.filiais_json, next.price_table, next.validation_status,
        orgId, environment,
      );
    } else {
      db.prepare(
        `INSERT INTO alterdata_integration_profiles
         (organization_id, environment, base_pattern, module_base_urls_json,
          auth_config_enc, scopes_json, rede, filiais_json, price_table, validation_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        orgId, environment,
        next.base_pattern, next.module_base_urls_json, next.auth_config_enc, next.scopes_json,
        next.rede, next.filiais_json, next.price_table, next.validation_status,
      );
    }
  }

  /**
   * RF-02: gravar token cifrado por (org, env). Nunca mistura envs. Se
   * o profile não existe ainda (ex.: primeira aquisição), cria com valores
   * mínimos — não sobrescreve outros campos do profile do outro env.
   */
  static setAccessToken(orgId: string, environment: AlterdataEnvironment, token: string, expiresAt: Date | string | null): void {
    const cur = db.prepare(
      `SELECT organization_id FROM alterdata_integration_profiles WHERE organization_id=? AND environment=?`
    ).get(orgId, environment);
    if (!cur) {
      // Cria linha vazia pra colocar o token (raro: acquireToken antes de saveProfile)
      db.prepare(
        `INSERT INTO alterdata_integration_profiles (organization_id, environment) VALUES (?, ?)`
      ).run(orgId, environment);
    }
    const exp = expiresAt ? (typeof expiresAt === "string" ? expiresAt : expiresAt.toISOString()) : null;
    db.prepare(
      `UPDATE alterdata_integration_profiles
       SET access_token_enc=?, token_expires_at=?, updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=? AND environment=?`
    ).run(EncryptionService.encrypt(token), exp, orgId, environment);
  }

  /**
   * RF-02: lê token decifrado por (org, env). NUNCA renova aqui — quem
   * renova é `AlterdataConnectorService.acquireToken` (fluxo Guardian).
   * Retorna null se ausente OU expirado.
   */
  static getAccessToken(orgId: string, environment: AlterdataEnvironment): string | null {
    const r = db.prepare(
      `SELECT access_token_enc, token_expires_at FROM alterdata_integration_profiles
       WHERE organization_id=? AND environment=?`
    ).get(orgId, environment) as any;
    if (!r?.access_token_enc) return null;
    if (r.token_expires_at && new Date(r.token_expires_at).getTime() <= Date.now()) return null;
    return EncryptionService.decrypt(r.access_token_enc);
  }

  /** RF-02: credencial decifrada por (org, env). Usada pelo acquireToken. */
  static getAuthConfig(orgId: string, environment: AlterdataEnvironment): Record<string, any> | null {
    const p = this.getProfile(orgId, environment);
    if (!p?.auth_config_enc) return null;
    const dec = EncryptionService.decrypt(p.auth_config_enc);
    if (!dec) return null;
    try { return JSON.parse(dec); } catch { return null; }
  }

  /**
   * RF-03: cursor por (org, env, module, resource, filial). Usa idx v2.
   * Fallback pra '0' se não existir. NUNCA usa cursor de OUTRO env.
   */
  static getCursor(orgId: string, environment: AlterdataEnvironment, module: string, resource: string, filial = ""): string {
    const r = db.prepare(
      `SELECT version FROM alterdata_sync_cursors
       WHERE organization_id=? AND environment=? AND module=? AND resource=? AND filial=?`
    ).get(orgId, environment, module, resource, filial) as any;
    return r?.version ?? "0";
  }

  static setCursor(orgId: string, environment: AlterdataEnvironment, module: string, resource: string, filial: string, version: string | number): void {
    const v = String(version);
    const existing = db.prepare(
      `SELECT id FROM alterdata_sync_cursors
       WHERE organization_id=? AND environment=? AND module=? AND resource=? AND filial=?`
    ).get(orgId, environment, module, resource, filial) as any;
    if (existing) {
      db.prepare(
        `UPDATE alterdata_sync_cursors SET version=?, last_synced_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).run(v, existing.id);
    } else {
      db.prepare(
        `INSERT INTO alterdata_sync_cursors (id, organization_id, environment, module, resource, filial, version, last_synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).run(uuidv4(), orgId, environment, module, resource, filial, v);
    }
  }

  /**
   * RF-01/03: limpa TODOS os cursors do env pedido (menos `_meta`). Usado
   * pra forçar re-pull do zero em um env sem afetar o outro. Retorna
   * quantos foram limpos.
   */
  static clearCursors(orgId: string, environment: AlterdataEnvironment): number {
    const r = db.prepare(
      `DELETE FROM alterdata_sync_cursors WHERE organization_id=? AND environment=? AND module<>'_meta'`
    ).run(orgId, environment);
    return Number(r.changes || 0);
  }

  /** RF-01: resolve URL do módulo por (org, env). */
  static moduleBaseUrl(orgId: string, environment: AlterdataEnvironment, moduleKey: string, moduleSubdomains: Record<string, string>): string | null {
    const sub = moduleSubdomains[moduleKey];
    if (!sub) return null;
    const p = this.getProfile(orgId, environment);
    if (!p) return null;
    if (p.module_base_urls_json) {
      try {
        const map = JSON.parse(p.module_base_urls_json);
        if (map[moduleKey]) return String(map[moduleKey]).replace(/\/$/, "");
      } catch { /* noop */ }
    }
    if (!p.base_pattern) return null;
    const host = String(p.base_pattern).replace("{module}", sub);
    return `https://${host.replace(/^https?:\/\//, "").replace(/\/$/, "")}`;
  }

  /**
   * RF-14: formato de path do módulo Price validado com sucesso pra este
   * (org, env). null quando ainda não detectado. Salvar aqui evita repetir
   * 2-3 tentativas por sync. Uso: `tabelaVersao` | `versao` | `redeTabelaVersao`.
   */
  static getPricePathFormat(orgId: string, environment: AlterdataEnvironment): string | null {
    const r = db.prepare(
      `SELECT price_path_format FROM alterdata_integration_profiles
       WHERE organization_id=? AND environment=?`
    ).get(orgId, environment) as any;
    return r?.price_path_format || null;
  }

  static setPricePathFormat(orgId: string, environment: AlterdataEnvironment, format: string | null): void {
    // Garante linha (raro chegar aqui sem profile, mas defensivo)
    const has = db.prepare(
      `SELECT organization_id FROM alterdata_integration_profiles WHERE organization_id=? AND environment=?`
    ).get(orgId, environment);
    if (!has) {
      db.prepare(`INSERT INTO alterdata_integration_profiles (organization_id, environment) VALUES (?, ?)`).run(orgId, environment);
    }
    db.prepare(
      `UPDATE alterdata_integration_profiles
       SET price_path_format=?, updated_at=CURRENT_TIMESTAMP
       WHERE organization_id=? AND environment=?`
    ).run(format, orgId, environment);
  }

  /** Visão pública de UM env específico. Sem segredos. */
  static publicProfileFor(orgId: string, environment: AlterdataEnvironment): any {
    const p = this.getProfile(orgId, environment);
    if (!p) {
      return {
        environment,
        configured: false,
        rede: null,
        filiais: [],
        hasCredentials: false,
        hasToken: false,
        tokenExpiresAt: null,
        priceTable: null,
        basePattern: null,
        validationStatus: "unvalidated",
        lastValidatedAt: null,
        approvedBy: null,
        approvedAt: null,
      };
    }
    let filiais: string[] = [];
    try { filiais = JSON.parse(p.filiais_json || "[]"); } catch { /* noop */ }
    return {
      environment,
      configured: true,
      rede: p.rede,
      filiais,
      basePattern: p.base_pattern,
      priceTable: p.price_table,
      hasCredentials: !!p.auth_config_enc,
      hasToken: !!p.access_token_enc,
      tokenExpiresAt: p.token_expires_at,
      validationStatus: p.validation_status,
      lastValidatedAt: p.last_validated_at,
      approvedBy: p.approved_by,
      approvedAt: p.approved_at,
    };
  }
}
