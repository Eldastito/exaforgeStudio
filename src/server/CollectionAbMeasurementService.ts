import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * CollectionAbMeasurementService — medição do A/B da copy de cobrança (ADR-155
 * F2.3, fecha a Fase 2). Correlaciona a `variant` (F2.1) e o `decline_type`
 * (F2.2) registrados por follow-up com a RECUPERAÇÃO real (a decision_action da
 * cobrança fica `status='done'` com `result_amount` = valor pago — régua da
 * fundação ADR-152 F3.1), e publica o resultado como `business_signal`
 * (`collection_ab_result`) — convenção nº 12, nunca tabela própria.
 *
 * ATRIBUIÇÃO nível-AÇÃO (não por mensagem): a unidade é a cobrança (decision_
 * action). Como a variante é por-org, o A/B compara orgs em `control` vs
 * `calibrated`. `recoveryRatePct` = recuperadas / que receberam follow-up. O
 * decline entra como breakdown de tentativas (soft/hard), não como taxa —
 * atribuir recuperação a UM decline específico seria fuzzy (uma ação tem N
 * tentativas). Honestidade sobre o que o número mede (padrão 5).
 *
 * Derivado por QUERY sobre o que já existe — sem contador mutável (RN-004).
 * O sinal usa dedupe_key estável por org ⇒ vira um KPI vivo (publish faz upsert).
 */

export interface AbVariantStat { variant: "control" | "calibrated"; sent: number; recovered: number; revenueCents: number; recoveryRatePct: number; }
export interface AbDeclineStat { declineType: string; attempts: number; }
export interface CollectionAbResult {
  orgId: string;
  totalActions: number;
  variants: AbVariantStat[];
  declineBreakdown: AbDeclineStat[];
  winner: "control" | "calibrated" | "tie" | null; // null = amostra insuficiente
  minSample: number;
}

const MIN_SAMPLE = 5; // abaixo disso não elege vencedor (ruído)

export class CollectionAbMeasurementService {
  /** Mede o A/B de uma org (nível-ação por variante + breakdown de decline). */
  static measure(orgId: string): CollectionAbResult {
    // Ações de cobrança que receberam ≥1 follow-up, com a variante do follow-up
    // mais recente e o estado de recuperação (done + result_amount).
    const rows = db.prepare(`
      SELECT a.id AS actionId, a.status AS status, a.result_amount AS resultAmount,
             (SELECT f.variant FROM collection_followup_attempts f
               WHERE f.action_id = a.id AND f.organization_id = a.organization_id
               ORDER BY f.attempt_number DESC LIMIT 1) AS variant
        FROM decision_actions a
       WHERE a.organization_id = ?
         AND a.command_type = 'collection_send_reminder'
         AND EXISTS (SELECT 1 FROM collection_followup_attempts f2
                      WHERE f2.action_id = a.id AND f2.organization_id = a.organization_id)
    `).all(orgId) as any[];

    const byVariant = new Map<string, { sent: number; recovered: number; revenueCents: number }>();
    for (const r of rows) {
      const v = r.variant === "calibrated" ? "calibrated" : "control";
      const g = byVariant.get(v) || { sent: 0, recovered: 0, revenueCents: 0 };
      g.sent++;
      const amt = Number(r.resultAmount || 0);
      if (r.status === "done" && amt > 0) { g.recovered++; g.revenueCents += Math.round(amt * 100); }
      byVariant.set(v, g);
    }
    const variants: AbVariantStat[] = (["control", "calibrated"] as const)
      .filter((v) => byVariant.has(v))
      .map((v) => {
        const g = byVariant.get(v)!;
        return { variant: v, sent: g.sent, recovered: g.recovered, revenueCents: g.revenueCents, recoveryRatePct: g.sent ? Math.round((g.recovered / g.sent) * 1000) / 10 : 0 };
      });

    const declineBreakdown: AbDeclineStat[] = (db.prepare(`
      SELECT COALESCE(decline_type, 'unknown') AS declineType, COUNT(*) AS attempts
        FROM collection_followup_attempts WHERE organization_id = ?
       GROUP BY COALESCE(decline_type, 'unknown')
       ORDER BY declineType
    `).all(orgId) as any[]).map((r) => ({ declineType: String(r.declineType), attempts: Number(r.attempts) }));

    const c = variants.find((v) => v.variant === "control");
    const cal = variants.find((v) => v.variant === "calibrated");
    let winner: CollectionAbResult["winner"] = null;
    if (c && cal && c.sent >= MIN_SAMPLE && cal.sent >= MIN_SAMPLE) {
      winner = cal.recoveryRatePct > c.recoveryRatePct ? "calibrated" : c.recoveryRatePct > cal.recoveryRatePct ? "control" : "tie";
    }

    return { orgId, totalActions: rows.length, variants, declineBreakdown, winner, minSample: MIN_SAMPLE };
  }

  /** Publica (upsert) o resultado do A/B da org como business_signal. Skip se não há dados. */
  static publish(orgId: string): { published: boolean } {
    try {
      const m = this.measure(orgId);
      if (m.totalActions === 0) return { published: false };
      const totalRevenueCents = m.variants.reduce((s, v) => s + v.revenueCents, 0);
      BusinessSignalService.publish(orgId, {
        domain: "collection",
        signalType: "collection_ab_result",
        severity: "info",
        basis: "fact", // contagens reais de recuperação (não estimativa)
        confidence: 1,
        impactAmount: totalRevenueCents / 100,
        impactUnit: "BRL",
        sourceService: "CollectionAbMeasurementService",
        evidence: { variants: m.variants, declineBreakdown: m.declineBreakdown, winner: m.winner, minSample: m.minSample, totalActions: m.totalActions },
        dedupeKey: `collection:ab_result:${orgId}`,
      });
      return { published: true };
    } catch (e) {
      console.error("[Cobrança F2.3] publish A/B falhou pra org", orgId, e);
      return { published: false };
    }
  }

  /** Publica o A/B de todas as orgs que já têm follow-ups. Best-effort. */
  static publishAll(): { orgs: number; published: number } {
    const orgs = db.prepare(`SELECT DISTINCT organization_id AS orgId FROM collection_followup_attempts`).all() as any[];
    let published = 0;
    for (const o of orgs) {
      if (this.publish(String(o.orgId)).published) published++;
    }
    return { orgs: orgs.length, published };
  }
}

export default CollectionAbMeasurementService;
