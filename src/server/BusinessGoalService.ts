import { randomUUID } from "crypto";
import db from "./db.js";
import { BusinessSnapshotV2Service } from "./BusinessSnapshotV2Service.js";
import { AnalyticsService } from "./AnalyticsService.js";

/**
 * Business Goals (ADR-160 D4 / Onda A F4) — modelo de OBJETIVOS/METAS do negócio
 * + DISTÂNCIA À META.
 *
 * O dono define uma meta por métrica (ex.: receita mensal, atendimentos do mês);
 * o serviço deriva quanto já foi realizado no período e "quanto falta". A meta é
 * a ÚNICA coisa persistida (a INTENÇÃO do dono); o valor realizado é SEMPRE
 * derivado por query do snapshot/analytics — nunca um contador de progresso
 * mutável (RN-004, convenção nº 4). Consome o snapshot PERSISTIDO da F2 (D2)
 * para a receita (`BusinessSnapshotV2Service.read` → cache TTL'd quando ligado).
 *
 * REGISTRO DE MÉTRICAS (extensível): cada métrica tem um `derive(orgId)` que
 * lê o valor REAL do mês. `revenue` sai do snapshot (D2 — `domains.sales.
 * receitaMes.value`, basis "fact"); `appointments` sai do AnalyticsService
 * (`appointmentCount` — o snapshot não carrega contagem de atendimentos). Para
 * adicionar uma métrica nova, basta um item no registro — sem mexer no schema.
 *
 * GUARDRAILS (RN-160, testados):
 *   - RN-160-1 — isolamento: toda query filtra `organization_id` (nº 1).
 *   - RN-160-2 — derivar por query: a tabela guarda só o ALVO; o realizado e a
 *     distância são derivados a cada leitura (RN-004). Zero contador mutável.
 *   - RN-160-4 — aditivo/inerte: sem meta definida, `list`/`progress` voltam
 *     vazios e o bloco do Diretor some — 0 regressão (nem precisa de flag: o
 *     recurso é dormente até o dono agir). §54: prior art `retail_*_quotas`
 *     avaliado e descartado (assunto diferente — varejo por loja/vendedor).
 */
export class BusinessGoalService {
  /** Registro de métricas suportadas. Cada uma sabe LER seu valor real do mês. */
  private static readonly METRICS: Record<string, { label: string; unit: "BRL" | "count"; derive: (orgId: string) => number }> = {
    revenue: {
      label: "Receita do mês",
      unit: "BRL",
      // D2: consome o snapshot PERSISTIDO (cache TTL'd quando o Evidence Layer
      // está ligado; fresco caso contrário). basis "fact" (LossMarginService).
      derive: (orgId: string) => {
        try {
          const snap = BusinessSnapshotV2Service.read(orgId) as any;
          return Number(snap?.domains?.sales?.receitaMes?.value) || 0;
        } catch { return 0; }
      },
    },
    appointments: {
      label: "Atendimentos do mês",
      unit: "count",
      // O snapshot não expõe contagem de atendimentos → deriva do Analytics
      // (mesma fonte do painel), escopo mês corrente, exclui cancelados.
      derive: (orgId: string) => {
        try {
          const m = AnalyticsService.getMetrics(orgId, { period: "month" } as any) as any;
          return Number(m?.appointmentCount) || 0;
        } catch { return 0; }
      },
    },
  };

  /** Catálogo das métricas que o dono pode definir como meta (para a UI). */
  static catalog(): { metric: string; label: string; unit: "BRL" | "count" }[] {
    return Object.entries(this.METRICS).map(([metric, m]) => ({ metric, label: m.label, unit: m.unit }));
  }

