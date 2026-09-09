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
import db from "./db.js";

export type BindingDirection = "inbound" | "outbound";

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
