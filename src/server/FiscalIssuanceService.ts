/**
 * FiscalIssuanceService — ADR-181 F6: emissão de documento fiscal (NFS-e/NFC-e) — SCAFFOLD
 * HONESTO, gated em terceiro. Espelha o `SicrediCobrancaService` (ADR-177).
 *
 * Emitir nota fiscal exige CERTIFICADO DIGITAL A1 + integração homologada com a PREFEITURA
 * (NFS-e municipal) ou SEFAZ (NFC-e), OU um provedor homologado (Focus NFe/eNotas/PlugNotas).
 * Nada disso existe no produto hoje (o motor F1–F5 CALCULA e MOSTRA os tributos, mas não
 * EMITE documento fiscal autorizado). Enquanto a homologação não fecha, este service NÃO
 * inventa comportamento: guarda a config (cifrada, opt-in), expõe um ESTADO OBSERVÁVEL e
 * degrada com clareza — `issue` LANÇA `fiscal_awaiting_homologation`, nunca finge emitir.
 *
 * Guardrails RN-FISCAL:
 *  - 8 (não emite sem homologação): `issue` LANÇA; `connected` só com probe real (futuro), que
 *    este scaffold NUNCA atribui. Sem certificado/provedor → capacidades indisponíveis.
 *  - segredo cifrado/redigido: `config_enc` (AES-GCM); `status` nunca devolve segredo.
 *  - tenant: orgId 1º arg; UNIQUE(org) → 1 conexão por org. opt-in/reversível (default off).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import { logAuthEvent } from "./auditLog.js";

export type FiscalIssuanceState = "not_configured" | "awaiting_homologation" | "connected" | "disabled";

// Documentos fiscais que a emissão ENTREGARÁ quando homologada. Enquanto o scaffold não fala
// com prefeitura/SEFAZ/provedor, todas ficam indisponíveis (honestidade).
export const FISCAL_ISSUANCE_CAPABILITIES = ["issue_nfse", "issue_nfce", "cancel_document", "query_document"] as const;
export type FiscalIssuanceCapability = (typeof FISCAL_ISSUANCE_CAPABILITIES)[number];

// Credencial esperada (o que a homologação exige) — cifrada. Certificado A1 fica FORA do DB
// (referência ao armazenamento seguro), nunca o .pfx cru aqui.
const SECRET_FIELDS = ["providerToken", "providerSecret", "certificateRef", "certificatePassword"] as const;
// Campos públicos (não-segredo) — voltam no status.
const PUBLIC_FIELDS = ["provider", "municipalityIbge", "serviceCode", "environment", "rpsSeries"] as const;

interface Row {
  id: string; organization_id: string; config_enc: string | null;
  connection_state: string; state_detail: string | null; enabled: number;
  configured_at: string | null; updated_at: string | null;
}

export class FiscalIssuanceService {
  private static row(orgId: string): Row | null {
    return (db.prepare(`SELECT * FROM fiscal_issuance_connections WHERE organization_id = ?`).get(orgId) as Row) || null;
  }
  private static config(row: Row | null): Record<string, any> {
    if (!row?.config_enc) return {};
    try { return JSON.parse(EncryptionService.decrypt(row.config_enc) || "{}"); } catch { return {}; }
  }

  /** Estado observável da emissão (sem segredos). */
  static status(orgId: string): any {
    const row = this.row(orgId);
    const cfg = this.config(row);
    const state = (row?.connection_state as FiscalIssuanceState) || "not_configured";
    const homologated = state === "connected";
    return {
      domain: "fiscal_issuance",
      configured: !!row?.config_enc,
      enabled: !!row?.enabled,
      state,
      stateDetail: row?.state_detail || (state === "awaiting_homologation"
        ? "Config salva — aguardando homologação (certificado A1 + prefeitura/SEFAZ ou provedor homologado). Não emite nota fiscal até homologar."
        : state === "not_configured" ? "Nenhuma configuração de emissão fiscal." : null),
      hasCredentials: SECRET_FIELDS.some((f) => cfg[f]),
      config: {
        provider: cfg.provider || null, municipalityIbge: cfg.municipalityIbge || null,
        serviceCode: cfg.serviceCode || null, environment: cfg.environment || null,
      },
      // Capacidade DESCOBERTA, não presumida: sem homologação → indisponível.
      capabilities: FISCAL_ISSUANCE_CAPABILITIES.map((c) => ({
        capability: c, available: homologated, reason: homologated ? null : "awaiting_homologation",
      })),
      configuredAt: row?.configured_at || null, updatedAt: row?.updated_at || null,
    };
  }

  /**
   * Grava/atualiza a config (cifrada). Opt-in via `enabled`. NUNCA marca `connected` —
   * configurar não homologa (RN-FISCAL-8): com credencial → `awaiting_homologation`.
   */
  static configure(orgId: string, patch: Record<string, any>, opts: { enabled?: boolean } = {}, actorId?: string): any {
    const existing = this.row(orgId);
    const cfg = this.config(existing);
    for (const f of [...SECRET_FIELDS, ...PUBLIC_FIELDS]) {
      if (Object.prototype.hasOwnProperty.call(patch, f)) {
        const v = patch[f];
        if (v == null || String(v).trim() === "") delete cfg[f];
        else cfg[f] = String(v).slice(0, 8000);
      }
    }
    const hasCred = SECRET_FIELDS.some((f) => cfg[f]);
    const enabled = opts.enabled != null ? (opts.enabled ? 1 : 0) : (existing?.enabled ?? 0);
    const state: FiscalIssuanceState = !hasCred ? "not_configured" : (enabled ? "awaiting_homologation" : "disabled");
    const enc = Object.keys(cfg).length ? EncryptionService.encrypt(JSON.stringify(cfg)) : null;

    if (existing) {
      db.prepare(`UPDATE fiscal_issuance_connections SET config_enc = ?, connection_state = ?, state_detail = NULL, enabled = ?, configured_at = COALESCE(configured_at, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP END), updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`)
        .run(enc, state, enabled, enc, orgId);
    } else {
      db.prepare(`INSERT INTO fiscal_issuance_connections (id, organization_id, config_enc, connection_state, enabled, configured_at) VALUES (?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP END)`)
        .run(randomUUID(), orgId, enc, state, enabled, enc);
    }
    try { logAuthEvent(orgId, actorId || "system", "fiscal", "FISCAL_ISSUANCE_CONFIGURED", { enabled: !!enabled, hasCredentials: hasCred, state }); } catch { /* noop */ }
    return this.status(orgId);
  }

  /** Desliga/limpa a conexão (opt-out, reversível). */
  static disconnect(orgId: string, actorId?: string): any {
    const existing = this.row(orgId);
    if (existing) {
      db.prepare(`UPDATE fiscal_issuance_connections SET config_enc = NULL, connection_state = 'not_configured', state_detail = NULL, enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ?`).run(orgId);
      try { logAuthEvent(orgId, actorId || "system", "fiscal", "FISCAL_ISSUANCE_DISCONNECTED", {}); } catch { /* noop */ }
    }
    return this.status(orgId);
  }

  /**
   * Emissão de NFS-e/NFC-e — STUB HONESTO (RN-FISCAL-8). É AQUI que a chamada real (certificado
   * A1 + prefeitura/SEFAZ, ou provedor homologado) plugará quando a homologação chegar. Enquanto
   * isso, LANÇA erro claro — NUNCA finge que emitiu nota, nunca inventa número de documento fiscal.
   */
  static async issue(orgId: string, _input: { kind?: "nfse" | "nfce"; amountCents?: number; date?: string; customer?: any }): Promise<never> {
    const state = this.status(orgId).state;
    if (state === "not_configured") throw new Error("fiscal_not_configured");
    throw new Error("fiscal_awaiting_homologation");
  }
}

export default FiscalIssuanceService;
