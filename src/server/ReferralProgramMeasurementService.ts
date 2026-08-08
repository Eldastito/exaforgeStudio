import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * ReferralProgramMeasurementService — medição do programa de indicação (ADR-155
 * F6). Espelha a mecânica de medição da F2.3/F3.2: deriva a performance do
 * programa (ADR-069) POR QUERY sobre o estado que já existe (`referral_codes`,
 * `contacts.referred_by_contact_id`, `coupons`) — sem contador mutável (RN-004)
 * — e publica como `business_signal` (`referral_program_result`), convenção nº 12
 * (nunca tabela própria de KPI). Vira um KPI vivo: dedupe estável por org ⇒ o
 * publish faz upsert.
 *
 * Definições (honestidade sobre o que o número mede — padrão 5):
 *   - `codesIssued`   = códigos emitidos (1 por contato, ADR-069 RN-3).
 *   - `referred`      = indicados que COLARAM um código (`referred_by_contact_id`).
 *   - `welcomeIssued` = cupons de boas-vindas emitidos ao indicado.
 *   - `qualified`     = cupons de RECOMPENSA emitidos — recompensa é gated por
 *                       pagamento (ADR-069 RN-8), então cada um = uma indicação
 *                       que virou 1ª compra PAGA. É a conversão real do programa.
 *   - `couponsRedeemed` = cupons já usados num pedido.
 *   - `conversionRatePct` = qualified / referred (indicados que pagaram ÷ que
 *                       colaram código).
 */

export interface ReferralProgramResult {
  orgId: string;
  codesIssued: number;
  referred: number;
  welcomeIssued: number;
  qualified: number;
  couponsRedeemed: number;
  conversionRatePct: number;
}

export class ReferralProgramMeasurementService {
  /** Mede o programa de uma org (tudo derivado por query). */
  static measure(orgId: string): ReferralProgramResult {
    const n = (sql: string, ...args: any[]): number => Number((db.prepare(sql).get(orgId, ...args) as any)?.n || 0);
    const codesIssued = n(`SELECT COUNT(*) AS n FROM referral_codes WHERE organization_id = ?`);
    const referred = n(`SELECT COUNT(*) AS n FROM contacts WHERE organization_id = ? AND referred_by_contact_id IS NOT NULL`);
    const welcomeIssued = n(`SELECT COUNT(*) AS n FROM coupons WHERE organization_id = ? AND kind = 'referral_welcome'`);
    const qualified = n(`SELECT COUNT(*) AS n FROM coupons WHERE organization_id = ? AND kind = 'referral_reward'`);
    const couponsRedeemed = n(`SELECT COUNT(*) AS n FROM coupons WHERE organization_id = ? AND status = 'used'`);
    const conversionRatePct = referred ? Math.round((qualified / referred) * 1000) / 10 : 0;
    return { orgId, codesIssued, referred, welcomeIssued, qualified, couponsRedeemed, conversionRatePct };
  }

  /** Publica (upsert) o resultado do programa como business_signal. Skip se não há códigos. */
  static publish(orgId: string): { published: boolean } {
    try {
      const m = this.measure(orgId);
      if (m.codesIssued === 0) return { published: false };
      BusinessSignalService.publish(orgId, {
        domain: "referrals",
        signalType: "referral_program_result",
        severity: "info",
        basis: "fact", // contagens reais (não estimativa)
        confidence: 1,
        impactAmount: m.qualified,
        impactUnit: "indicacoes_convertidas",
        sourceService: "ReferralProgramMeasurementService",
        evidence: {
          codesIssued: m.codesIssued, referred: m.referred, welcomeIssued: m.welcomeIssued,
          qualified: m.qualified, couponsRedeemed: m.couponsRedeemed, conversionRatePct: m.conversionRatePct,
        },
        dedupeKey: `referrals:program_result:${orgId}`,
      });
      return { published: true };
    } catch (e) {
      console.error("[Referrals F6] publish falhou pra org", orgId, e);
      return { published: false };
    }
  }

  /** Publica o KPI de todas as orgs que já emitiram algum código. Best-effort. */
  static publishAll(): { orgs: number; published: number } {
    const orgs = db.prepare(`SELECT DISTINCT organization_id AS orgId FROM referral_codes`).all() as any[];
    let published = 0;
    for (const o of orgs) {
      if (this.publish(String(o.orgId)).published) published++;
    }
    return { orgs: orgs.length, published };
  }
}

export default ReferralProgramMeasurementService;
