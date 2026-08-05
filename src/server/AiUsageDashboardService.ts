import db from "./db.js";

/**
 * AiUsageDashboardService (ADR-154 Fatia 1.2) — leitura agregada do ledger
 * `ai_usage_log` estendido na F1.1 pra alimentar a tela master admin de
 * gastos de IA. Só leitura (nenhum UPDATE/INSERT): quem grava é o `recordUsage`
 * do llm.ts; aqui é dashboard.
 *
 * Métodos:
 * - listOrgs(days): 1 linha por org com totais da janela + status + módulos
 *   mais usados. Ordenado por custo desc (org que mais gasta primeiro).
 * - byOrg(orgId, days): drill-down — série DIÁRIA (alinhada aos últimos N
 *   dias, dias sem consumo = 0/0/0 pra não ter gap no chart) + breakdown
 *   por módulo, por modelo e por usuário.
 *
 * `days` clampado em 7..180 (default 30) — mesma régua do
 * UpgradeRecommendationService.historyByBucket (ADR-153 F4.4).
 *
 * Custo em CENTAVOS (INTEGER) é a fonte da verdade — cost_brl REAL fica pra
 * compat com admin/overview existente. `costCents` e `costBrl` são devolvidos
 * juntos, com costBrl derivado de costCents/100 pra consistência.
 *
 * Isolamento multi-tenant: TODO WHERE filtra organization_id. listOrgs é
 * intencionalmente cross-tenant (é master admin), mas byOrg é sempre por
 * orgId — a rota chama com o :orgId do path.
 */
export class AiUsageDashboardService {
  static clampDays(days?: number): number {
    const raw = Number(days);
    if (!Number.isFinite(raw)) return 30;
    return Math.max(7, Math.min(180, Math.floor(raw)));
  }

  /**
   * Lista todas as orgs com consumo da janela (last N days). Cada linha:
   *   { organizationId, businessName, status, plan, totalTokens, costCents,
   *     costBrl, callCount, lastCallAt, topModule }
   * Orgs SEM consumo na janela também aparecem (leftjoin) — o master admin
   * precisa saber quem está sem uso (potencial churn) tanto quanto quem
   * está estourando.
   */
  static listOrgs(days?: number): any[] {
    const d = AiUsageDashboardService.clampDays(days);
    return db.prepare(`
      SELECT
        os.organization_id             AS organizationId,
        os.business_name               AS businessName,
        COALESCE(os.status, 'active')  AS status,
        os.plan_id                     AS plan,
        os.billing_status              AS billingStatus,
        COALESCE(SUM(u.total_tokens), 0) AS totalTokens,
        COALESCE(SUM(u.cost_cents), 0)   AS costCents,
        COALESCE(SUM(u.cost_brl), 0)     AS costBrl,
        COUNT(u.id)                       AS callCount,
        MAX(u.created_at)                 AS lastCallAt
      FROM organization_settings os
      LEFT JOIN ai_usage_log u
        ON u.organization_id = os.organization_id
       AND u.created_at >= datetime('now', ?)
      WHERE os.deleted_at IS NULL
      GROUP BY os.organization_id
      ORDER BY costCents DESC, os.created_at DESC
    `).all(`-${d} days`).map((row: any) => {
      // Módulo #1 da org na janela (usado pra hint na tabela — coluna "top
      // módulo"). Query separada porque GROUP BY na de cima já agregou por
      // org; um SELECT extra por org é aceitável no scope de master admin.
      const top = db.prepare(`
        SELECT COALESCE(module, 'legacy') AS module, SUM(cost_cents) AS cents
        FROM ai_usage_log
        WHERE organization_id = ? AND created_at >= datetime('now', ?)
        GROUP BY COALESCE(module, 'legacy')
        ORDER BY cents DESC
        LIMIT 1
      `).get(row.organizationId, `-${d} days`) as any;
      return { ...row, topModule: top?.module || null };
    });
  }

