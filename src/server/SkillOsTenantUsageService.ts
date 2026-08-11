import db from "./db.js";
import { ConsumptionService } from "./ConsumptionService.js";
import { BusinessSignalService } from "./BusinessSignalService.js";
import { SkillOsObservabilityService } from "./SkillOsObservabilityService.js";

/**
 * SkillOsTenantUsageService — PRD 4 F10 (§29/§30, Tenant Usage Experience). A visão
 * de CONSUMO do TENANT: quanto da franquia mensal de IA ele já usou, a tendência mês
 * a mês, a saúde das AI Runs e o alerta de "perto do limite" — SEMPRE em AÇÕES/%,
 * NUNCA em R$/US$ (§30). Predominância REUTILIZAR: quase tudo já existe, a F10 só
 * COMPÕE numa leitura única e §30-safe.
 *
 * ═══ POR QUE NÃO PUBLICA ALERTA NOVO (anti-duplicidade, PRD §3) ═══
 * O alerta "perto do limite de IA" JÁ EXISTE: `plan_near_limit_ai` em `business_signals`
 * (PlanFitDetectorService/Publisher, ≥80% de `ai_monthly_limit`, com faixa de severity
 * e recomendação de upgrade). Publicar um 2º alerta count-based aqui seria DUPLICIDADE
 * = regressão arquitetural. A F10 apenas LÊ o sinal existente (convenção #12 por reuso)
 * e o PROJETA §30-safe. O alerta COST-based (`ai_quota_*`, R$) do AiQuotaSignalService
 * é ADMIN-only (RISK-4) e NUNCA entra nesta visão de tenant.
 *
 * ═══ §30 / Decisão D5 ═══
 * O sinal `plan_near_limit_ai` carrega `estimatedUpliftMonthly`/`impact_amount` (R$ do
 * upgrade) na evidência — a projeção aqui DESCARTA esses campos e o payload inteiro
 * passa pelo guarda `SkillOsObservabilityService.assertTenantSafe` (F9) antes de
 * devolver. Idem `ConsumptionService.status().package.price` (preço de venda do pacote):
 * fica na rota de compra (`/api/plans/consumption`), não nesta leitura.
 *
 * GUARDRAILS (testados):
 *   - RN-TU-1 §30/D5: payload de tenant SEM R$/US$/tokens (guarda + auto-check).
 *   - RN-TU-2 ANTI-DUP: não publica alerta; reusa `plan_near_limit_ai` existente.
 *   - RN-TU-3 REUSA: ConsumptionService (franquia) + SkillOsObservability (runs) +
 *     BusinessSignalService (alerta) — nada reimplementado.
 *   - RN-TU-4 DERIVADO (RN-004): tendência e nível derivam por query, sem contador.
 *   - RN-TU-5 ISOLAMENTO: todo acesso filtra `organization_id` (§1).
 */

export type CapacityLevel = "ok" | "attention" | "risk" | "exceeded";

// Mesmas faixas do PlanFitDetectorService.severityFor (consistência com o sinal
// persistido): <80 ok · 80–89 attention · 90–99 risk · ≥100 exceeded.
function capacityLevelFor(pct: number, unlimited: boolean): CapacityLevel {
  if (unlimited) return "ok";
  if (pct >= 100) return "exceeded";
  if (pct >= 90) return "risk";
  if (pct >= 80) return "attention";
  return "ok";
}

export interface TenantUsageSummary {
  windowDays: number;
  franquia: {
    used: number;              // ações de IA no mês (ai_interactions_log)
    baseLimit: number;         // 0 = ilimitado
    topupActions: number;
    allowance: number;         // base + topup (0 = ilimitado)
    unlimited: boolean;
    pct: number;               // uso/allowance * 100 (0 se ilimitado)
    autoTopupEnabled: boolean;
    hasTopupPackage: boolean;  // existe pacote extra pro plano (preço fica na rota de compra)
  };
  capacityLevel: CapacityLevel;
  runs: {
    total: number;             // AI Runs do Kernel na janela (ai_usage_log, run_id != null)
    successRate: number;       // 0..1
    fallbackRate: number;      // 0..1
  };
  trend: {
    thisMonth: number;         // ações no mês corrente
    lastMonth: number;         // ações no mês anterior
    deltaPct: number;          // variação % vs mês anterior (inteiro)
  };
  alerts: Array<{
    signalType: string;
    severity: string;
    metric: string;
    used: number | null;
    limit: number | null;
    pct: number | null;
    upgradeTargetPlan: string | null;
  }>;
}

