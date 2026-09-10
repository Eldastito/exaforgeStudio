/**
 * ChannelProvisioningService — conexão AUTENTICADA e org-scoped de WhatsApp
 * (PRD WhatsApp Unificado — F2.1a, RF-01 / CA-01).
 *
 * Backbone do "assinante conecta seu número pelo ZapFlow, sem tocar no Evolution
 * Manager". A org vem SEMPRE da sessão autenticada (o caller passa o orgId
 * derivado do JWT) — NUNCA do corpo/header (RF-01 §7.2). Reusa o serviço
 * consolidado `EvolutionService.provision` (F1.1–F1.4). NÃO é Solo: o Solo tem o
 * seu próprio serviço (`FalaTuSoloWhatsAppService`, instância `falatu_solo_*` e
 * canal `kind='internal'`); aqui o canal é o número da operação (atendimento;
 * o modo misto atendimento+gestão é a Fase 3).
 *
 * Dois modos (o dono escolhe na UI):
 *  - `new`     — cria uma instância NOVA com nome gerado pelo sistema
 *                (`zapflow_<orgId>`), estável e sem colisão (§7.4 — não pede
 *                digitação). Idempotente: reusa o canal se já existir.
 *  - `existing`— IMPORTA uma instância que já existe no provedor (ex.: uma
 *                "ExaForge" criada à mão). Guardrails §8:
 *                  · já atribuída a ESTA org (canal existe) → reusa;
 *                  · atribuída a OUTRA org → NEGA (conflito; transferência de
 *                    titularidade é procedimento separado, não fallback);
 *                  · sem canal em lugar nenhum → só importa se a instância
 *                    EXISTE no provedor (verificação não-destrutiva); digitar um
 *                    nome inexistente não cria/apropria nada.
 *
 * Isolamento (INV-01): toda query filtra organization_id; o identifier é único
 * no provedor, então o "atribuída a outra org" é detectável por uma linha em
 * `channels` com aquele identifier sob org != esta.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { EncryptionService } from "./EncryptionService.js";
import { EvolutionService } from "./EvolutionService.js";
import { logAuthEvent } from "./auditLog.js";

export type ProvisionMode = "new" | "existing";

export interface ChannelProvisionResult {
  ok: boolean;
  channelId?: string;
  instanceName?: string;
  qrBase64?: string;
  state?: string;
  alreadyExists?: boolean; // instância já existia no provedor
  imported?: boolean;      // canal foi criado por IMPORT (claim) nesta chamada
  needsReset?: boolean;
  error?: string;
  code?: "org_missing" | "instance_required" | "attributed_to_other_org" | "instance_not_found" | "evolution_failed";
}

const NEW_PREFIX = "zapflow_";

export class ChannelProvisioningService {
  /** Nome de sistema pra instância NOVA de uma org geral (estável, sem colisão). */
  static newInstanceName(orgId: string): string {
    if (!orgId) throw new Error("orgId inválido");
    return `${NEW_PREFIX}${orgId}`;
  }

  /** Canal Evolution desta org com este identifier (ou undefined). */
  private static channelForOrg(orgId: string, identifier: string): { id: string; status: string } | undefined {
    return db.prepare(
      `SELECT id, status FROM channels WHERE organization_id = ? AND provider IN ('evolution','evolution_go') AND identifier = ?`
    ).get(orgId, identifier) as any;
  }

  /** Alguma OUTRA org já tem canal com este identifier? (§8 — não roubar.) */
  private static attributedToOtherOrg(orgId: string, identifier: string): boolean {
    const row = db.prepare(
      `SELECT 1 FROM channels WHERE organization_id != ? AND provider IN ('evolution','evolution_go') AND identifier = ? LIMIT 1`
    ).get(orgId, identifier);
    return !!row;
  }

  static async provision(
    orgId: string,
    actorUserId: string | null,
    opts: { mode: ProvisionMode; instanceName?: string },
  ): Promise<ChannelProvisionResult> {
    if (!orgId) return { ok: false, error: "organizationId ausente.", code: "org_missing" };
    const mode = opts.mode;

    // Resolve o nome da instância conforme o modo.
    let instanceName: string;
    let importing = false;
    if (mode === "existing") {
      instanceName = String(opts.instanceName || "").trim();
      if (!instanceName) return { ok: false, error: "Informe a instância a importar.", code: "instance_required" };
      // §8: nunca importar de outra org.
      if (this.attributedToOtherOrg(orgId, instanceName)) {
        logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_IMPORT_DENIED_CONFLICT", { instanceName });
        return { ok: false, error: "Esta instância já pertence a outra organização. Transferência de titularidade é um procedimento separado.", code: "attributed_to_other_org" };
      }
      const mine = this.channelForOrg(orgId, instanceName);
      if (!mine) {
        // Sem canal aqui: só importa se a instância EXISTE no provedor (não inventa).
        const exists = await EvolutionService.instanceExists(instanceName);
        if (!exists) {
          return { ok: false, error: "Instância não encontrada no provedor. Para criar uma nova, use 'Adicionar número'.", code: "instance_not_found" };
        }
        importing = true;
      }
    } else {
      instanceName = this.newInstanceName(orgId);
    }

    // Canal — reusa se existe (idempotente); cria se não (inclusive no import/claim).
    let existing = this.channelForOrg(orgId, instanceName);
    let channelId = existing?.id;
    if (!channelId) {
      channelId = randomUUID();
      try {
        db.prepare(
          `INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', ?, ?, 'provisioning')`
        ).run(channelId, orgId, `WhatsApp (${instanceName})`, instanceName);
      } catch (e: any) {
        return { ok: false, error: `Falha ao registrar canal: ${e?.message || e}`, code: "evolution_failed" };
      }
      if (importing) {
        logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_INSTANCE_IMPORTED", { instanceName, channelId });
      }
    }

    // Evolution: create(idempotente)+connect+QR pelo serviço consolidado.
    const result = await EvolutionService.provision(instanceName);
    if (!result.ok) {
      logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_PROVISION_FAILED", { instanceName, channelId, error: result.error });
      return { ok: false, channelId, instanceName, error: result.error, code: "evolution_failed", needsReset: result.needsReset };
    }

    try {
      db.prepare(`UPDATE channels SET status = ?, token_encrypted = COALESCE(?, token_encrypted), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(result.state === "open" ? "connected" : "awaiting_qr", EncryptionService.encrypt(result.token || null), channelId);
    } catch (e) { console.error(`[ChannelProvision] Falha ao atualizar canal ${channelId}:`, e); }

    logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_PROVISIONED", {
      instanceName, channelId, mode, imported: importing, alreadyExists: !!result.alreadyExists, state: result.state || "awaiting_qr",
    });

    return {
      ok: true, channelId, instanceName,
      qrBase64: result.qrBase64, state: result.state,
      alreadyExists: result.alreadyExists, imported: importing,
    };
  }

  /** Canais Evolution da org (sem segredos) — pra UI e retomada. */
  static status(orgId: string): { channels: Array<{ channelId: string; instanceName: string; status: string; connected: boolean; hasQr: boolean }> } {
    if (!orgId) return { channels: [] };
    const rows = db.prepare(
      `SELECT id, identifier, status FROM channels WHERE organization_id = ? AND provider IN ('evolution','evolution_go') ORDER BY created_at ASC`
    ).all(orgId) as any[];
    return {
      channels: rows.map((r) => ({
        channelId: r.id,
        instanceName: r.identifier,
        status: r.status,
        connected: r.status === "connected",
        hasQr: r.status !== "connected",
      })),
    };
  }
}