  /**
   * Drill-down por org: série diária + breakdown por módulo/modelo/usuário.
   * A série é PRÉ-ALINHADA aos últimos N dias (dias sem consumo entram como
   * zeros) — mesmo padrão da historyByBucket da F4.4: chart sem gap.
   */
  static byOrg(orgId: string, days?: number): {
    days: number;
    series: Array<{ date: string; totalTokens: number; costCents: number; callCount: number }>;
    totalTokens: number;
    totalCostCents: number;
    totalCostBrl: number;
    totalCalls: number;
    byModule: Array<{ module: string; totalTokens: number; costCents: number; callCount: number }>;
    byModel: Array<{ model: string; totalTokens: number; costCents: number; callCount: number }>;
    byUser: Array<{ userId: string | null; totalTokens: number; costCents: number; callCount: number }>;
  } {
    const d = AiUsageDashboardService.clampDays(days);

    // Série diária (pré-alinhada). GROUP BY date() é rápido pelo índice
    // idx_ai_usage_org_module_date (created_at está lá).
    const raw = db.prepare(`
      SELECT date(created_at) AS date,
             SUM(total_tokens) AS totalTokens,
             SUM(cost_cents)   AS costCents,
             COUNT(*)          AS callCount
      FROM ai_usage_log
      WHERE organization_id = ?
        AND created_at >= datetime('now', ?)
      GROUP BY date(created_at)
    `).all(orgId, `-${d - 1} days`) as any[];
    const map = new Map<string, { totalTokens: number; costCents: number; callCount: number }>();
    for (const r of raw) map.set(r.date, { totalTokens: r.totalTokens || 0, costCents: r.costCents || 0, callCount: r.callCount || 0 });

    // Aligna: últimos N dias (hoje inclusive) mesmo que sem consumo — usa o
    // "hoje" do SQLite pra bater com o filtro created_at (ambos em UTC).
    const todayRow = db.prepare(`SELECT date('now') AS d`).get() as any;
    const today = new Date(`${todayRow.d}T00:00:00Z`);
    const series: Array<{ date: string; totalTokens: number; costCents: number; callCount: number }> = [];
    for (let i = d - 1; i >= 0; i--) {
      const dt = new Date(today.getTime() - i * 86400000);
      const key = dt.toISOString().slice(0, 10);
      const v = map.get(key) || { totalTokens: 0, costCents: 0, callCount: 0 };
      series.push({ date: key, ...v });
    }

    const totals = series.reduce((acc, s) => ({
      totalTokens: acc.totalTokens + s.totalTokens,
      totalCostCents: acc.totalCostCents + s.costCents,
      totalCalls: acc.totalCalls + s.callCount,
    }), { totalTokens: 0, totalCostCents: 0, totalCalls: 0 });

    const byModule = db.prepare(`
      SELECT COALESCE(module, 'legacy') AS module,
             SUM(total_tokens) AS totalTokens,
             SUM(cost_cents)   AS costCents,
             COUNT(*)          AS callCount
      FROM ai_usage_log
      WHERE organization_id = ?
        AND created_at >= datetime('now', ?)
      GROUP BY COALESCE(module, 'legacy')
      ORDER BY costCents DESC
    `).all(orgId, `-${d} days`) as any[];

    const byModel = db.prepare(`
      SELECT model,
             SUM(total_tokens) AS totalTokens,
             SUM(cost_cents)   AS costCents,
             COUNT(*)          AS callCount
      FROM ai_usage_log
      WHERE organization_id = ?
        AND created_at >= datetime('now', ?)
      GROUP BY model
      ORDER BY costCents DESC
    `).all(orgId, `-${d} days`) as any[];

    const byUser = db.prepare(`
      SELECT user_id AS userId,
             SUM(total_tokens) AS totalTokens,
             SUM(cost_cents)   AS costCents,
             COUNT(*)          AS callCount
      FROM ai_usage_log
      WHERE organization_id = ?
        AND created_at >= datetime('now', ?)
      GROUP BY user_id
      ORDER BY costCents DESC
    `).all(orgId, `-${d} days`) as any[];

    return {
      days: d,
      series,
      totalTokens: totals.totalTokens,
      totalCostCents: totals.totalCostCents,
      totalCostBrl: totals.totalCostCents / 100,
      totalCalls: totals.totalCalls,
      byModule: byModule.map((r: any) => ({ module: r.module, totalTokens: r.totalTokens || 0, costCents: r.costCents || 0, callCount: r.callCount || 0 })),
      byModel:  byModel.map((r: any) =>  ({ model:  r.model,  totalTokens: r.totalTokens || 0, costCents: r.costCents || 0, callCount: r.callCount || 0 })),
      byUser:   byUser.map((r: any) =>   ({ userId: r.userId, totalTokens: r.totalTokens || 0, costCents: r.costCents || 0, callCount: r.callCount || 0 })),
    };
  }
}
