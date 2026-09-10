/**
 * ChannelBindingService — RESOLVEDOR ÚNICO de canal por finalidade
 * (PRD WhatsApp Unificado — F2.2 / RF-03 / CA-03).
 *
 * Separa "qual conexão existe" (`channels`) de "quem/o quê pode usá-la"
 * (`channel_feature_bindings`). É a fonte única que substitui progressivamente
 * os ~20 SQLs de "primeiro canal" espalhados (o religamento dos produtores é a
 * Fase 6 — aqui o resolvedor só NASCE, testado, sem mudar comportamento).
 *
 * Precedência (RF-03): regra explícita da UNIDADE/finalidade →
 * regra explícita da ORG/finalidade → (nenhuma) `no_binding`. Dentro do mesmo
 * escopo, `priority` DESC desempata; depois o binding mais recente.
 *
 * Guardrails:
 *  - Isolamento (INV-01): toda query filtra organization_id; o canal do binding
 *    é revalidado como pertencente à org e não desabilitado.
 *  - Direção: `inbound`/`outbound` gate por sentido; finalidade desabilitada
 *    (nenhum binding habilitado pra direção) → NÃO resolve (não "chuta" canal).
 *  - Fallback só quando expressamente configurado (`fallback_channel_id`), e
 *    ainda assim revalidado (org + não desabilitado).
 *  - `decide()` sempre devolve um MOTIVO (`reason`) — nunca decisão muda.
 *
 * NÃO decide sozinho ligar/desligar `ai_enabled` (isso é outra política) nem
 * cria tabela de alerta. Read-only sobre bindings + channels.
 */
import { randomUUID } from "node:crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";

export type BindingDirection = "inbound" | "outbound";

/**
 * F2.4 (CA-03) — erro tipado quando a FINALIDADE está desligada pra saída. O
 * SINK de envio lança isso pra o caller registrar o bloqueio (não como `failed`)
 * e não reenviar. Só dispara quando a org CONFIGUROU usos e desligou esta
 * finalidade (nunca no comportamento herdado sem binding).
 */
export class OutboundFeatureDisabledError extends Error {
  code = "outbound_blocked:feature_disabled" as const;
  constructor(public feature: string, public reason: string) {
    super(`Envio bloqueado: finalidade '${feature}' desligada (${reason})`);
    this.name = "OutboundFeatureDisabledError";
  }
}

/**
 * Finalidades VÁLIDAS (RF-03 §17.2 "finalidades válidas"). A escrita rejeita
 * chave fora desta lista — evita binding-lixo e mantém o vocabulário estável
 * (a UI lista a partir daqui). Aditiva: novas finalidades entram aqui quando um
 * produtor conhecido passar a resolver por elas (Fase 6).
 */
export const KNOWN_FEATURES = [
  "atendimento",  // resposta ao cliente / CRM
  "gestao",       // Fala Tu / Controller / Diretor (uso interno)
  "campanhas",    // marketing / disparos
  "cobranca",     // régua de cobrança / fiado / PIX
  "agenda",       // confirmação/lembrete de compromisso
  "prospeccao",   // prospecção ativa
  "recompra",     // recompra / carrinho / recuperação
  "satisfacao",   // pós-venda / NPS
  "clinica",      // avisos clínicos
  "escola",       // comunicação escolar
  "vendas",       // orçamento / follow-up de venda ao cliente (F6.3d)
  "compras",      // cotação com fornecedor / suprimentos (F6.3d)
] as const;
export type FeatureKey = (typeof KNOWN_FEATURES)[number];
export function isKnownFeature(k: string): boolean { return (KNOWN_FEATURES as readonly string[]).includes(String(k || "")); }

export interface BindingDecision {
  ok: boolean;
  channelId: string | null;
  /** 'unit' | 'org' | 'fallback' — de onde veio a decisão. */
  scope: "unit" | "org" | "fallback" | null;
  reason: string;
  policyVersion?: number;
  code?: "resolved" | "no_binding" | "feature_disabled" | "channel_unavailable" | "org_missing";
}

interface BindingRow {
  id: string;
  channel_id: string;
  unit_id: string | null;
  inbound: number;
  outbound: number;
  priority: number;
  fallback_channel_id: string | null;
  policy_version: number;
}

export class ChannelBindingService {
  /** Canal existe, é da org e não está desabilitado? (revalidação dura.) */
  private static channelUsable(orgId: string, channelId: string | null): boolean {
    if (!channelId) return false;
    const c = db.prepare(
      `SELECT 1 FROM channels WHERE id = ? AND organization_id = ? AND COALESCE(status,'') != 'disabled' LIMIT 1`
    ).get(channelId, orgId);
    return !!c;
  }

