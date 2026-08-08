import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * SalesRecoveryAbMeasurementService — medição do A/B da copy de Recuperação
 * Comercial (ADR-155 F3.2, fecha a Fase 3). Espelha o CollectionAbMeasurement
 * (F2.3), mas a unidade aqui é o TICKET (não a decision_action): correlaciona a
 * variante carimbada no touch (F3.2) com a RECUPERAÇÃO real — a existência de um
 * `sales_recovery_attributions` pro ticket (ticket→ganho pós-touch, F4c.4).
 *
 * ATRIBUIÇÃO nível-TICKET: um ticket pode ter N touches (tentativas 1/2/3). A
 * variante do ticket é a do touch MAIS RECENTE (a última copy que o cliente viu
 * antes de decidir). `recoveryRatePct` = recuperados / tocados por variante. As
 * respostas entram como breakdown por intent (interested/meeting_request/...),
 * não como taxa — atribuir a recuperação a UMA resposta seria fuzzy (padrão 5,
 * honestidade sobre o que o número mede). Como a variante é por-org, o A/B
 * compara orgs em `control` vs `calibrated`.
 *
 * Derivado por QUERY sobre o que já existe (touches + attributions) — sem
 * contador mutável (RN-004). O sinal usa dedupe_key estável por org ⇒ vira um
 * KPI vivo (publish faz upsert). Convenção nº 12: nunca tabela própria de KPI.
 */

export interface RecoveryAbVariantStat { variant: "control" | "calibrated"; sent: number; recovered: number; revenueCents: number; recoveryRatePct: number; }
export interface RecoveryAbReplyStat { intent: string; replies: number; }
export interface SalesRecoveryAbResult {
  orgId: string;
  totalTickets: number;
  variants: RecoveryAbVariantStat[];
  replyBreakdown: RecoveryAbReplyStat[];
  winner: "control" | "calibrated" | "tie" | null; // null = amostra insuficiente
  minSample: number;
}

const MIN_SAMPLE = 5; // abaixo disso não elege vencedor (ruído)

export class SalesRecoveryAbMeasurementService {
  /** Mede o A/B de uma org (nível-ticket por variante + breakdown de resposta). */
  static measure(orgId: string): SalesRecoveryAbResult {
    // 1 linha por TICKET tocado: variante do touch mais recente + se houve
    // atribuição (recuperação) + revenue recuperado somado.
    const rows = db.prepare(`
      SELECT t.ticket_id AS ticketId,
             (SELECT t2.variant FROM sales_recovery_touches t2
               WHERE t2.ticket_id = t.ticket_id AND t2.organization_id = t.organization_id
               ORDER BY t2.sent_at DESC LIMIT 1) AS variant,
             (SELECT COUNT(*) FROM sales_recovery_attributions a
               WHERE a.ticket_id = t.ticket_id AND a.organization_id = t.organization_id) AS attrCount,
             (SELECT COALESCE(SUM(a.revenue_recovered), 0) FROM sales_recovery_attributions a
               WHERE a.ticket_id = t.ticket_id AND a.organization_id = t.organization_id) AS revenue
        FROM sales_recovery_touches t
       WHERE t.organization_id = ?
       GROUP BY t.ticket_id
    `).all(orgId) as any[];

    const byVariant = new Map<string, { sent: number; recovered: number; revenueCents: number }>();
    for (const r of rows) {
      const v = r.variant === "calibrated" ? "calibrated" : "control";
      const g = byVariant.get(v) || { sent: 0, recovered: 0, revenueCents: 0 };
      g.sent++;
      if (Number(r.attrCount || 0) > 0) { g.recovered++; g.revenueCents += Math.round(Number(r.revenue || 0) * 100); }
      byVariant.set(v, g);
    }
    const variants: RecoveryAbVariantStat[] = (["control", "calibrated"] as const)
      .filter((v) => byVariant.has(v))
      .map((v) => {
        const g = byVariant.get(v)!;
        return { variant: v, sent: g.sent, recovered: g.recovered, revenueCents: g.revenueCents, recoveryRatePct: g.sent ? Math.round((g.recovered / g.sent) * 1000) / 10 : 0 };
      });

    const replyBreakdown: RecoveryAbReplyStat[] = (db.prepare(`
      SELECT reply_intent AS intent, COUNT(*) AS replies
        FROM sales_recovery_touches
       WHERE organization_id = ? AND reply_intent IS NOT NULL
       GROUP BY reply_intent
       ORDER BY intent
    `).all(orgId) as any[]).map((r) => ({ intent: String(r.intent), replies: Number(r.replies) }));

    const c = variants.find((v) => v.variant === "control");
    const cal = variants.find((v) => v.variant === "calibrated");
    let winner: SalesRecoveryAbResult["winner"] = null;
    if (c && cal && c.sent >= MIN_SAMPLE && cal.sent >= MIN_SAMPLE) {
      winner = cal.recoveryRatePct > c.recoveryRatePct ? "calibrated" : c.recoveryRatePct > cal.recoveryRatePct ? "control" : "tie";
    }

    return { orgId, totalTickets: rows.length, variants, replyBreakdown, winner, minSample: MIN_SAMPLE };
  }

  /** Publica (upsert) o resultado do A/B da org como business_signal. Skip se não há dados. */
  static publish(orgId: string): { published: boolean } {
    try {
      const m = this.measure(orgId);
      if (m.totalTickets === 0) return { published: false };
      const totalRevenueCents = m.variants.reduce((s, v) => s + v.revenueCents, 0);
      BusinessSignalService.publish(orgId, {
        domain: "sales",
        signalType: "sales_recovery_ab_result",
        severity: "info",
        basis: "fact", // contagens reais de recuperação (não estimativa)
        confidence: 1,
        impactAmount: totalRevenueCents / 100,
        impactUnit: "BRL",
        sourceService: "SalesRecoveryAbMeasurementService",
        evidence: { variants: m.variants, replyBreakdown: m.replyBreakdown, winner: m.winner, minSample: m.minSample, totalTickets: m.totalTickets },
        dedupeKey: `sales_recovery:ab_result:${orgId}`,
      });
      return { published: true };
    } catch (e) {
      console.error("[Recuperação F3.2] publish A/B falhou pra org", orgId, e);
      return { published: false };
    }
  }

  /** Publica o A/B de todas as orgs que já têm touches. Best-effort. */
  static publishAll(): { orgs: number; published: number } {
    const orgs = db.prepare(`SELECT DISTINCT organization_id AS orgId FROM sales_recovery_touches`).all() as any[];
    let published = 0;
    for (const o of orgs) {
      if (this.publish(String(o.orgId)).published) published++;
    }
    return { orgs: orgs.length, published };
  }
}

export default SalesRecoveryAbMeasurementService;
