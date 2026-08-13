/**
 * EditorialCalendarService (PRD 10 / ADR-167 F10 — Calendar + Scheduling) — dá ao Estúdio
 * o CALENDÁRIO EDITORIAL (rascunho→aprovado) e o BEST-TIME-TO-POST, fechando o 2º gap da
 * F0. ESTENDE `scheduled_posts` (§42 — SEM 2º calendário): o estágio `draft` é uma linha
 * que NÃO publica (o passe do agendador só pega `status='scheduled'`, então drafts ficam
 * de fora até aprovados — 0-regressão). Aprovar = agendar (draft→scheduled + horário).
 *
 * BEST-TIME é DERIVADO por query do desempenho PRÓPRIO (F4 `social_post_metrics`): agrupa
 * posts por (dia-da-semana, hora) e ranqueia por engajamento MEDIDO. HONESTO (RN-SI-12):
 * sem posts com analytics suficientes → `insufficient_data`, nunca um palpite inventado.
 * Determinístico (deriva de `published_at` já gravado, sem `now()` no ranking). Carrega o
 * fio oportunidade→variante (F7/F9) pra atribuição futura (F12). Isolamento (convenção #1).
 */
import { randomUUID } from "crypto";
import db from "./db.js";

const MIN_SAMPLES = 3;   // abaixo disso, best-time é chute — melhor ser honesto (RN-SI-12)

export interface CalendarEntry {
  id: string;
  creationId: string | null;
  channel: string | null;
  objective: string | null;
  caption: string | null;
  scheduledAt: string | null;
  status: string;
  variantKey: string | null;
  correlationId: string | null;
  igMediaId: string | null;
  publishedAt: string | null;
}

export class EditorialCalendarService {
  /**
   * Cria um RASCUNHO no calendário (não publica). `creationId` opcional (a arte pode vir
   * depois); `scheduledAt` opcional no rascunho. Carrega o fio da oportunidade/variante.
   */
  static draft(
    orgId: string,
    input: { creationId?: string | null; channel?: string; objective?: string; caption?: string; scheduledAt?: string | null; variantKey?: string | null; correlationId?: string | null },
  ): { id: string } {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO scheduled_posts (id, organization_id, creation_id, objective, caption, scheduled_at, status, channel, correlation_id, variant_key)
       VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`,
    ).run(
      id, orgId, input.creationId || null, input.objective || null, input.caption || null,
      input.scheduledAt || null, input.channel || null, input.correlationId || null, input.variantKey || null,
    );
    return { id };
  }

  private static row(orgId: string, id: string): any | undefined {
    return db.prepare(`SELECT * FROM scheduled_posts WHERE id = ? AND organization_id = ?`).get(id, orgId) as any;
  }

  /**
   * Aprova um rascunho: draft→scheduled + horário (a partir daí o passe publica quando a
   * hora chegar). Só rascunhos podem ser aprovados. `scheduledAt` obrigatório (ISO futuro).
   */
  static approve(orgId: string, id: string, opts: { scheduledAt: string }): { ok: true } {
    const r = this.row(orgId, id);
    if (!r) throw new Error("Entrada do calendário não encontrada.");
    if (r.status !== "draft") throw new Error("Só rascunhos podem ser aprovados.");
    const when = new Date(opts.scheduledAt);
    if (isNaN(when.getTime())) throw new Error("scheduledAt inválido.");
    db.prepare(`UPDATE scheduled_posts SET status = 'scheduled', scheduled_at = ? WHERE id = ?`).run(when.toISOString(), id);
    return { ok: true };
  }

  /** Cancela uma entrada (rascunho ou agendada). Preserva o histórico (nunca deleta). */
  static cancel(orgId: string, id: string): boolean {
    const res = db.prepare(`UPDATE scheduled_posts SET status = 'canceled' WHERE id = ? AND organization_id = ? AND status IN ('draft','scheduled')`).run(id, orgId);
    return res.changes > 0;
  }

  /** Calendário editorial da org (todos os estágios), mais recentes por horário. */
  static calendar(orgId: string, opts: { limit?: number } = {}): CalendarEntry[] {
    const limit = opts.limit && opts.limit > 0 ? Math.min(opts.limit, 200) : 100;
    const rows = db.prepare(
      `SELECT id, creation_id, channel, objective, caption, scheduled_at, status, variant_key, correlation_id, ig_media_id, published_at
       FROM scheduled_posts WHERE organization_id = ?
       ORDER BY COALESCE(scheduled_at, created_at) DESC LIMIT ?`,
    ).all(orgId, limit) as any[];
    return rows.map((r) => ({
      id: r.id, creationId: r.creation_id || null, channel: r.channel || null, objective: r.objective || null,
      caption: r.caption || null, scheduledAt: r.scheduled_at || null, status: r.status,
      variantKey: r.variant_key || null, correlationId: r.correlation_id || null,
      igMediaId: r.ig_media_id || null, publishedAt: r.published_at || null,
    }));
  }

  /**
   * BEST-TIME-TO-POST derivado do desempenho PRÓPRIO (F4). Agrupa posts publicados por
   * (dia-da-semana, hora UTC) e ranqueia por engajamento MEDIDO (só posts com analytics).
   * HONESTO: sem amostras suficientes → `available:false, reason:'insufficient_data'`.
   */
  static bestTime(orgId: string, channel: string): {
    available: boolean; reason?: string; samples: number;
    recommendations: Array<{ dayOfWeek: number; hour: number; avgEngagement: number; samples: number }>;
  } {
    // engajamento = soma do que existe (COALESCE), mas só conta posts COM analytics.
    const rows = db.prepare(
      `SELECT CAST(strftime('%w', published_at) AS INTEGER) AS dow,
              CAST(strftime('%H', published_at) AS INTEGER) AS hour,
              (COALESCE(likes,0)+COALESCE(comments,0)+COALESCE(shares,0)+COALESCE(saves,0)) AS eng
       FROM social_post_metrics
       WHERE organization_id = ? AND channel = ? AND analytics_available = 1 AND published_at IS NOT NULL`,
    ).all(orgId, channel) as any[];
    const samples = rows.length;
    if (samples < MIN_SAMPLES) {
      return { available: false, reason: "insufficient_data", samples, recommendations: [] };
    }
    const buckets = new Map<string, { dow: number; hour: number; total: number; n: number }>();
    for (const r of rows) {
      const key = `${r.dow}:${r.hour}`;
      const b = buckets.get(key) || { dow: r.dow, hour: r.hour, total: 0, n: 0 };
      b.total += Number(r.eng) || 0; b.n += 1; buckets.set(key, b);
    }
    const recommendations = [...buckets.values()]
      .map((b) => ({ dayOfWeek: b.dow, hour: b.hour, avgEngagement: b.n ? b.total / b.n : 0, samples: b.n }))
      // desempate estável: engajamento desc, depois dow/hour asc (determinístico).
      .sort((a, b) => b.avgEngagement - a.avgEngagement || a.dayOfWeek - b.dayOfWeek || a.hour - b.hour)
      .slice(0, 3);
    return { available: true, samples, recommendations };
  }
}

export default EditorialCalendarService;