  /**
   * Resolve o canal para (org, finalidade, direção), opcionalmente por unidade.
   * Só leitura. Devolve decisão + motivo; nunca lança.
   */
  static resolve(
    orgId: string,
    featureKey: string,
    opts?: { unitId?: string | null; direction?: BindingDirection },
  ): BindingDecision {
    if (!orgId) return { ok: false, channelId: null, scope: null, reason: "organização ausente", code: "org_missing" };
    const feature = String(featureKey || "").trim();
    if (!feature) return { ok: false, channelId: null, scope: null, reason: "finalidade ausente", code: "no_binding" };
    const direction: BindingDirection = opts?.direction === "inbound" ? "inbound" : "outbound";
    const unitId = opts?.unitId ? String(opts.unitId) : null;

    let rows: BindingRow[];
    try {
      rows = db.prepare(
        `SELECT id, channel_id, unit_id, inbound, outbound, priority, fallback_channel_id, policy_version
           FROM channel_feature_bindings
          WHERE organization_id = ? AND feature_key = ?`
      ).all(orgId, feature) as any[];
    } catch { rows = []; }

    if (!rows.length) {
      return { ok: false, channelId: null, scope: null, reason: "sem uso configurado para esta finalidade (comportamento herdado)", code: "no_binding" };
    }

    const dirOn = (r: BindingRow) => (direction === "inbound" ? r.inbound : r.outbound) === 1;
    // Ordena por prioridade DESC (desempate estável pelo id).
    const byPriority = (a: BindingRow, b: BindingRow) => (b.priority - a.priority) || (a.id < b.id ? -1 : 1);

    // 1) Regra explícita da UNIDADE (só quando a chamada tem unidade).
    if (unitId) {
      const unitRules = rows.filter((r) => r.unit_id === unitId && dirOn(r)).sort(byPriority);
      const hit = unitRules.find((r) => this.channelUsable(orgId, r.channel_id));
      if (hit) return { ok: true, channelId: hit.channel_id, scope: "unit", reason: "regra da unidade", policyVersion: hit.policy_version, code: "resolved" };
      // Fallback explícito da unidade.
      const fb = unitRules.find((r) => this.channelUsable(orgId, r.fallback_channel_id));
      if (fb) return { ok: true, channelId: fb.fallback_channel_id, scope: "fallback", reason: "fallback configurado (unidade)", policyVersion: fb.policy_version, code: "resolved" };
    }

    // 2) Regra explícita da ORG (unit_id NULL).
    const orgRules = rows.filter((r) => r.unit_id == null && dirOn(r)).sort(byPriority);
    const orgHit = orgRules.find((r) => this.channelUsable(orgId, r.channel_id));
    if (orgHit) return { ok: true, channelId: orgHit.channel_id, scope: "org", reason: "regra da organização", policyVersion: orgHit.policy_version, code: "resolved" };
    const orgFb = orgRules.find((r) => this.channelUsable(orgId, r.fallback_channel_id));
    if (orgFb) return { ok: true, channelId: orgFb.fallback_channel_id, scope: "fallback", reason: "fallback configurado (organização)", policyVersion: orgFb.policy_version, code: "resolved" };

    // Há binding, mas nenhum habilitado nesta direção OU o canal está indisponível.
    const anyEnabledDir = rows.some(dirOn);
    if (!anyEnabledDir) {
      return { ok: false, channelId: null, scope: null, reason: `finalidade desligada para ${direction}`, code: "feature_disabled" };
    }
    return { ok: false, channelId: null, scope: null, reason: "canal do uso indisponível/desabilitado", code: "channel_unavailable" };
  }

