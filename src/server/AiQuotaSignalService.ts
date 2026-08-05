import db from "./db.js";
import { BusinessSignalService } from "./BusinessSignalService.js";

/**
 * AiQuotaSignalService (ADR-154 Fatia 1.3) — publica sinais de cota de IA
 * quando a org passa de 80% (attention) ou 100% (critical) do seu teto mensal
 * de CUSTO em centavos (`organization_settings.ai_monthly_limit_cents`).
 *
 * SÓ NOTIFICA. O gate real de bloqueio segue no `PlanService.aiAllowed`
 * (count-based, ADR-091). A cota de custo aqui é uma DIMENSÃO PARALELA (novo)
 * ajustada pelo master admin — útil pra vender "assistente pessoal" com teto
 * de R$/mês e alertar antes que estoure. Se `ai_monthly_limit_cents` é NULL,
 * a org não tem teto de custo — nenhum sinal é emitido.
 *
 * Convenções seguidas:
 * - RN-004 (nunca contador mutável): consumo derivado por SUM(cost_cents) do
 *   ledger na janela do mês corrente.
 * - Convenção nº 12 (BusinessSignal): 1 dedupe_key POR MÊS
 *   (`ai:quota:{orgId}:{YYYY-MM}`); publish idempotente atualiza severity
 *   dentro do mês (80 → 100 sem duplicata). Mês novo = key nova.
 * - Convenção nº 7 (best-effort): erro em uma org NÃO trava as outras.
 * - Isolamento multi-tenant: todo query filtra organization_id.
 *
 * O sinal é RESOLVED via resolveByDedupe quando o consumo cai abaixo de 80%
 * (raro dentro do mesmo mês, mas cobre o caso do admin AUMENTAR a cota após
 * um alerta — o sinal antigo se auto-resolve na próxima varredura).
 */

const WARNING_PCT = 80;
const EXCEEDED_PCT = 100;

export interface AiQuotaEvaluation {
  hasQuota: boolean;
  limitCents: number | null;
  usedCents: number;
  pct: number;                                  // 0..∞ inteiro (podendo passar de 100)
  level: "ok" | "warning" | "exceeded";
  signalType: "ai_quota_warning" | "ai_quota_exceeded" | null;
  severity: "info" | "attention" | "critical";
}

export class AiQuotaSignalService {
  /**
   * Retorna dedupe_key mensal derivada do mês CORRENTE em UTC. Usa a mesma
   * régua de "start of month" dos filtros do ledger — mês virou = key nova.
   */
  static monthlyDedupeKey(orgId: string, monthYm?: string): string {
    const ym = monthYm || ((db.prepare(`SELECT strftime('%Y-%m', 'now') AS ym`).get() as any).ym);
    return `ai:quota:${orgId}:${ym}`;
  }

  /**
   * Avalia a cota de uma org sem publicar. Útil pra UI/API que precisa mostrar
   * o estado atual (F1.2 futuro drill-down pode usar isso).
   */
  static evaluate(orgId: string): AiQuotaEvaluation {
    const org = db.prepare(
      `SELECT ai_monthly_limit_cents FROM organization_settings WHERE organization_id = ?`
    ).get(orgId) as any;
    const limitCents = org?.ai_monthly_limit_cents != null ? Number(org.ai_monthly_limit_cents) : null;

    const usedRow = db.prepare(
      `SELECT COALESCE(SUM(cost_cents), 0) AS used FROM ai_usage_log
       WHERE organization_id = ? AND created_at >= datetime('now', 'start of month')`
    ).get(orgId) as any;
    const usedCents = Number(usedRow?.used || 0);

    if (limitCents == null || limitCents <= 0) {
      return { hasQuota: false, limitCents, usedCents, pct: 0, level: "ok", signalType: null, severity: "info" };
    }

    const pct = Math.floor((usedCents / limitCents) * 100);
    if (pct >= EXCEEDED_PCT) {
      return { hasQuota: true, limitCents, usedCents, pct, level: "exceeded", signalType: "ai_quota_exceeded", severity: "critical" };
    }
    if (pct >= WARNING_PCT) {
      return { hasQuota: true, limitCents, usedCents, pct, level: "warning", signalType: "ai_quota_warning", severity: "attention" };
    }
    return { hasQuota: true, limitCents, usedCents, pct, level: "ok", signalType: null, severity: "info" };
  }

  /**
   * Avalia + publica (se aplicável) + resolve sinal antigo se voltou pra OK.
   * Retorna resultado da avaliação + o que aconteceu no ledger de sinais.
   */
  static run(orgId: string): AiQuotaEvaluation & { published: boolean; deduped: boolean; resolved: boolean } {
    const evalu = AiQuotaSignalService.evaluate(orgId);
    const dedupeKey = AiQuotaSignalService.monthlyDedupeKey(orgId);

    if (evalu.signalType) {
      const res = BusinessSignalService.publish(orgId, {
        domain: "ai_quota",
        signalType: evalu.signalType,
        severity: evalu.severity,
        basis: "fact",
        confidence: 1,
        impactAmount: evalu.limitCents != null ? evalu.limitCents / 100 : null,
        impactUnit: evalu.limitCents != null ? "BRL" : null,
        sourceService: "AiQuotaSignalService",
        sourceEntityType: "organization",
        sourceEntityId: orgId,
        evidence: {
          limitCents: evalu.limitCents,
          usedCents: evalu.usedCents,
          pct: evalu.pct,
          limitBrl: evalu.limitCents != null ? evalu.limitCents / 100 : null,
          usedBrl: evalu.usedCents / 100,
        },
        premises: { warningPct: WARNING_PCT, exceededPct: EXCEEDED_PCT },
        dedupeKey,
      });
      return { ...evalu, published: !res.deduped, deduped: res.deduped, resolved: false };
    }

    // Voltou pra OK (< 80%) — se havia sinal aberto do mês, resolve.
    const r = BusinessSignalService.resolveByDedupe(orgId, dedupeKey);
    return { ...evalu, published: false, deduped: false, resolved: r.ok };
  }

  /**
   * Sweep de todas as orgs com `ai_monthly_limit_cents` definido. Best-effort:
   * erro em uma org NÃO trava as outras (convenção nº 7). Called by
   * Scheduler.aiQuotaPass() no tick lento.
   */
  static runAll(): { seen: number; warnings: number; exceeded: number; resolved: number } {
    let rows: any[] = [];
    try {
      rows = db.prepare(
        `SELECT organization_id FROM organization_settings
         WHERE deleted_at IS NULL AND ai_monthly_limit_cents IS NOT NULL AND ai_monthly_limit_cents > 0`
      ).all() as any[];
    } catch { return { seen: 0, warnings: 0, exceeded: 0, resolved: 0 }; }

    let warnings = 0, exceeded = 0, resolved = 0;
    for (const r of rows) {
      try {
        const out = AiQuotaSignalService.run(r.organization_id);
        if (out.level === "warning") warnings++;
        else if (out.level === "exceeded") exceeded++;
        if (out.resolved) resolved++;
      } catch (e) {
        console.error("[AiQuotaSignalService] runAll: erro na org", r.organization_id, e);
      }
    }
    return { seen: rows.length, warnings, exceeded, resolved };
  }
}
