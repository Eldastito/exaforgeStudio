import { randomUUID } from "crypto";
import db from "./db.js";
import { BusinessSnapshotV2Service } from "./BusinessSnapshotV2Service.js";
import { AnalyticsService } from "./AnalyticsService.js";

// ── CEO Operating Layer (ADR-190) — taxonomia executiva do registro de métricas ──
export const EXECUTIVE_PILLARS = ["commercial", "operations", "finance"] as const;
export type ExecutivePillar = (typeof EXECUTIVE_PILLARS)[number];
/** `basis` do VALOR quando ele existe (fato > derivado > estimativa); `unknown` = sem fonte/valor. */
export type MetricBasis = "fact" | "derived" | "estimate" | "unknown";
/** A FONTE (system-of-record) existe pra esta org? `unavailable` → valor NULL, nunca 0 (RN-CEO-11). */
export type MetricAvailability = "available" | "unavailable";

export interface ExecutiveMetricDef {
  label: string;
  unit: "BRL" | "count";
  derive: (orgId: string) => number;
  pillar: ExecutivePillar;
  basis: MetricBasis;                 // basis do valor QUANDO disponível
  source: string;                     // system-of-record legível
  betterDirection: "up" | "down";     // "up" = maior é melhor; "down" = menor é melhor (ex.: inadimplência)
  availability?: (orgId: string) => MetricAvailability; // default 'available' (fonte interna presente)
}