  static isKnownMetric(metric: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.METRICS, String(metric));
  }

  /** Metas vigentes do negócio (o ALVO definido pelo dono, por métrica). */
  static list(orgId: string): { metric: string; label: string; unit: "BRL" | "count"; target: number; updatedAt: string }[] {
    const rows = db.prepare("SELECT metric, target_amount, updated_at FROM business_goals WHERE organization_id = ? ORDER BY metric").all(orgId) as any[];
    return rows
      .filter((r) => this.isKnownMetric(r.metric)) // ignora métrica retirada do registro (defensivo)
      .map((r) => ({ metric: r.metric, label: this.METRICS[r.metric].label, unit: this.METRICS[r.metric].unit, target: Number(r.target_amount) || 0, updatedAt: r.updated_at }));
  }

  /**
   * Define/atualiza a meta de uma métrica (upsert por org+metric). Invariante de
   * negócio: métrica conhecida + alvo finito > 0. Retorna a meta gravada.
   */
  static set(orgId: string, input: { metric: string; targetAmount: number; actor?: string }): { metric: string; label: string; unit: "BRL" | "count"; target: number } {
    const metric = String(input?.metric || "").trim();
    if (!this.isKnownMetric(metric)) throw new Error(`metric_desconhecida: ${metric}`);
    const target = Number(input?.targetAmount);
    if (!Number.isFinite(target) || target <= 0) throw new Error("target_amount deve ser um número > 0");

    const existing = db.prepare("SELECT id FROM business_goals WHERE organization_id = ? AND metric = ?").get(orgId, metric) as any;
    if (existing) {
      db.prepare("UPDATE business_goals SET target_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(target, existing.id);
    } else {
      db.prepare("INSERT INTO business_goals (id, organization_id, metric, target_amount, created_by) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, metric, target, input?.actor || null);
    }
    return { metric, label: this.METRICS[metric].label, unit: this.METRICS[metric].unit, target };
  }

  /** Remove a meta de uma métrica. Idempotente (retorna quantas removeu). */
  static remove(orgId: string, metric: string): { removed: number } {
    const info = db.prepare("DELETE FROM business_goals WHERE organization_id = ? AND metric = ?").run(orgId, String(metric || ""));
    return { removed: info.changes };
  }

  /**
   * DISTÂNCIA À META: para cada meta vigente, deriva o realizado do mês e calcula
   * quanto falta + ritmo (pace) esperado até a data. `remaining`/`attainmentPct`/
   * `reached` são deterministicamente derivados do alvo × realizado; `paceStatus`
   * compara o realizado com o esperado-proporcional-ao-dia-do-mês (linear). O
   * `asOf` (opcional) fixa a data-base — usado nos testes p/ pace determinístico.
   */
  static progress(orgId: string, opts?: { asOf?: string }): {
    generatedAt: string; period: string;
    goals: { metric: string; label: string; unit: "BRL" | "count"; target: number; current: number; remaining: number; attainmentPct: number; reached: boolean; expectedByNow: number; paceStatus: "reached" | "on_track" | "behind" }[];
  } {
    const now = opts?.asOf ? new Date(opts.asOf) : new Date();
    const period = now.toISOString().slice(0, 7);
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const paceFraction = Math.min(1, dayOfMonth / daysInMonth);

    const goals = this.list(orgId).map((g) => {
      const current = Math.round((this.METRICS[g.metric].derive(orgId)) * 100) / 100;
      const remaining = Math.max(0, Math.round((g.target - current) * 100) / 100);
      const attainmentPct = g.target > 0 ? Math.round((current / g.target) * 100) : 0;
      const reached = current >= g.target;
      const expectedByNow = Math.round(g.target * paceFraction * 100) / 100;
      const paceStatus: "reached" | "on_track" | "behind" = reached ? "reached" : current >= expectedByNow ? "on_track" : "behind";
      return { metric: g.metric, label: g.label, unit: g.unit, target: g.target, current, remaining, attainmentPct, reached, expectedByNow, paceStatus };
    });

    return { generatedAt: now.toISOString(), period, goals };
  }
}

export default BusinessGoalService;
