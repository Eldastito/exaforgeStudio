/**
 * ADR-154 Fatia 4.1 — FalaTuSoloWhatsAppService.
 *
 * Provisionamento da instância Evolution DEDICADA por org Solo:
 *
 *  1. Verifica que a org tem blueprint com `mode='solo'` (guardrail RN-154):
 *     provision só faz sentido pra org single-purpose; org suíte usa o pool
 *     compartilhado da plataforma.
 *  2. Marca `organization_settings.whatsapp_instance_kind='dedicated'` — a
 *     partir daqui a org NÃO usa o número interno compartilhado; usa o próprio.
 *  3. Cria (ou reusa, idempotente) a instância na Evolution API via
 *     EvolutionService.provision — nome derivado do orgId, sem colisão.
 *  4. Cria a linha em `channels` com `kind='internal'` — o webhookProcessor
 *     roteia mensagens deste canal DIRETO pro FalaTu (linha 170), pulando
 *     Controller/Coordenador/Diretor IA. Isso é o que sustenta a expectativa
 *     do RN-154 "assistente pessoal, não intervém na vida do dono do número"
 *     (a F4.2 vai plugar `falatu_reply_mode` sobre este mesmo desvio).
 *  5. Retorna QR base64 pra UI mostrar.
 *
 * Idempotente: chamar 2× a mesma org só re-obtém QR novo (útil se o usuário
 * fechou a tela antes de escanear). Não duplica canal, não duplica instância.
 *
 * Best-effort no ONBOARDING (rota /api/onboarding-solo chama assim): erro de
 * Evolution não derruba o cadastro. Blocking na rota EXPLÍCITA (POST
 * /api/falatu-solo/whatsapp/provision): usuário pediu, se falhou reporta.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { EvolutionService } from "./EvolutionService.js";
import { logAuthEvent } from "./auditLog.js";
import { VerticalBlueprintService } from "./VerticalBlueprintService.js";

export interface ProvisionResult {
  ok: boolean;
  channelId?: string;
  instanceName?: string;
  qrBase64?: string;
  state?: string; // 'open' se instância já está pareada
  alreadyExists?: boolean; // instância já existia na Evolution
  error?: string;
}

export interface SoloWhatsAppStatus {
  kind: "shared" | "dedicated";
  channelId?: string;
  instanceName?: string;
  connected: boolean;
  hasQr: boolean; // proxy: se channel existe mas status != 'connected', UI pode oferecer "gerar QR"
}

export class FalaTuSoloWhatsAppService {
  /**
   * Verifica se a org tem blueprint SOLO aplicado. É pré-condição pra provision
   * dedicado — SUITE não faz sentido ter Evolution isolada (usa pool interno).
   * A checagem consulta `organization_blueprints` + o blueprint do catálogo.
   */
  static assertSoloOrg(orgId: string): void {
    const asg = db
      .prepare(`SELECT blueprint_key, blueprint_version FROM organization_blueprints WHERE organization_id = ?`)
      .get(orgId) as { blueprint_key?: string; blueprint_version?: number } | undefined;
    if (!asg?.blueprint_key) {
      throw new Error(`Org ${orgId} não tem blueprint aplicado — provision dedicado exige blueprint solo.`);
    }
    const bp = VerticalBlueprintService.getBlueprintByKeyVersion(asg.blueprint_key, Number(asg.blueprint_version || 1));
    if (!bp) throw new Error(`Blueprint ${asg.blueprint_key} v${asg.blueprint_version} não encontrado.`);
    if (bp.mode !== "solo") {
      throw new Error(`Blueprint '${bp.key}' é '${bp.mode}', não 'solo'. Provision dedicado só pra orgs Solo.`);
    }
  }

  /**
   * Cria (ou reusa) instância Evolution dedicada e canal `kind='internal'`
   * pra org Solo. Chamado tanto pelo onboarding (best-effort, catch externo)
   * quanto pela rota /provision (throw se falhar).
   *
   * Passos numa transação lógica (sem BEGIN/COMMIT porque a chamada de rede
   * externa dominaria — se rollbackar por rede lenta seria pior UX):
   * 1) marca flag na org
   * 2) obtém/cria linha em channels
   * 3) chama Evolution (rede)
   * 4) atualiza token/status no canal
   *
   * O passo 3 pode demorar. Se falhar, o canal segue com status='disconnected'
   * e o usuário pode chamar /provision de novo depois pra re-tentar QR.
   */
  static async provision(orgId: string, actorUserId: string | null): Promise<ProvisionResult> {
    if (!orgId) return { ok: false, error: "orgId obrigatório" };
    try {
      this.assertSoloOrg(orgId);
    } catch (e: any) {
      return { ok: false, error: e?.message || "Org não é Solo" };
    }

    // 1. Marca a flag (idempotente). ADR-154 F4.2: junto com 'dedicated',
    //    seta também `falatu_reply_mode='trigger_only'` — é o pacote Solo.
    //    Se o dono quiser voltar pra 'always' (não recomendado — vira quase
    //    uma suíte), o toggle vai na FalaTuSettingsView (Fase 3).
    try {
      db.prepare(`UPDATE organization_settings SET whatsapp_instance_kind = 'dedicated', falatu_reply_mode = 'trigger_only' WHERE organization_id = ?`).run(orgId);
    } catch (e) {
      console.error(`[FalaTuSoloWA] Falha ao setar whatsapp_instance_kind pra ${orgId}:`, e);
    }

    const instanceName = EvolutionService.instanceNameForOrg(orgId);

    // 2. Canal — reusa se existe (idempotente); cria se não.
    let existing = db
      .prepare(`SELECT id, status FROM channels WHERE organization_id = ? AND provider = ? AND identifier = ?`)
      .get(orgId, "evolution", instanceName) as { id?: string; status?: string } | undefined;
    let channelId = existing?.id;
    if (!channelId) {
      channelId = randomUUID();
      try {
        db.prepare(`
          INSERT INTO channels (id, organization_id, provider, kind, name, identifier, status)
          VALUES (?, ?, 'evolution', 'internal', ?, ?, 'provisioning')
        `).run(channelId, orgId, `WhatsApp (${instanceName})`, instanceName);
      } catch (e: any) {
        return { ok: false, error: `Falha ao registrar canal: ${e?.message || e}` };
      }
    }

    // 3. Evolution: create + connect + QR (best-effort do ponto de vista
    //    da rede — falha aqui NÃO desfaz o canal; usuário pode re-provision).
    const result = await EvolutionService.provision(instanceName);
    if (!result.ok) {
      logAuthEvent(orgId, actorUserId, actorUserId, "FALATU_SOLO_WHATSAPP_PROVISION_FAILED", {
        instanceName, channelId, error: result.error,
      });
      return { ok: false, channelId, instanceName, error: result.error };
    }

    // 4. Persiste token + status no canal.
    try {
      db.prepare(`UPDATE channels SET status = ?, token_encrypted = COALESCE(?, token_encrypted), updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .run(result.state === "open" ? "connected" : "awaiting_qr", result.token || null, channelId);
    } catch (e) {
      console.error(`[FalaTuSoloWA] Falha ao atualizar canal ${channelId}:`, e);
    }

    logAuthEvent(orgId, actorUserId, actorUserId, "FALATU_SOLO_WHATSAPP_PROVISIONED", {
      instanceName, channelId,
      alreadyExists: !!result.alreadyExists,
      state: result.state || "awaiting_qr",
    });

    return {
      ok: true,
      channelId,
      instanceName,
      qrBase64: result.qrBase64,
      state: result.state,
      alreadyExists: result.alreadyExists,
    };
  }

  /**
   * Status atual: kind da org + info do canal dedicado se existir. Usada
   * pela UI da Fase 3 (FalaTuSettingsView) e por health-check.
   */
  static getStatus(orgId: string): SoloWhatsAppStatus {
    const settings = db
      .prepare(`SELECT whatsapp_instance_kind FROM organization_settings WHERE organization_id = ?`)
      .get(orgId) as { whatsapp_instance_kind?: string } | undefined;
    const kind = (settings?.whatsapp_instance_kind === "dedicated" ? "dedicated" : "shared") as "shared" | "dedicated";

    if (kind !== "dedicated") return { kind, connected: false, hasQr: false };

    const instanceName = EvolutionService.instanceNameForOrg(orgId);
    const channel = db
      .prepare(`SELECT id, status FROM channels WHERE organization_id = ? AND provider = ? AND identifier = ?`)
      .get(orgId, "evolution", instanceName) as { id?: string; status?: string } | undefined;

    return {
      kind,
      instanceName,
      channelId: channel?.id,
      connected: channel?.status === "connected",
      hasQr: !!channel && channel.status !== "connected",
    };
  }
}
