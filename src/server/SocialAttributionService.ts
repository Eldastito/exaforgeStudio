/**
 * SocialAttributionService (PRD 10 / ADR-167 F12 — Analytics & Attribution) — FECHA o
 * closed-loop de conteúdo: PUBLISHED → RESULTADO. Casa a confirmação `social_publish`
 * (armada na F11) com o analytics REAL do post (F4 `social_post_metrics`, por
 * `external_ref` = id do post publicado) e RESOLVE a confirmação via
 * `ConfirmationEngine.confirm` — que conclui a ação (`DecisionActionService.complete`) e
 * registra o outcome. A partir daí o `OutcomeAssuranceService` (PRD 8) já enxerga a
 * escada executed→effect_confirmed→impact_measured — SEM medição paralela (§42/D6).
 *
 * ATRIBUIÇÃO: a ação carrega `variant_key`+`correlation_id` (fio F7/F9) no
 * command_payload/coluna — logo o engajamento medido é atribuído à VARIANTE que ganhou.
 * HONESTO: sem analytics ainda → confirmação fica pending (PUBLISHED≠RESULTADO, não força);
 * NUNCA inventa dinheiro (`resultAmount=null`) — o resultado é engajamento MEDIDO, não R$.
 * Idempotente (ConfirmationEngine.confirm é idempotente). Isolamento (convenção #1).
 */
import db from "./db.js";
import { ConfirmationEngine } from "./ConfirmationEngine.js";

function engagementOf(m: any): number {
  return (Number(m?.likes) || 0) + (Number(m?.comments) || 0) + (Number(m?.shares) || 0) + (Number(m?.saves) || 0);
}

export class SocialAttributionService {
  /**
   * Resolve as confirmações `social_publish` PENDENTES cujo post já tem analytics
   * ingerido (F4). Confirma com o engajamento MEDIDO como evidência → a ação conclui e
   * o outcome é registrado. Best-effort por confirmação. `resultAmount` sempre null
   * (não inventa dinheiro). Retorna quantas resolveu e quantas ainda aguardam analytics.
   */
  static resolvePending(orgId: string): { resolved: number; awaitingAnalytics: number } {
    const pending = ConfirmationEngine.listPending(orgId, { method: "social_publish" });
    let resolved = 0, awaiting = 0;
    for (const conf of pending) {
      const ref = conf.external_ref;
      if (!ref) { awaiting++; continue; }   // sem id do post não dá pra casar analytics
      const m = db.prepare(
        `SELECT impressions, reach, likes, comments, shares, saves, clicks FROM social_post_metrics
         WHERE organization_id = ? AND post_external_id = ? AND analytics_available = 1 LIMIT 1`,
      ).get(orgId, ref) as any;
      if (!m) { awaiting++; continue; }      // analytics ainda não chegou → PUBLISHED≠RESULTADO (honesto)
      try {
        ConfirmationEngine.confirm(orgId, conf.action_id, {
          resultAmount: null,                // resultado social = engajamento medido, NÃO dinheiro
          evidence: {
            source: "social_analytics", postExternalId: ref,
            impressions: m.impressions, reach: m.reach, likes: m.likes,
            comments: m.comments, shares: m.shares, saves: m.saves, clicks: m.clicks,
            engagement: engagementOf(m),
          },
        });
        resolved++;
      } catch (e: any) {
        console.error(`[SocialAttribution] confirm falhou (action ${conf.action_id})`, e?.message || e);
      }
    }
    return { resolved, awaitingAnalytics: awaiting };
  }

  /**
   * Read model de atribuição: por AÇÃO de publicação, o fio variante→engajamento medido
   * → estado da confirmação. Opcionalmente filtra por `correlationId`. Determinístico.
   */
  static attribution(orgId: string, opts: { correlationId?: string } = {}): Array<{
    actionId: string; variantKey: string | null; correlationId: string | null; channel: string | null;
    externalRef: string | null; confirmationStatus: string | null; engagement: number | null; measured: boolean;
  }> {
    let sql = `SELECT a.id AS action_id, a.correlation_id, a.command_payload_json, c.external_ref, c.status AS conf_status
               FROM decision_actions a
               LEFT JOIN action_confirmations c ON c.action_id = a.id AND c.organization_id = a.organization_id
               WHERE a.organization_id = ? AND a.action_type = 'social_publish' AND a.executed_at IS NOT NULL`;
    const params: any[] = [orgId];
    if (opts.correlationId) { sql += ` AND a.correlation_id = ?`; params.push(opts.correlationId); }
    sql += ` ORDER BY a.executed_at DESC LIMIT 200`;
    const rows = db.prepare(sql).all(...params) as any[];
    return rows.map((r) => {
      let variantKey: string | null = null, channel: string | null = null;
      try { const p = JSON.parse(r.command_payload_json || "{}"); variantKey = p.variantKey ?? null; channel = p.channel ?? null; } catch { /* noop */ }
      let engagement: number | null = null, measured = false;
      if (r.external_ref) {
        const m = db.prepare(`SELECT likes, comments, shares, saves FROM social_post_metrics WHERE organization_id = ? AND post_external_id = ? AND analytics_available = 1 LIMIT 1`).get(orgId, r.external_ref) as any;
        if (m) { engagement = engagementOf(m); measured = true; }
      }
      return {
        actionId: r.action_id, variantKey, correlationId: r.correlation_id || null, channel,
        externalRef: r.external_ref || null, confirmationStatus: r.conf_status || null, engagement, measured,
      };
    });
  }

  /** Passe do Scheduler: resolve confirmações pendentes das orgs com posts publicados. */
  static pass(): void {
    let orgs: any[] = [];
    try {
      orgs = db.prepare(
        `SELECT DISTINCT organization_id FROM action_confirmations WHERE confirmation_method = 'social_publish' AND status = 'pending'`,
      ).all() as any[];
    } catch { return; }
    for (const o of orgs) {
      try { this.resolvePending(o.organization_id); }
      catch (e: any) { console.error(`[SocialAttribution] pass falhou (org ${o.organization_id})`, e?.message || e); }
    }
  }
}

export default SocialAttributionService;