/** Descritor executivo de uma métrica (sem o `derive`), pro catálogo/UI. */
export interface ExecutiveMetricDescriptor {
  metricKey: string; pillar: ExecutivePillar; label: string; unit: "BRL" | "count";
  basis: MetricBasis; source: string; betterDirection: "up" | "down";
}
/** Leitura executiva HONESTA de uma métrica: valor + procedência + disponibilidade. */
export interface ExecutiveMetricReading extends ExecutiveMetricDescriptor {
  value: number | null;              // null quando availability='unavailable' (nunca 0 — RN-CEO-11)
  availability: MetricAvailability;
  measuredAt: string;
}

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
  /**
   * Registro de métricas suportadas. Cada uma sabe LER seu valor real do mês.
   *
   * CEO Operating Layer (ADR-190 F1): o registro ganha os descritores executivos — `pillar`
   * (comercial/operações/financeiro), `basis` (fato/derivado/estimativa QUANDO há valor), `source`
   * (system-of-record legível), `betterDirection` (up/down) e `availability(orgId)` (a FONTE existe?
   * `available`/`unavailable` — sem fonte, o valor é NULL, nunca 0; RN-CEO-11). Isto ESTENDE o registro
   * único (D3 da auditoria F0), não cria um `ExecutiveMetricRegistry` paralelo (§9/§62). As 5 métricas
   * existentes vêm de fontes internas do SQLite → `available` por padrão; métricas que dependem de
   * integração externa (caixa/custo) definirão sua própria `availability` nas fatias seguintes.
   */
  private static readonly METRICS: Record<string, ExecutiveMetricDef> = {
    revenue: {
      label: "Receita do mês", unit: "BRL", pillar: "commercial", basis: "fact",
      source: "Reconciliação de receita (P&L / snapshot)", betterDirection: "up",
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
      label: "Atendimentos do mês", unit: "count", pillar: "commercial", basis: "derived",
      source: "Analytics (agenda)", betterDirection: "up",
      // O snapshot não expõe contagem de atendimentos → deriva do Analytics
      // (mesma fonte do painel), escopo mês corrente, exclui cancelados.
      derive: (orgId: string) => {
        try {
          const m = AnalyticsService.getMetrics(orgId, { period: "month" } as any) as any;
          return Number(m?.appointmentCount) || 0;
        } catch { return 0; }
      },
    },
    // PRD 11 / ADR-168 F12 — Métricas de CRESCIMENTO por conteúdo. O ponto de extensão do
    // registro (schema-free) vira a ponte goal↔content: uma meta de negócio pode ser a
    // RECEITA ou os LEADS que o CONTEÚDO gerou (F7/F8), medidos por query no mês corrente.
    // `content_revenue` soma só `fact` (RN-CG-03 — não mistura estimate; não inventa dinheiro).
    content_revenue: {
      label: "Receita de conteúdo (mês)", unit: "BRL", pillar: "commercial", basis: "fact",
      source: "Atribuição de conteúdo (venda)", betterDirection: "up",
      derive: (orgId: string) => {
        try {
          const r = db.prepare("SELECT COALESCE(SUM(revenue),0) AS v FROM content_sale_attributions WHERE organization_id = ? AND revenue_basis = 'fact' AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get(orgId) as any;
          return Number(r?.v) || 0;
        } catch { return 0; }
      },
    },
    content_leads: {
      label: "Leads de conteúdo (mês)", unit: "count", pillar: "commercial", basis: "derived",
      source: "Atribuição de conteúdo (lead)", betterDirection: "up",
      derive: (orgId: string) => {
        try {
          const r = db.prepare("SELECT COUNT(*) AS v FROM content_lead_attributions WHERE organization_id = ? AND strftime('%Y-%m', created_at) = strftime('%Y-%m','now')").get(orgId) as any;
          return Number(r?.v) || 0;
        } catch { return 0; }
      },
    },
    // Cobrança/inadimplência (família de vertical: qualquer negócio que fatura). Valor RECUPERADO no
    // mês — soma dos recebíveis quitados (system-of-record `receivables`, não LLM; RN-004). Mede a
    // missão "recuperar R$ X de inadimplência" (planned recovery × recuperado de fato no checkpoint).
    receivables: {
      label: "Valores recuperados (mês)", unit: "BRL", pillar: "finance", basis: "fact",
      source: "Recebíveis (system-of-record)", betterDirection: "up",
      derive: (orgId: string) => {
        try {
          const r = db.prepare("SELECT COALESCE(SUM(amount),0) AS v FROM receivables WHERE organization_id = ? AND status = 'received' AND strftime('%Y-%m', received_at) = strftime('%Y-%m','now')").get(orgId) as any;
          return Number(r?.v) || 0;
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

  /** Valor REAL do mês pra uma métrica conhecida (derivado por query, RN-004). null se desconhecida.
   *  Público mínimo pra o Mission Layer (ADR-189 F6) comparar planned × actual — reusa, não duplica. */
  static currentValue(orgId: string, metric: string): number | null {
    const m = (this.METRICS as any)[String(metric)];
    if (!m) return null;
    try { return Math.round((m.derive(orgId)) * 100) / 100; } catch { return null; }
  }

  // ══ CEO Operating Layer (ADR-190 F1) — descritores executivos do registro ══

  /** Descritor executivo de uma métrica (pillar/basis/source/betterDirection). null se desconhecida. */
  static describe(metric: string): ExecutiveMetricDescriptor | null {
    const m = (this.METRICS as any)[String(metric)] as ExecutiveMetricDef | undefined;
    if (!m) return null;
    return { metricKey: String(metric), pillar: m.pillar, label: m.label, unit: m.unit, basis: m.basis, source: m.source, betterDirection: m.betterDirection };
  }

  /** A FONTE da métrica existe pra esta org? `available`/`unavailable` (default available p/ fonte
   *  interna). null se a métrica é desconhecida. Sem fonte → o valor será NULL, nunca 0 (RN-CEO-11). */
  static availability(orgId: string, metric: string): MetricAvailability | null {
    const m = (this.METRICS as any)[String(metric)] as ExecutiveMetricDef | undefined;
    if (!m) return null;
    try { return m.availability ? m.availability(orgId) : "available"; } catch { return "unavailable"; }
  }

  /** Leitura executiva HONESTA: valor + basis + availability + procedência. Sem fonte → value:null,
   *  basis:'unknown' (nunca inventa 0). Base do Executive Snapshot/Accountability (F4/F5). */
  static measure(orgId: string, metric: string): ExecutiveMetricReading | null {
    const desc = this.describe(metric);
    if (!desc) return null;
    const availability = this.availability(orgId, metric) || "unavailable";
    const measuredAt = new Date().toISOString();
    if (availability === "unavailable") {
      return { ...desc, value: null, basis: "unknown", availability, measuredAt };
    }
    const value = this.currentValue(orgId, metric);
    // Se a derivação falhou (null) apesar da fonte existir, seja honesto (unknown), não 0.
    if (value == null) return { ...desc, value: null, basis: "unknown", availability, measuredAt };
    return { ...desc, value, availability, measuredAt };
  }

  /** Catálogo executivo completo (todos os descritores). Pra UI/registry executivo. */
  static executiveCatalog(): ExecutiveMetricDescriptor[] {
    return Object.keys(this.METRICS).map((k) => this.describe(k)!).filter(Boolean);
  }

  /** Métricas agrupadas por pilar (comercial/operações/financeiro). */
  static metricsByPillar(): Record<ExecutivePillar, ExecutiveMetricDescriptor[]> {
    const out = { commercial: [], operations: [], finance: [] } as Record<ExecutivePillar, ExecutiveMetricDescriptor[]>;
    for (const d of this.executiveCatalog()) out[d.pillar].push(d);
    return out;
  }

  // §14 — ciclo de vida + prioridade da meta rica. Vocabulário fechado; entrada
  // fora do conjunto é rejeitada (invariante de negócio, não inventa estado).
  private static readonly STATUSES = ["active", "achieved", "paused", "abandoned"] as const;
  private static readonly PRIORITIES = ["low", "medium", "high", "critical"] as const;
  // Ordena a atenção: mais crítica primeiro; ausência de prioridade por último.
  private static readonly PRIORITY_RANK: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

  /** Metas vigentes do negócio (o ALVO definido pelo dono, por métrica). Inclui os
   *  metadados ricos (§14). Retorna TODAS (qualquer status) — a gestão vê o ciclo
   *  de vida completo; `progress()` é quem filtra as ativas por padrão. */
  static list(orgId: string): { metric: string; label: string; unit: "BRL" | "count"; target: number; updatedAt: string; title: string | null; baseline: number | null; deadline: string | null; priority: string | null; owner: string | null; status: string }[] {
    const rows = db.prepare("SELECT metric, target_amount, updated_at, title, baseline, deadline, priority, owner, status FROM business_goals WHERE organization_id = ? ORDER BY metric").all(orgId) as any[];
    return rows
      .filter((r) => this.isKnownMetric(r.metric)) // ignora métrica retirada do registro (defensivo)
      .map((r) => ({
        metric: r.metric, label: this.METRICS[r.metric].label, unit: this.METRICS[r.metric].unit,
        target: Number(r.target_amount) || 0, updatedAt: r.updated_at,
        title: r.title ?? null, baseline: r.baseline != null ? Number(r.baseline) : null,
        deadline: r.deadline ?? null, priority: r.priority ?? null, owner: r.owner ?? null,
        status: r.status || "active",
      }));
  }

  /**
   * Define/atualiza a meta de uma métrica (upsert por org+metric). Invariante de
   * negócio: métrica conhecida + alvo finito > 0. Os metadados ricos (§14) são
   * OPCIONAIS: quando informados, são gravados; quando OMITIDOS num update, os
   * valores existentes são PRESERVADOS (não zera o que o dono já definiu). Retorna
   * a meta gravada (com os campos ricos vigentes).
   */
  static set(orgId: string, input: { metric: string; targetAmount: number; actor?: string; title?: string | null; baseline?: number | null; deadline?: string | null; priority?: string | null; owner?: string | null; status?: string | null }): { metric: string; label: string; unit: "BRL" | "count"; target: number; title: string | null; baseline: number | null; deadline: string | null; priority: string | null; owner: string | null; status: string } {
    const metric = String(input?.metric || "").trim();
    if (!this.isKnownMetric(metric)) throw new Error(`metric_desconhecida: ${metric}`);
    const target = Number(input?.targetAmount);
    if (!Number.isFinite(target) || target <= 0) throw new Error("target_amount deve ser um número > 0");
    // Validação de forma dos campos ricos (só quando informados).
    if (input.priority != null && input.priority !== "" && !this.PRIORITIES.includes(String(input.priority) as any)) throw new Error("priority deve ser low|medium|high|critical");
    if (input.status != null && input.status !== "" && !this.STATUSES.includes(String(input.status) as any)) throw new Error("status deve ser active|achieved|paused|abandoned");
    if (input.baseline != null && !Number.isFinite(Number(input.baseline))) throw new Error("baseline deve ser numérico");

    const existing = db.prepare("SELECT id FROM business_goals WHERE organization_id = ? AND metric = ?").get(orgId, metric) as any;
    if (existing) {
      // Update PARCIAL: só sobrescreve os campos ricos que vieram no input; os
      // omitidos (undefined) ficam como estão. `null` explícito limpa o campo.
      const sets: string[] = ["target_amount = ?", "updated_at = CURRENT_TIMESTAMP"];
      const params: any[] = [target];
      const put = (col: string, v: any) => { sets.push(`${col} = ?`); params.push(v); };
      if (input.title !== undefined) put("title", input.title ?? null);
      if (input.baseline !== undefined) put("baseline", input.baseline != null ? Number(input.baseline) : null);
      if (input.deadline !== undefined) put("deadline", input.deadline ?? null);
      if (input.priority !== undefined) put("priority", input.priority || null);
      if (input.owner !== undefined) put("owner", input.owner ?? null);
      if (input.status !== undefined && input.status) put("status", input.status);
      params.push(existing.id);
      db.prepare(`UPDATE business_goals SET ${sets.join(", ")} WHERE id = ?`).run(...params);
    } else {
      db.prepare("INSERT INTO business_goals (id, organization_id, metric, target_amount, created_by, title, baseline, deadline, priority, owner, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), orgId, metric, target, input?.actor || null,
          input.title ?? null, input.baseline != null ? Number(input.baseline) : null, input.deadline ?? null,
          input.priority || null, input.owner ?? null, input.status || "active");
    }
    const saved = db.prepare("SELECT title, baseline, deadline, priority, owner, status FROM business_goals WHERE organization_id = ? AND metric = ?").get(orgId, metric) as any;
    return { metric, label: this.METRICS[metric].label, unit: this.METRICS[metric].unit, target, title: saved?.title ?? null, baseline: saved?.baseline != null ? Number(saved.baseline) : null, deadline: saved?.deadline ?? null, priority: saved?.priority ?? null, owner: saved?.owner ?? null, status: saved?.status || "active" };
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
  static progress(orgId: string, opts?: { asOf?: string; includeInactive?: boolean }): {
    generatedAt: string; period: string;
    goals: { metric: string; label: string; unit: "BRL" | "count"; target: number; current: number; remaining: number; attainmentPct: number; reached: boolean; expectedByNow: number; paceStatus: "reached" | "on_track" | "behind"; title: string | null; baseline: number | null; deadline: string | null; priority: string | null; owner: string | null; status: string; attainmentFromBaselinePct: number | null }[];
  } {
    const now = opts?.asOf ? new Date(opts.asOf) : new Date();
    const period = now.toISOString().slice(0, 7);
    const dayOfMonth = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const paceFraction = Math.min(1, dayOfMonth / daysInMonth);

    const goals = this.list(orgId)
      // §14 — por padrão só metas ATIVAS entram na distância à meta: uma meta
      // pausada/abandonada/atingida não deve aparecer como "behind" na operação.
      .filter((g) => opts?.includeInactive || g.status === "active")
      .map((g) => {
        const current = Math.round((this.METRICS[g.metric].derive(orgId)) * 100) / 100;
        const remaining = Math.max(0, Math.round((g.target - current) * 100) / 100);
        const attainmentPct = g.target > 0 ? Math.round((current / g.target) * 100) : 0;
        const reached = current >= g.target;
        const expectedByNow = Math.round(g.target * paceFraction * 100) / 100;
        const paceStatus: "reached" | "on_track" | "behind" = reached ? "reached" : current >= expectedByNow ? "on_track" : "behind";
        // §14 baseline: avanço RELATIVO ao ponto de partida (quando declarado e o
        // alvo o supera). Aditivo — `attainmentPct` (sobre 0) segue inalterado.
        const attainmentFromBaselinePct = g.baseline != null && g.target > g.baseline
          ? Math.round(((current - g.baseline) / (g.target - g.baseline)) * 100)
          : null;
        return { metric: g.metric, label: g.label, unit: g.unit, target: g.target, current, remaining, attainmentPct, reached, expectedByNow, paceStatus, title: g.title, baseline: g.baseline, deadline: g.deadline, priority: g.priority, owner: g.owner, status: g.status, attainmentFromBaselinePct };
      })
      // Ordena por prioridade (crítica primeiro; sem prioridade por último),
      // desempate determinístico por métrica.
      .sort((a, b) => (this.PRIORITY_RANK[a.priority || ""] ?? 9) - (this.PRIORITY_RANK[b.priority || ""] ?? 9) || a.metric.localeCompare(b.metric));

    return { generatedAt: now.toISOString(), period, goals };
  }
}

export default BusinessGoalService;