export class SkillOsTenantUsageService {
  /**
   * Contagem de ações de IA num intervalo [start, end) do ledger de franquia.
   * Cada modificador do datetime() do SQLite é um ARGUMENTO SEPARADO — passar
   * "start of month,+1 month" numa string só devolve NULL (bug clássico). Por isso
   * os limites vêm como arrays de modificadores.
   */
  private static actionsBetween(orgId: string, startMods: string[], endMods: string[]): number {
    const ph = (mods: string[]) => `datetime('now'${mods.map(() => ", ?").join("")})`;
    const r = db.prepare(
      `SELECT COUNT(*) AS c FROM ai_interactions_log
       WHERE organization_id = ? AND created_at >= ${ph(startMods)} AND created_at < ${ph(endMods)}`
    ).get(orgId, ...startMods, ...endMods) as any;
    return Number(r?.c || 0);
  }

  /** Leitura consolidada §30-safe do consumo de IA do tenant. */
  static summary(orgId: string, days?: number): TenantUsageSummary {
    // ── Franquia (REUSA ConsumptionService; descarta package.price → §30) ──
    const c = ConsumptionService.status(orgId);
    const unlimited = c.allowance === 0;
    const franquia = {
      used: c.used,
      baseLimit: c.baseLimit,
      topupActions: c.topupActions,
      allowance: c.allowance,
      unlimited,
      pct: c.pct,
      autoTopupEnabled: c.autoTopupEnabled,
      hasTopupPackage: !!c.package,
    };
    const capacityLevel = capacityLevelFor(c.pct, unlimited);

    // ── Runs (REUSA a observabilidade §30-safe da F9) ──
    const obs = SkillOsObservabilityService.aiRuns(orgId, days);
    const runs = { total: obs.totalRuns, successRate: obs.successRate, fallbackRate: obs.fallbackRate };

    // ── Tendência mês a mês (derivada por query — RN-004; count-based, §30-safe) ──
    // Fronteiras de MÊS (não 'now') pra não excluir uma ação criada no mesmo segundo
    // da query. Mês corrente [start of month, +1 month); anterior [-1 month, start).
    const thisMonth = this.actionsBetween(orgId, ["start of month"], ["start of month", "+1 month"]);
    const lastMonth = this.actionsBetween(orgId, ["start of month", "-1 month"], ["start of month"]);
    const deltaPct = lastMonth > 0
      ? Math.round(((thisMonth - lastMonth) / lastMonth) * 100)
      : (thisMonth > 0 ? 100 : 0);
    const trend = { thisMonth, lastMonth, deltaPct };

    // ── Alertas (REUSA o sinal plan_near_limit_ai EXISTENTE; projeta §30-safe) ──
    // Só o count-based da franquia de IA; descarta uplift em R$ da evidência (§30).
    const alerts = BusinessSignalService.list(orgId, { status: "open", domain: "plan" })
      .filter((s: any) => s.signal_type === "plan_near_limit_ai")
      .map((s: any) => {
        const ev = s.evidence || {};
        return {
          signalType: s.signal_type,
          severity: s.severity,
          metric: String(ev.metric ?? "ai"),
          used: ev.used != null ? Number(ev.used) : null,
          limit: ev.limit != null ? Number(ev.limit) : null,
          pct: ev.pctInt != null ? Number(ev.pctInt) : null,
          upgradeTargetPlan: ev.upgradeTargetPlan ?? null,
        };
      });

    const payload: TenantUsageSummary = { windowDays: obs.windowDays, franquia, capacityLevel, runs, trend, alerts };
    // RN-TU-1: prova em runtime que a visão de tenant não vazou custo (§30/D5).
    return SkillOsObservabilityService.assertTenantSafe(payload);
  }
}

export default SkillOsTenantUsageService;
