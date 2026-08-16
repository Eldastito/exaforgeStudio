/**
 * SicrediCobrancaService — conexão de COBRANÇA Sicredi (PRD Moda/TOULON; ADR-177).
 *
 * SCAFFOLD HONESTO, gated em terceiro. A Sicredi tem API de Cobrança/PIX (portal
 * do dev), mas exige CREDENCIAIS + HOMOLOGAÇÃO bancária (mTLS/cert + client_id/
 * secret por cooperativa) que dependem do banco. Enquanto isso não fecha, este
 * service NÃO inventa comportamento: guarda a config (cifrada, opt-in), expõe um
 * ESTADO OBSERVÁVEL e degrada com clareza. Espelha o padrão honesto do
 * `RetailCardAcquirerService.syncFromSicrediApi` (stub até credenciais) e do
 * `SocialConnectionService` (hub de conexão: config+estado, segredos redigidos).
 *
 * Guardrails:
 *  - RN-177-001 (tenant): orgId 1º arg; UNIQUE(org) → 1 conexão por org.
 *  - RN-177-002 (nunca finge conectado): sem homologação real, o estado fica em
 *    `awaiting_homologation` (jamais `connected`) e as capacidades ficam
 *    `capability_unavailable`. `connected` só quando um probe REAL de homologação
 *    passar (implementação futura) — este scaffold nunca atribui.
 *  - RN-177-003 (segredo cifrado/redigido): `config_enc` é o JSON de credenciais
 *    CIFRADO (AES-GCM, ADR-054); `status()` NUNCA devolve segredo (só `hasCredentials`
 *    + campos públicos como cooperativa/conta).
 *  - RN-177-004 (não emite dinheiro): `issueCharge` LANÇA `sicredi_awaiting_homologation`
 *    — não emite PIX/boleto real (o ASAAS segue mockado por decisão do operador).
 *  - RN-177-005 (opt-in/reversível): default desligado; `disconnect` limpa.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import { logAuthEvent } from "./auditLog.js";

export type SicrediConnectionState = "not_configured" | "awaiting_homologation" | "connected" | "disabled";

// Capacidades que a Cobrança Sicredi ENTREGARÁ quando homologada. Enquanto o
// scaffold não fala com o banco, todas ficam indisponíveis (honestidade).
export const SICREDI_COBRANCA_CAPABILITIES = ["issue_pix", "issue_boleto", "query_charge", "webhook_settlement"] as const;
export type SicrediCobrancaCapability = (typeof SICREDI_COBRANCA_CAPABILITIES)[number];

// Campos de credencial esperados (o que a homologação exige). Guardados cifrados.
const SECRET_FIELDS = ["clientId", "clientSecret", "certPem", "certKeyPem", "certPassword"] as const;
// Campos públicos (não-segredo) — podem voltar redigidos no status.
const PUBLIC_FIELDS = ["cooperativa", "posto", "conta", "beneficiarioNome", "beneficiarioDocumento", "environment"] as const;

interface Row {
  id: string; organization_id: string; config_enc: string | null;
  connection_state: string; state_detail: string | null; enabled: number;
  configured_at: string | null; updated_at: string | null;
}

export class SicrediCobrancaService {
  private static row(orgId: string): Row | null {
    return (db.prepare(`SELECT * FROM sicredi_cobranca_connections WHERE organization_id = ?`).get(orgId) as Row) || null;
  }

  private static config(row: Row | null): Record<string, any> {
    if (!row?.config_enc) return {};
    try { return JSON.parse(EncryptionService.decrypt(row.config_enc) || "{}"); } catch { return {}; }
  }

  /**
   * Status REDIGIDO (RN-177-003) — o que uma rota pode devolver. Nunca vaza
   * segredo. `capabilities` sempre indisponíveis enquanto não homologado.
   */
  static status(orgId: string): any {
    const row = this.row(orgId);
    const cfg = this.config(row);
    const state = (row?.connection_state as SicrediConnectionState) || "not_configured";
    const homologated = state === "connected";
    return {
      provider: "sicredi",
      domain: "cobranca",
      configured: !!row?.config_enc,
      enabled: !!row?.enabled,
      state,
      stateDetail: row?.state_detail || (state === "awaiting_homologation"
        ? "Credenciais salvas — aguardando homologação bancária da Sicredi (cert mTLS + client_id/secret por cooperativa). Não emite cobrança até homologar."
        : state === "not_configured" ? "Nenhuma credencial Sicredi configurada." : null),
      hasCredentials: SECRET_FIELDS.some((f) => cfg[f]),
      // Campos públicos (não-segredo) apenas.
      account: {
        cooperativa: cfg.cooperativa || null, posto: cfg.posto || null, conta: cfg.conta || null,
        beneficiarioNome: cfg.beneficiarioNome || null, environment: cfg.environment || null,
      },
      // Capacidade DESCOBERTA, não presumida: sem homologação → indisponível.
      capabilities: SICREDI_COBRANCA_CAPABILITIES.map((c) => ({
        capability: c, available: homologated,
        reason: homologated ? null : "awaiting_homologation",
      })),
      configuredAt: row?.configured_at || null, updatedAt: row?.updated_at || null,
    };
  }

  /**
   * Grava/atualiza a config (cifrada). Opt-in via `enabled`. NUNCA marca
   * `connected` — configurar não homologa (RN-177-002); o estado vira
   * `awaiting_homologation` quando há credencial, senão `not_configured`.
   */
  static configure(orgId: string, patch: Record<string, any>, opts: { enabled?: boolean } = {}, actorId?: string): any {
    const existing = this.row(orgId);
    const cfg = this.config(existing);
    // Aplica só os campos conhecidos passados (merge; string vazia limpa o campo).
    for (const f of [...SECRET_FIELDS, ...PUBLIC_FIELDS]) {
      if (Object.prototype.hasOwnProperty.call(patch, f)) {
        const v = patch[f];
        if (v == null || String(v).trim() === "") delete cfg[f];
        else cfg[f] = String(v).slice(0, 8000);
      }
    }
    const hasCred = SECRET_FIELDS.some((f) => cfg[f]);
    const enabled = opts.enabled != null ? (opts.enabled ? 1 : 0) : (existing?.enabled ?? 0);
    // Estado honesto: com credencial → aguardando homologação; sem → não configurada.
    // (connected exige probe real de homologação — fora deste scaffold, RN-177-002.)
    const state: SicrediConnectionState = !hasCred ? "not_configured" : (enabled ? "awaiting_homologation" : "disabled");
    const enc = Object.keys(cfg).length ? EncryptionService.encrypt(JSON.stringify(cfg)) : null;

    if (existing) {
      db.prepare(`UPDATE sicredi_cobranca_connections SET config_enc = ?, connection_state = ?, state_detail = NULL, enabled = ?, configured_at = COALESCE(configured_at, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP END), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
        .run(enc, state, enabled, enc, orgId);
    } else {
      db.prepare(`INSERT INTO sicredi_cobranca_connections (id, organization_id, config_enc, connection_state, enabled, configured_at) VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP END)`)
        .run(randomUUID(), orgId, enc, state, enabled, enc);
    }
    try { logAuthEvent(orgId, actorId || "system", "sicredi", "SICREDI_COBRANCA_CONFIGURED", { enabled: !!enabled, hasCredentials: hasCred, state }); } catch { /* noop */ }
    return this.status(orgId);
  }

  /** Desliga/limpa a conexão (opt-out, reversível — RN-177-005). */
  static disconnect(orgId: string, actorId?: string): any {
    const existing = this.row(orgId);
    if (existing) {
      db.prepare(`UPDATE sicredi_cobranca_connections SET config_enc = NULL, connection_state = 'not_configured', state_detail = NULL, enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(orgId);
      try { logAuthEvent(orgId, actorId || "system", "sicredi", "SICREDI_COBRANCA_DISCONNECTED", {}); } catch { /* noop */ }
    }
    return this.status(orgId);
  }

  /**
   * Emissão de cobrança (PIX/boleto) via Sicredi — STUB HONESTO (RN-177-004).
   * É AQUI que a chamada real (OAuth2 mTLS + endpoint de Cobrança/PIX) plugará
   * quando as credenciais + homologação chegarem; o resto do fluxo de recebíveis
   * já existe. Enquanto isso, LANÇA erro claro — nunca finge que emitiu, nunca
   * inventa dinheiro.
   */
  static async issueCharge(orgId: string, _input: { kind?: "pix" | "boleto"; amount?: number; dueDate?: string; payer?: any }): Promise<never> {
    const state = this.status(orgId).state;
    if (state === "not_configured") throw new Error("sicredi_not_configured");
    throw new Error("sicredi_awaiting_homologation");
  }
}

export default SicrediCobrancaService;