  /**
   * Cria ou atualiza um binding (RF-03 §17.2 "alterar usos"). Chave natural
   * (org, feature, unit, channel): se já existe, ATUALIZA campos + incrementa
   * policy_version; senão INSERE (policy_version=1). Concorrência otimista:
   * `ifPolicyVersion` (opcional) só aplica se a versão atual bater — senão
   * `version_conflict` (rejeita alteração com versão antiga). Valida finalidade
   * conhecida e que canal/fallback pertencem à org. Auditado.
   */
  static upsert(
    orgId: string,
    actorUserId: string | null,
    input: {
      channelId: string;
      featureKey: string;
      unitId?: string | null;
      inbound?: boolean;
      outbound?: boolean;
      executionMode?: string;
      priority?: number;
      fallbackChannelId?: string | null;
      ifPolicyVersion?: number;
      origin?: string;
    },
  ): { ok: boolean; id?: string; policyVersion?: number; error?: string; code?: string } {
    if (!orgId) return { ok: false, error: "organização ausente", code: "org_missing" };
    const feature = String(input.featureKey || "").trim();
    if (!isKnownFeature(feature)) return { ok: false, error: `finalidade inválida: ${feature || "(vazia)"}`, code: "invalid_feature" };
    if (!this.channelInOrg(orgId, input.channelId)) return { ok: false, error: "canal não pertence à organização", code: "channel_not_in_org" };
    if (input.fallbackChannelId && !this.channelInOrg(orgId, input.fallbackChannelId)) {
      return { ok: false, error: "canal de fallback não pertence à organização", code: "fallback_not_in_org" };
    }
    const unitId = input.unitId ? String(input.unitId) : null;
    const inbound = input.inbound === false ? 0 : 1;
    const outbound = input.outbound === false ? 0 : 1;
    const execMode = input.executionMode === "manual" ? "manual" : "auto";
    const priority = Number.isFinite(input.priority as number) ? Math.trunc(input.priority as number) : 0;
    const fallback = input.fallbackChannelId ? String(input.fallbackChannelId) : null;

    const existing = db.prepare(
      `SELECT id, policy_version FROM channel_feature_bindings
        WHERE organization_id = ? AND feature_key = ? AND COALESCE(unit_id,'') = COALESCE(?, '') AND channel_id = ?`
    ).get(orgId, feature, unitId, input.channelId) as any;

    if (existing) {
      if (input.ifPolicyVersion != null && Number(input.ifPolicyVersion) !== Number(existing.policy_version)) {
        return { ok: false, error: "a política foi alterada por outra pessoa; recarregue", code: "version_conflict" };
      }
      const nextVersion = Number(existing.policy_version) + 1;
      db.prepare(
        `UPDATE channel_feature_bindings SET inbound=?, outbound=?, execution_mode=?, priority=?, fallback_channel_id=?, policy_version=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
      ).run(inbound, outbound, execMode, priority, fallback, nextVersion, existing.id);
      logAuthEvent(orgId, actorUserId, existing.id, "CHANNEL_BINDING_UPDATED", { feature, unitId, channelId: input.channelId, inbound, outbound, priority, policyVersion: nextVersion });
      return { ok: true, id: existing.id, policyVersion: nextVersion };
    }

    const id = randomUUID();
    try {
      db.prepare(
        `INSERT INTO channel_feature_bindings (id, organization_id, channel_id, feature_key, unit_id, inbound, outbound, execution_mode, priority, fallback_channel_id, policy_version, origin, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
      ).run(id, orgId, input.channelId, feature, unitId, inbound, outbound, execMode, priority, fallback, input.origin || "manual", actorUserId);
    } catch (e: any) {
      return { ok: false, error: `falha ao gravar binding: ${e?.message || e}`, code: "write_failed" };
    }
    logAuthEvent(orgId, actorUserId, id, "CHANNEL_BINDING_CREATED", { feature, unitId, channelId: input.channelId, inbound, outbound, priority });
    return { ok: true, id, policyVersion: 1 };
  }

  /** Remove um binding (por id, isolado por org). Auditado. */
  static remove(orgId: string, actorUserId: string | null, bindingId: string): { ok: boolean; code?: string } {
    if (!orgId || !bindingId) return { ok: false, code: "bad_request" };
    const r = db.prepare(`DELETE FROM channel_feature_bindings WHERE id = ? AND organization_id = ?`).run(bindingId, orgId);
    if (r.changes === 0) return { ok: false, code: "not_found" };
    logAuthEvent(orgId, actorUserId, bindingId, "CHANNEL_BINDING_DELETED", {});
    return { ok: true };
  }

  /** Canal existe e é da org? (não exige estar ativo — pode-se pré-configurar.) */
  private static channelInOrg(orgId: string, channelId: string | null | undefined): boolean {
    if (!channelId) return false;
    return !!db.prepare(`SELECT 1 FROM channels WHERE id = ? AND organization_id = ? LIMIT 1`).get(channelId, orgId);
  }

  /**
   * F2.4 (CA-03) — gate de SAÍDA por finalidade. Lança `OutboundFeatureDisabledError`
   * SÓ quando a org configurou usos e a finalidade está DESLIGADA pra saída
   * (`feature_disabled`). Sem binding (comportamento herdado) → PASSA (0-regressão);
   * finalidade ligada → passa; canal indisponível NÃO é bloqueio de finalidade
   * (o envio já vai num canal específico) → passa. Sem finalidade informada → passa.
   */
  static assertOutboundAllowed(orgId: string, featureKey?: string | null, opts?: { unitId?: string | null }): void {
    const feature = String(featureKey || "").trim();
    if (!orgId || !feature) return;
    const decision = this.resolve(orgId, feature, { unitId: opts?.unitId ?? null, direction: "outbound" });
    if (decision.code === "feature_disabled") {
      throw new OutboundFeatureDisabledError(feature, decision.reason);
    }
  }

  /** Lista os bindings de uma finalidade (para UI/diagnóstico), sem segredos. */
  static list(orgId: string, featureKey?: string): any[] {
    if (!orgId) return [];
    const where = featureKey ? `AND feature_key = ?` : ``;
    const args: any[] = featureKey ? [orgId, featureKey] : [orgId];
    try {
      return db.prepare(
        `SELECT id, channel_id, feature_key, unit_id, inbound, outbound, execution_mode, priority, fallback_channel_id, policy_version, origin
           FROM channel_feature_bindings WHERE organization_id = ? ${where} ORDER BY feature_key, priority DESC`
      ).all(...args) as any[];
    } catch { return []; }
  }
}
