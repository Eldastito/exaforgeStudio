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
import { getLastWebhookHit, isWebhookEnforced } from "./webhookSecurity.js";

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
  code?: "org_missing" | "instance_required" | "attributed_to_other_org" | "instance_not_found" | "evolution_failed" | "channel_required" | "channel_not_found" | "operation_in_progress";
  /** F4: id da operação de conexão (a mesma volta no conflito de corrida). */
  operationId?: string;
  /** F5: etapa de PASSKEY em andamento (sucesso pendente — nunca erro). O
   * código só trafega na resposta autenticada; jamais em log/audit. */
  passkey?: { stage: string; code?: string; openUrl?: string; misconfigured?: boolean };
}

const NEW_PREFIX = "zapflow_";

export class ChannelProvisioningService {
  /**
   * Nome de sistema pra instância NOVA de uma org geral (estável, sem colisão).
   * SANITIZADO (16/09/2026, relato do dono: QR não saía): orgId real é UUID com
   * HÍFENS, e forks do Evolution costumam rejeitar nome de instância com
   * caractere fora de [a-zA-Z0-9_] ou longo demais — o create falhava e o QR
   * nunca vinha. Só letras/dígitos/underscore, cap de 32 chars do orgId.
   * Determinístico → segue idempotente por (org, identifier).
   */
  static newInstanceName(orgId: string): string {
    if (!orgId) throw new Error("orgId inválido");
    const clean = String(orgId).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 32);
    return `${NEW_PREFIX}${clean || "org"}`;
  }

  /**
   * Instância EXISTENTE da org pra reconectar (16/09/2026 — a correção do "QR
   * não sai"): o botão "Conectar WhatsApp" (mode 'new') cunhava SEMPRE uma
   * instância nova, mesmo quando a org já tinha a dela (ex.: ExaForge
   * desconectada após o Desconectar) — criar instância nova no provedor podia
   * falhar e o número da empresa nunca era RECONECTADO. Agora 'new' reusa a
   * instância existente quando há uma. Preferência: connected > disconnected
   * (já pareou um dia) > awaiting_qr > provisioning (zumbi de tentativa
   * falhada); empate → mais recente. 'disabled' (pausa administrativa) nunca
   * é reusada.
   */
  private static reusableInstanceFor(orgId: string): string | null {
    const row = db.prepare(
      `SELECT identifier FROM channels
        WHERE organization_id = ? AND provider IN ('evolution','evolution_go') AND COALESCE(status,'') != 'disabled'
        ORDER BY CASE status WHEN 'connected' THEN 0 WHEN 'disconnected' THEN 1 WHEN 'awaiting_qr' THEN 2 ELSE 3 END,
                 updated_at DESC
        LIMIT 1`
    ).get(orgId) as any;
    return row?.identifier || null;
  }

  /**
   * F4 do PRD Conexão WhatsApp (20/09/2026) — LOCK de operação (padrão AC-012:
   * SELECT dentro da transação antes do INSERT). Duplo clique / 2 abas no
   * "Conectar" disparavam duas chamadas simultâneas ao provedor; o nome
   * determinístico reusa o canal, mas nada serializava a corrida. Só a 1ª
   * chamada vence; a 2ª recebe o operationId VIVO da operação em andamento.
   * 'running' com expires_at vencido é zumbi (processo caiu) — substituível.
   */
  private static readonly OPERATION_TTL_MS = 90_000; // > deadline do GetQr (35s + retries)
  private static beginOperation(orgId: string, type: string, key: string): { ok: boolean; id: string } {
    const tx = db.transaction(() => {
      const row = db.prepare(
        `SELECT id, state, expires_at FROM channel_connection_operations WHERE organization_id = ? AND idempotency_key = ?`
      ).get(orgId, key) as any;
      if (row && row.state === "running" && Date.parse(String(row.expires_at || "")) > Date.now()) {
        return { ok: false, id: String(row.id) }; // conflito: devolve a operação VIVA
      }
      const id = randomUUID();
      const expiresAt = new Date(Date.now() + this.OPERATION_TTL_MS).toISOString();
      if (row) {
        db.prepare(
          `UPDATE channel_connection_operations SET id = ?, type = ?, state = 'running', started_at = CURRENT_TIMESTAMP, expires_at = ?, completed_at = NULL, error_code = NULL
            WHERE organization_id = ? AND idempotency_key = ?`
        ).run(id, type, expiresAt, orgId, key);
      } else {
        db.prepare(
          `INSERT INTO channel_connection_operations (id, organization_id, idempotency_key, type, state, expires_at) VALUES (?, ?, ?, ?, 'running', ?)`
        ).run(id, orgId, key, type, expiresAt);
      }
      return { ok: true, id };
    });
    return tx();
  }

  private static finishOperation(orgId: string, opId: string, ok: boolean, errorCode?: string | null): void {
    try {
      db.prepare(
        `UPDATE channel_connection_operations SET state = ?, completed_at = CURRENT_TIMESTAMP, error_code = ? WHERE id = ? AND organization_id = ?`
      ).run(ok ? "succeeded" : "failed", errorCode || null, opId, orgId);
    } catch { /* best-effort — a operação zumbi expira pelo TTL */ }
  }

  /**
   * F2 do PRD Conexão WhatsApp (20/09/2026) — alvo EXPLÍCITO por channelId,
   * sempre validado contra a org da sessão. Canal de outro tenant ou id
   * inexistente devolvem o MESMO null (a rota responde 404 sem revelar que o
   * canal existe em outra organização).
   */
  private static evolutionChannelById(orgId: string, channelId: string): { id: string; identifier: string; status: string } | null {
    if (!orgId || !channelId) return null;
    return (db.prepare(
      `SELECT id, identifier, status FROM channels WHERE id = ? AND organization_id = ? AND provider IN ('evolution','evolution_go')`
    ).get(channelId, orgId) as any) || null;
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
      // 'new' = "Conectar WhatsApp": RECONECTA a instância que a org já tem;
      // só cunha zapflow_<org> quando a org não tem nenhuma (ver comentário
      // em reusableInstanceFor — correção do "QR não sai", 16/09/2026).
      instanceName = this.reusableInstanceFor(orgId) || this.newInstanceName(orgId);
    }

    // F4: LOCK da operação — só UMA conexão por (org, instância) por vez.
    // Duplo clique / 2 abas: a 2ª chamada recebe o operationId vivo e não
    // dispara nada no provedor.
    const op = this.beginOperation(orgId, "provision", `provision:${instanceName}`);
    if (!op.ok) {
      return { ok: false, error: "Já existe uma conexão em andamento pra este número — aguarde alguns segundos e tente de novo.", code: "operation_in_progress", operationId: op.id };
    }
    try {
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
          this.finishOperation(orgId, op.id, false, "evolution_failed");
          return { ok: false, error: `Falha ao registrar canal: ${e?.message || e}`, code: "evolution_failed", operationId: op.id };
        }
        if (importing) {
          logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_INSTANCE_IMPORTED", { instanceName, channelId });
        }
      }

      // Evolution: create(idempotente)+connect+QR pelo serviço consolidado.
      const result = await EvolutionService.provision(instanceName);
      if (!result.ok) {
        logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_PROVISION_FAILED", { instanceName, channelId, error: result.error });
        this.finishOperation(orgId, op.id, false, "evolution_failed");
        return { ok: false, channelId, instanceName, error: result.error, code: "evolution_failed", needsReset: result.needsReset, operationId: op.id };
      }

      try {
        db.prepare(`UPDATE channels SET status = ?, token_encrypted = COALESCE(?, token_encrypted), provider_observed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(result.state === "open" ? "connected" : result.state === "awaiting_passkey" ? "awaiting_passkey" : "awaiting_qr", EncryptionService.encrypt(result.token || null), channelId);
      } catch (e) { console.error(`[ChannelProvision] Falha ao atualizar canal ${channelId}:`, e); }

      logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_PROVISIONED", {
        instanceName, channelId, mode, imported: importing, alreadyExists: !!result.alreadyExists, state: result.state || "awaiting_qr", passkeyStage: result.passkey?.stage,
      });

      this.finishOperation(orgId, op.id, true);
      return {
        ok: true, channelId, instanceName,
        qrBase64: result.qrBase64, state: result.state,
        alreadyExists: result.alreadyExists, imported: importing,
        passkey: result.passkey,
        operationId: op.id,
      };
    } catch (e) {
      this.finishOperation(orgId, op.id, false, "exception");
      throw e;
    }
  }

  /** Canais Evolution da org (sem segredos) — pra UI e retomada. */
  static status(orgId: string): { channels: Array<{ channelId: string; instanceName: string; status: string; connected: boolean; hasQr: boolean; providerObservedAt: string | null }> } {
    if (!orgId) return { channels: [] };
    const rows = db.prepare(
      `SELECT id, identifier, status, provider_observed_at FROM channels WHERE organization_id = ? AND provider IN ('evolution','evolution_go') ORDER BY created_at ASC`
    ).all(orgId) as any[];
    return {
      channels: rows.map((r) => ({
        channelId: r.id,
        instanceName: r.identifier,
        status: r.status,
        connected: r.status === "connected",
        hasQr: r.status !== "connected",
        // F3: quando o provedor confirmou este estado pela última vez.
        // NULL = nunca observado (legado) — a UI mostra honesto, não esconde.
        providerObservedAt: r.provider_observed_at || null,
      })),
    };
  }

  /**
   * F3 do PRD Conexão WhatsApp (20/09/2026) — RECONCILIAÇÃO periódica
   * LEAK-AWARE. O webhook acelera a atualização, mas evento perdido deixava a
   * tela "conectada" com sessão morta pra sempre. Este passe re-lê a verdade
   * do provedor (via syncFromProvider) pra cada org com canal Evolution ativo.
   *
   * LEAK-AWARE (análise F0 §1): o evolution-go vaza um pool de Postgres por
   * StartInstance — este passe usa SÓ leitura de estado (/instance/all) e o
   * reparo de webhook (/webhook/set); NUNCA GetQr/StartInstance. Throttle
   * per-org (intervalo mínimo + jitter) + teto de orgs por tick protegem o
   * cluster mesmo em deploys com SCHEDULER_INTERVAL_MS curto. Best-effort:
   * falha de uma org nunca derruba o passe.
   */
  private static lastReconcileAt = new Map<string, number>();
  static readonly RECONCILE_MIN_INTERVAL_MS = 5 * 60_000;
  static async reconcilePass(opts: { maxOrgsPerTick?: number } = {}): Promise<{ reconciled: number; skipped: number }> {
    const out = { reconciled: 0, skipped: 0 };
    if (!EvolutionService.getConfig()) return out; // sem provedor configurado — não gasta nada
    const orgs = db.prepare(
      `SELECT DISTINCT organization_id o FROM channels WHERE provider IN ('evolution','evolution_go') AND COALESCE(status,'') != 'disabled'`
    ).all() as any[];
    const cap = Math.max(1, opts.maxOrgsPerTick ?? 10);
    for (const r of orgs) {
      if (out.reconciled >= cap) { out.skipped++; continue; }
      const now = Date.now();
      const jitter = Math.floor(Math.random() * 60_000);
      if (now - (this.lastReconcileAt.get(r.o) || 0) < this.RECONCILE_MIN_INTERVAL_MS + jitter) { out.skipped++; continue; }
      this.lastReconcileAt.set(r.o, now);
      try { await this.syncFromProvider(r.o, "system"); out.reconciled++; } catch { /* best-effort */ }
    }
    return out;
  }

  /**
   * 16/09/2026 (relato do dono: QR não sai NEM depois da reconexão) — RESET
   * EXPLÍCITO exposto de verdade. A F1.3 preservou `EvolutionService.
   * resetInstance` como "operação do operador" mas NUNCA lhe deu rota/botão:
   * quando a instância trava no provedor (sessão zumbi no whatsmeow, GetQr
   * devolve vazio pra sempre), o produto sinalizava `needsReset` e dizia "o
   * operador pode reiniciá-la" — sem existir onde. Este método fecha o beco:
   * acha a instância da org, busca o id no provedor e apaga+recria+QR; se a
   * instância nem existe lá, cai no provision normal (criar do zero é o
   * "reset" possível). A sessão pareada ATUAL é encerrada — por isso a UI
   * exige confirmação explícita (owner/admin). Auditado.
   */
  static async reset(orgId: string, actorUserId: string | null, channelId?: string | null): Promise<ChannelProvisionResult> {
    if (!orgId) return { ok: false, error: "organizationId ausente.", code: "org_missing" };
    // F2 do PRD Conexão WhatsApp (20/09/2026) — reset é DESTRUTIVO e precisa de
    // alvo: com channelId, reseta AQUELE canal; sem channelId, só quando a org
    // tem no máximo 1 canal não-desabilitado (a escolha implícita do
    // reusableInstanceFor com 2 números podia resetar o canal ERRADO).
    let instanceName: string;
    if (channelId) {
      const target = this.evolutionChannelById(orgId, channelId);
      if (!target) return { ok: false, error: "Canal não encontrado.", code: "channel_not_found" };
      instanceName = target.identifier;
    } else {
      const n = Number((db.prepare(
        `SELECT COUNT(*) n FROM channels WHERE organization_id = ? AND provider IN ('evolution','evolution_go') AND COALESCE(status,'') != 'disabled'`
      ).get(orgId) as any)?.n || 0);
      if (n > 1) return { ok: false, error: "Esta empresa tem mais de um canal de WhatsApp — informe qual canal reiniciar (channelId).", code: "channel_required" };
      instanceName = this.reusableInstanceFor(orgId) || this.newInstanceName(orgId);
    }

    // F4: mesmo LOCK do provision — reset concorrente (ou reset durante um
    // provision da mesma instância seria outra chave; a corrida perigosa é
    // reset×reset) devolve o operationId vivo sem tocar o provedor.
    const op = this.beginOperation(orgId, "reset", `reset:${instanceName}`);
    if (!op.ok) {
      return { ok: false, error: "Já existe um reset em andamento pra este número — aguarde alguns segundos.", code: "operation_in_progress", operationId: op.id };
    }
    try {
      const found = await EvolutionService.findInstance(instanceName);
      const result = found?.id
        ? await EvolutionService.resetInstance(instanceName, found.id)
        : await EvolutionService.provision(instanceName);

      let existing = this.channelForOrg(orgId, instanceName);
      let targetChannelId = existing?.id;
      if (!targetChannelId) {
        targetChannelId = randomUUID();
        try {
          db.prepare(`INSERT INTO channels (id, organization_id, provider, name, identifier, status) VALUES (?, ?, 'evolution', ?, ?, 'provisioning')`)
            .run(targetChannelId, orgId, `WhatsApp (${instanceName})`, instanceName);
        } catch (e: any) {
          this.finishOperation(orgId, op.id, false, "evolution_failed");
          return { ok: false, error: `Falha ao registrar canal: ${e?.message || e}`, code: "evolution_failed", operationId: op.id };
        }
      }

      if (!result.ok) {
        logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_RESET_FAILED", { instanceName, channelId: targetChannelId, hadProviderId: !!found?.id, error: result.error });
        this.finishOperation(orgId, op.id, false, "evolution_failed");
        return { ok: false, channelId: targetChannelId, instanceName, error: result.error, code: "evolution_failed", operationId: op.id };
      }
      try {
        db.prepare(`UPDATE channels SET status = ?, token_encrypted = COALESCE(?, token_encrypted), provider_observed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(result.state === "open" ? "connected" : result.state === "awaiting_passkey" ? "awaiting_passkey" : "awaiting_qr", EncryptionService.encrypt(result.token || null), targetChannelId);
      } catch (e) { console.error(`[ChannelProvision] Falha ao atualizar canal ${targetChannelId} pós-reset:`, e); }
      logAuthEvent(orgId, actorUserId, actorUserId, "WHATSAPP_INSTANCE_RESET", { instanceName, channelId: targetChannelId, hadProviderId: !!found?.id, state: result.state || "awaiting_qr" });
      this.finishOperation(orgId, op.id, true);
      return { ok: true, channelId: targetChannelId, instanceName, qrBase64: result.qrBase64, state: result.state, passkey: result.passkey, operationId: op.id };
    } catch (e) {
      this.finishOperation(orgId, op.id, false, "exception");
      throw e;
    }
  }

  /**
   * 16/09/2026 — DIAGNÓSTICO honesto e token-safe da conexão com o provedor,
   * pro operador (e pro suporte) verem ONDE o fluxo quebra sem chutar:
   * config presente? provedor alcançável (status/latência/erro)? quantas
   * instâncias existem? a da org existe lá? Nunca devolve apiKey nem a URL
   * completa (só o host).
   */
  static async diagnose(orgId: string): Promise<any> {
    const cfg = EvolutionService.getConfig();
    const out: any = {
      configured: {
        evolutionBaseUrl: !!process.env.EVOLUTION_BASE_URL,
        evolutionApiKey: !!process.env.EVOLUTION_API_KEY,
        appUrl: !!process.env.APP_URL,
      },
      providerHost: null,
      reachable: { ok: false, error: cfg ? undefined : "EVOLUTION_BASE_URL/EVOLUTION_API_KEY não configurados no servidor" },
      instancesInProvider: null,
      orgInstance: null,
      channels: this.status(orgId).channels.map((c) => ({ instanceName: c.instanceName, status: c.status })),
      lastProvisionError: null,
    };
    // 17/09/2026 — o RECEBIMENTO é metade do diagnóstico: mostra a URL de
    // webhook que registramos no provedor (secret redigido), se a exigência do
    // segredo está ligada e o último hit recebido — "nunca recebeu" com sessão
    // pareada é a assinatura de webhook não registrado/URL errada/secret ausente.
    try {
      const whUrl = cfg?.webhookUrl || null;
      out.webhook = {
        urlEffective: whUrl ? whUrl.replace(/(secret=)[^&]+/, "$1***") : null,
        secretIncluded: !!whUrl?.includes("secret="),
        enforced: isWebhookEnforced(),
        appUrlConfigured: !!process.env.APP_URL,
        localhostWarning: !!whUrl?.includes("localhost"),
        lastHit: getLastWebhookHit(),
      };
    } catch { /* best-effort */ }
    // 16/09 (3º relato: "não está nem criando a instância") — o ERRO REAL do
    // último provision/reset falho já fica gravado na auditoria; surfaçá-lo no
    // diagnóstico tira a dependência de toast perdido. Redigido (só o erro e
    // quando), org-scoped.
    try {
      const row = db.prepare(
        `SELECT event_type, metadata_json, created_at FROM auth_audit_logs
          WHERE organization_id = ? AND event_type IN ('WHATSAPP_PROVISION_FAILED','WHATSAPP_RESET_FAILED')
          ORDER BY created_at DESC LIMIT 1`
      ).get(orgId) as any;
      if (row) {
        let err = "";
        try { err = String(JSON.parse(row.metadata_json || "{}")?.error || ""); } catch { /* noop */ }
        // 300 e não 200: o erro agora carrega também o último log da instância
        // (motivo real do QR vazio) — 200 cortava justamente essa parte.
        out.lastProvisionError = { at: row.created_at, kind: row.event_type, error: err.slice(0, 300) || null };
      }
    } catch { /* best-effort */ }
    if (!cfg) return out;
    try { out.providerHost = new URL(cfg.baseUrl).host; } catch { out.providerHost = "(URL inválida)"; }
    const t0 = Date.now();
    try {
      const resp: any = await fetch(`${cfg.baseUrl}/instance/all`, { headers: { apikey: cfg.apiKey }, ...(typeof (AbortSignal as any)?.timeout === "function" ? { signal: (AbortSignal as any).timeout(12_000) } : {}) });
      out.reachable = { ok: !!resp.ok, status: resp.status, latencyMs: Date.now() - t0 };
      if (resp.ok) {
        let list: any[] = [];
        try { const d = await resp.json(); list = Array.isArray(d?.data) ? d.data : (Array.isArray(d) ? d : []); } catch { /* corpo não-JSON */ }
        out.instancesInProvider = list.length;
        const name = this.reusableInstanceFor(orgId) || this.newInstanceName(orgId);
        const hit = list.find((i: any) => i?.name === name || i?.instanceName === name);
        out.orgInstance = {
          name, existsInProvider: !!hit,
          // O estado REAL da sessão no provedor (o "Status: open" do manager) —
          // 'open' aqui com canal awaiting_qr = use o Sincronizar. Lê o
          // `connected` BOOLEANO do evolution-go (providerStateOf, 17/09).
          providerState: hit ? EvolutionService.providerStateOf(hit) || null : null,
          // 17/09 — o que está REGISTRADO na instância (o GO expõe webhook e
          // events no /instance/all): webhook vazio/errado aqui = inbound morto,
          // seja qual for o estado da sessão. Secret redigido.
          webhookRegistered: hit?.webhook ? String(hit.webhook).replace(/(secret=)[^&]+/, "$1***") : null,
          subscribedEvents: hit?.events ?? null,
        };
        // 16/09 (4º relato: "criou a instância mas o QR não sai") — os LOGS da
        // instância no provedor são onde o evolution-go conta POR QUE a sessão
        // whatsmeow não gerou QR (Connect() com o WhatsApp falha em goroutine,
        // silencioso pro GetQr). Redigidos/truncados no EvolutionService.
        if (hit?.id) {
          try {
            out.providerLogs = await EvolutionService.getInstanceLogs(name, undefined, { instanceId: hit.id, limit: 15 });
          } catch { out.providerLogs = []; }
        }
      } else {
        try { out.reachable.bodySnippet = String(await resp.text()).slice(0, 160); } catch { /* noop */ }
      }
    } catch (e: any) {
      out.reachable = { ok: false, error: String(e?.message || e).slice(0, 160), latencyMs: Date.now() - t0 };
    }
    return out;
  }

  /**
   * 17/09/2026 (instância "Conectado" no manager, canais presos em awaiting_qr,
   * nenhuma mensagem fluindo) — SINCRONIZA os canais com a VERDADE do provedor.
   * O único caminho pra 'connected' era o webhook do provedor; se o webhook não
   * chega (não registrado, URL sem secret com exigência ligada, APP_URL errada),
   * o canal fica awaiting_qr PRA SEMPRE mesmo com a sessão pareada. Aqui:
   *  - lê /instance/all (a mesma fonte do "Status: open" do manager);
   *  - instância NÃO existe mais no provedor → canal vira 'disconnected'
   *    (UPDATE, nunca DELETE — convenção nº 9; era o caso dos canais fantasma
   *    "ExaForge"/"TOULON" apontando pra instâncias apagadas);
   *  - instância OPEN → canal vira 'connected', o TOKEN do canal é atualizado
   *    pro do provedor (token velho de instância recriada quebrava envio e
   *    subscribe) e o WEBHOOK é RE-REGISTRADO com a URL atual (com secret) —
   *    é isso que devolve o fluxo de mensagens sem re-parear;
   *  - instância existe mas não-open → canal 'connected' é rebaixado a
   *    'disconnected' (evidência do provedor, RF-02); os demais ficam como estão.
   * 'disabled' (pausa administrativa) nunca é tocado. Isolado por org; auditado.
   */
  static async syncFromProvider(orgId: string, actorUserId: string | null, channelId?: string | null): Promise<{
    ok: boolean; providerReachable: boolean; error?: string; code?: "channel_not_found";
    channels: Array<{ instanceName: string; before: string; after: string; providerState: string | null; webhookRegistered?: boolean; tokenUpdated?: boolean }>;
  }> {
    if (!orgId) return { ok: false, providerReachable: false, error: "organizationId ausente.", channels: [] };
    // F2 do PRD Conexão WhatsApp: sync é reconciliação (não-destrutivo) — o
    // channelId é FILTRO opcional, sem trava de ambiguidade; validado antes de
    // gastar chamada no provedor.
    if (channelId && !this.evolutionChannelById(orgId, channelId)) {
      return { ok: false, providerReachable: false, error: "Canal não encontrado.", code: "channel_not_found", channels: [] };
    }
    const instances = await EvolutionService.listInstances();
    if (instances === null) {
      return { ok: false, providerReachable: false, error: "Provedor inacessível (ou EVOLUTION_BASE_URL/EVOLUTION_API_KEY ausentes).", channels: [] };
    }
    const byName = new Map(instances.map((i) => [i.name, i]));
    const rows = db.prepare(
      `SELECT id, identifier, status, token_encrypted FROM channels
        WHERE organization_id = ? AND provider IN ('evolution','evolution_go') AND COALESCE(status,'') != 'disabled'
          ${channelId ? "AND id = ?" : ""}`
    ).all(...(channelId ? [orgId, channelId] : [orgId])) as any[];
    const report: Array<{ instanceName: string; before: string; after: string; providerState: string | null; webhookRegistered?: boolean; tokenUpdated?: boolean }> = [];
    for (const r of rows) {
      const inst = byName.get(String(r.identifier));
      const before = String(r.status || "");
      let after = before;
      let webhookRegistered: boolean | undefined;
      let tokenUpdated = false;
      // F3: o /instance/all respondeu — TODA linha reconciliada ganha carimbo
      // de observação (inclusive "instância não existe lá", que é evidência).
      try { db.prepare(`UPDATE channels SET provider_observed_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(r.id, orgId); } catch { /* best-effort */ }
      if (!inst) {
        if (before !== "disconnected") {
          after = "disconnected";
          db.prepare(`UPDATE channels SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(r.id, orgId);
        }
      } else if (inst.state === "open" || inst.state === "connected") {
        // Token do provedor é a verdade (instância recriada gera token novo).
        let currentToken = "";
        try { currentToken = EncryptionService.decrypt(r.token_encrypted) || ""; } catch { currentToken = String(r.token_encrypted || ""); }
        const providerToken = inst.token || "";
        if (providerToken && providerToken !== currentToken) {
          db.prepare(`UPDATE channels SET token_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`)
            .run(EncryptionService.encrypt(providerToken), r.id, orgId);
          tokenUpdated = true;
        }
        // Re-registra o webhook na sessão JÁ pareada — devolve o inbound sem QR novo.
        try {
          const reg = await EvolutionService.registerWebhook(String(r.identifier), providerToken || currentToken);
          webhookRegistered = reg.ok;
        } catch { webhookRegistered = false; }
        if (before !== "connected") {
          after = "connected";
          db.prepare(`UPDATE channels SET status = 'connected', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(r.id, orgId);
        }
      } else if (before === "connected") {
        // Provedor diz que a sessão NÃO está aberta — rebaixa com evidência.
        after = "disconnected";
        db.prepare(`UPDATE channels SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(r.id, orgId);
      }
      report.push({ instanceName: String(r.identifier), before, after, providerState: inst ? inst.state : null, webhookRegistered, tokenUpdated });
      if (after !== before || tokenUpdated || webhookRegistered !== undefined) {
        logAuthEvent(orgId, actorUserId, r.id, "CHANNEL_SYNCED_FROM_PROVIDER", { instanceName: r.identifier, before, after, providerState: inst?.state ?? null, webhookRegistered, tokenUpdated });
      }
    }
    return { ok: true, providerReachable: true, channels: report };
  }

  /**
   * WZ (pedido do dono, 15/09/2026) — DESCONECTAR o WhatsApp pelo ZapFlow.
   * O card mostrava "conectado" (status legado no banco) sem ação de saída.
   * Faz duas coisas, nesta ordem:
   *  1. LOGOUT best-effort no provedor (`EvolutionService.logoutInstance` —
   *     encerra a sessão pareada; NÃO apaga a instância, que fica pronta pra
   *     reconectar por QR). Sem config/instância morta → segue honesto.
   *  2. Marca os canais Evolution da org como `disconnected` no banco —
   *     UPDATE, nunca DELETE (histórico/contatos referenciam o canal,
   *     convenção nº 9). O card vira "Desconectado" com o botão Conectar.
   * `providerLogout:false` no retorno = a sessão pode seguir viva no celular;
   * a UI manda conferir Aparelhos conectados. Isolado por org; auditado.
   */
  static async disconnect(orgId: string, actorUserId: string | null, channelId?: string | null): Promise<{ ok: boolean; disconnected: number; providerLogout: boolean; error?: string; code?: "channel_required" | "channel_not_found" }> {
    if (!orgId) return { ok: false, disconnected: 0, providerLogout: false };
    // F2 do PRD Conexão WhatsApp (20/09/2026) — alvo por channelId: com id,
    // desconecta SÓ aquele canal; sem id, só quando há no máximo 1 canal
    // ACIONÁVEL (não-desabilitado e ainda não-desconectado) — com 2 números,
    // "desconectar" sem alvo derrubava os dois.
    let rows: any[];
    if (channelId) {
      const target = this.evolutionChannelById(orgId, channelId);
      if (!target) return { ok: false, disconnected: 0, providerLogout: false, error: "Canal não encontrado.", code: "channel_not_found" };
      // 'disabled' é pausa ADMINISTRATIVA (outra dimensão) — não vira 'disconnected'.
      rows = target.status === "disabled" ? [] : [target];
    } else {
      rows = db.prepare(
        `SELECT id, identifier, status FROM channels WHERE organization_id = ? AND provider IN ('evolution','evolution_go') AND COALESCE(status,'') != 'disabled'`
      ).all(orgId) as any[];
      const actionable = rows.filter((r) => String(r.status || "") !== "disconnected");
      if (actionable.length > 1) {
        return { ok: false, disconnected: 0, providerLogout: false, error: "Esta empresa tem mais de um canal de WhatsApp ativo — informe qual canal desconectar (channelId).", code: "channel_required" };
      }
    }
    // F1 do PRD Conexão WhatsApp (20/09/2026) — BLOQUEIO LOCAL PRIMEIRO. Antes
    // o logout remoto rodava ANTES do UPDATE: um provedor lento/mudo atrasava o
    // bloqueio e, com o processo caindo no meio, o canal seguia elegível pra
    // envio. Agora todos os canais viram 'disconnected' de imediato (o gate do
    // MessageProviderService para os envios na hora) e o logout no provedor é
    // best-effort DEPOIS — falha remota nunca reabre o canal localmente.
    for (const r of rows) {
      db.prepare(`UPDATE channels SET status = 'disconnected', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND organization_id = ?`).run(r.id, orgId);
    }
    let providerLogout = false;
    for (const r of rows) {
      let thisLogout = false;
      try { if (await EvolutionService.logoutInstance(r.identifier)) { providerLogout = true; thisLogout = true; } } catch { /* best-effort */ }
      logAuthEvent(orgId, actorUserId, r.id, "CHANNEL_WHATSAPP_DISCONNECTED", { instanceName: r.identifier, providerLogout: thisLogout });
    }
    return { ok: true, disconnected: rows.length, providerLogout };
  }
}
