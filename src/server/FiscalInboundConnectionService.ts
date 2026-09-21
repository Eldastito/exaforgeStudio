/**
 * FiscalInboundConnectionService — conexão fiscal de ENTRADA por CNPJ com o
 * provedor (Nuvem Fiscal), ADR-200 Fase 3.
 *
 * Guarda as credenciais do provedor CIFRADAS (EncryptionService) em config_enc;
 * elas NUNCA voltam pela API (só a leitura interna do adapter as decifra). Uma
 * conexão só fica `connected` após um `probe` real (fatia seguinte) — salvar
 * configuração a marca `validating`/`not_configured`, nunca ativa. Guarda também
 * o cursor de distribuição (ult_nsu) com controle otimista (cursor_version).
 * Isolado por organização.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import { normalizeCnpj } from "./FiscalStoreResolverService.js";
import { logAuthEvent } from "./auditLog.js";

export type ConnectionState = "not_configured" | "validating" | "connected" | "error" | "disabled" | "disconnected";
export type ManifestationPolicy = "manual_only" | "auto_awareness" | "provider_managed";
const POLICIES: ManifestationPolicy[] = ["manual_only", "auto_awareness", "provider_managed"];

export interface ConnectionCredentials { clientId: string; clientSecret: string; scope: string; }

export interface CreateConnectionInput {
  provider?: string;
  environment: "production" | "homologation";
  cnpj: string;
  storeId?: string | null;
  clientId: string;
  clientSecret: string;
  scope?: string;
  manifestationPolicy?: ManifestationPolicy;
}

/** Visão pública — NUNCA inclui config_enc/segredos. */
function publicView(row: any): any {
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    environment: row.environment,
    cnpj: row.cnpj,
    storeId: row.store_id || null,
    state: row.state,
    manifestationPolicy: row.manifestation_policy,
    capabilities: row.capabilities_json ? safeJson(row.capabilities_json) : null,
    lastProbeAt: row.last_probe_at || null,
    lastSuccessAt: row.last_success_at || null,
    lastErrorCode: row.last_error_code || null,
    ultNsu: row.ult_nsu || "0",
    maxNsu: row.max_nsu || null,
    blockedUntil: row.blocked_until || null,
    enabled: !!row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
function safeJson(s: string): any { try { return JSON.parse(s); } catch { return null; } }

export class FiscalInboundConnectionService {
  /**
   * Cria (ou recusa duplicata de) uma conexão. Credenciais são cifradas; a
   * conexão nasce `validating` e DESLIGADA — só um probe real a ativa.
   */
  static create(orgId: string, input: CreateConnectionInput, actorId?: string): { ok: true; connection: any } | { ok: false; reason: string } {
    const provider = input.provider || "nuvemfiscal";
    const cnpj = normalizeCnpj(input.cnpj);
    if (!cnpj) return { ok: false, reason: "cnpj inválido" };
    if (input.environment !== "production" && input.environment !== "homologation") return { ok: false, reason: "environment inválido" };
    if (!input.clientId || !input.clientSecret) return { ok: false, reason: "credenciais obrigatórias" };
    // ADR-200 §17.1: credencial fiscal não pode depender do fallback de dev.
    // Em produção exige ENCRYPTION_KEY dedicada (fail-closed).
    if (process.env.NODE_ENV === "production" && !process.env.ENCRYPTION_KEY) {
      return { ok: false, reason: "encryption_key_required" };
    }
    const policy: ManifestationPolicy = POLICIES.includes(input.manifestationPolicy as any) ? input.manifestationPolicy! : "manual_only";

    const dupe = db.prepare(
      `SELECT id FROM fiscal_inbound_connections WHERE organization_id = ? AND provider = ? AND environment = ? AND cnpj = ?`
    ).get(orgId, provider, input.environment, cnpj) as any;
    if (dupe) return { ok: false, reason: "conexão já existe para este CNPJ/ambiente" };

    if (input.storeId) {
      const store = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, input.storeId);
      if (!store) return { ok: false, reason: "loja inválida" };
    }

    const configEnc = EncryptionService.encrypt(JSON.stringify({
      clientId: input.clientId, clientSecret: input.clientSecret, scope: input.scope || "distribuicao-nfe",
    }));
    if (!configEnc) return { ok: false, reason: "falha ao cifrar credenciais" };

    const id = randomUUID();
    db.prepare(
      `INSERT INTO fiscal_inbound_connections (id, organization_id, provider, environment, cnpj, store_id, config_enc, state, manifestation_policy, enabled)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'validating', ?, 0)`
    ).run(id, orgId, provider, input.environment, cnpj, input.storeId || null, configEnc, policy);
    try { logAuthEvent(orgId, actorId || "system", id, "FISCAL_CONNECTION_CREATED", { provider, environment: input.environment, cnpj }); } catch { /* noop */ }
    return { ok: true, connection: this.get(orgId, id) };
  }

  static list(orgId: string): any[] {
    return (db.prepare(`SELECT * FROM fiscal_inbound_connections WHERE organization_id = ? ORDER BY created_at DESC`).all(orgId) as any[]).map(publicView);
  }

  static get(orgId: string, id: string): any | null {
    return publicView(db.prepare(`SELECT * FROM fiscal_inbound_connections WHERE organization_id = ? AND id = ?`).get(orgId, id));
  }

  /** Leitura INTERNA das credenciais (só o adapter usa; não exposta pela API). */
  static getCredentials(orgId: string, id: string): ConnectionCredentials | null {
    const row = db.prepare(`SELECT config_enc FROM fiscal_inbound_connections WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    if (!row?.config_enc) return null;
    const dec = EncryptionService.decrypt(row.config_enc);
    if (!dec) return null;
    const j = safeJson(dec);
    return j && j.clientId && j.clientSecret ? { clientId: j.clientId, clientSecret: j.clientSecret, scope: j.scope || "distribuicao-nfe" } : null;
  }

  /** Atualiza campos operacionais permitidos (loja, política). */
  static update(orgId: string, id: string, patch: { storeId?: string | null; manifestationPolicy?: ManifestationPolicy }, actorId?: string): { ok: boolean; reason?: string } {
    const conn = db.prepare(`SELECT id FROM fiscal_inbound_connections WHERE organization_id = ? AND id = ?`).get(orgId, id);
    if (!conn) return { ok: false, reason: "conexão inexistente" };
    if (patch.storeId !== undefined && patch.storeId !== null) {
      const store = db.prepare(`SELECT id FROM retail_stores WHERE organization_id = ? AND id = ? AND active = 1`).get(orgId, patch.storeId);
      if (!store) return { ok: false, reason: "loja inválida" };
    }
    if (patch.manifestationPolicy && !POLICIES.includes(patch.manifestationPolicy)) return { ok: false, reason: "política inválida" };
    db.prepare(
      `UPDATE fiscal_inbound_connections SET store_id = COALESCE(?, store_id), manifestation_policy = COALESCE(?, manifestation_policy), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
    ).run(patch.storeId ?? null, patch.manifestationPolicy ?? null, orgId, id);
    return { ok: true };
  }

  /** Registra o resultado de um probe real (fatia seguinte chama isto). */
  static markProbe(orgId: string, id: string, result: { connected: boolean; capabilities?: any; errorCode?: string | null }): void {
    if (result.connected) {
      db.prepare(
        `UPDATE fiscal_inbound_connections SET state = 'connected', enabled = 1, capabilities_json = ?, last_probe_at = CURRENT_TIMESTAMP, last_error_code = NULL, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
      ).run(result.capabilities ? JSON.stringify(result.capabilities) : null, orgId, id);
    } else {
      db.prepare(
        `UPDATE fiscal_inbound_connections SET state = 'error', last_probe_at = CURRENT_TIMESTAMP, last_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
      ).run(result.errorCode || "probe_failed", orgId, id);
    }
  }

  /**
   * Avança o cursor com compare-and-set (cursor_version). Retorna false se a
   * versão esperada não bate (corrida) — o chamador reprocessa o lote.
   */
  static advanceCursor(orgId: string, id: string, expectedVersion: number, next: { ultNsu: string; maxNsu?: string | null }): boolean {
    const r = db.prepare(
      `UPDATE fiscal_inbound_connections SET ult_nsu = ?, max_nsu = COALESCE(?, max_nsu), last_batch_at = CURRENT_TIMESTAMP, last_success_at = CURRENT_TIMESTAMP,
          consecutive_failures = 0, cursor_version = cursor_version + 1, updated_at = CURRENT_TIMESTAMP
        WHERE organization_id = ? AND id = ? AND cursor_version = ?`
    ).run(next.ultNsu, next.maxNsu ?? null, orgId, id, expectedVersion);
    return r.changes === 1;
  }

  /** Cursor atual + versão (para o compare-and-set). */
  static getCursor(orgId: string, id: string): { ultNsu: string; maxNsu: string | null; version: number } | null {
    const row = db.prepare(`SELECT ult_nsu, max_nsu, cursor_version FROM fiscal_inbound_connections WHERE organization_id = ? AND id = ?`).get(orgId, id) as any;
    return row ? { ultNsu: row.ult_nsu || "0", maxNsu: row.max_nsu || null, version: Number(row.cursor_version || 0) } : null;
  }

  /** Backoff externo: bloqueia o polling até `until` e conta falhas. */
  static applyBackoff(orgId: string, id: string, until: string, errorCode?: string): void {
    db.prepare(
      `UPDATE fiscal_inbound_connections SET blocked_until = ?, consecutive_failures = consecutive_failures + 1, last_error_code = ?, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`
    ).run(until, errorCode || null, orgId, id);
  }

  /** Desconecta: desliga sync e some com o acesso, PRESERVA cursor e histórico. */
  static disconnect(orgId: string, id: string, actorId?: string): { ok: boolean; reason?: string } {
    const conn = db.prepare(`SELECT id FROM fiscal_inbound_connections WHERE organization_id = ? AND id = ?`).get(orgId, id);
    if (!conn) return { ok: false, reason: "conexão inexistente" };
    db.prepare(`UPDATE fiscal_inbound_connections SET state = 'disconnected', enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, id);
    try { logAuthEvent(orgId, actorId || "system", id, "FISCAL_CONNECTION_DISCONNECTED", {}); } catch { /* noop */ }
    return { ok: true };
  }
}

export default FiscalInboundConnectionService;
