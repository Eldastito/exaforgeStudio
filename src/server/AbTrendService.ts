import db from "./db.js";
import { randomUUID } from "crypto";
import { CollectionAbMeasurementService } from "./CollectionAbMeasurementService.js";
import { SalesRecoveryAbMeasurementService } from "./SalesRecoveryAbMeasurementService.js";

/**
 * AbTrendService — histórico temporal do A/B da copy (control × calibrada) pro
 * gráfico da aba Operações (ADR-155). Espelha a intenção do gráfico F4.4 do
 * ADR-153, mas com uma diferença honesta: a taxa de recuperação CUMULATIVA de
 * um dia passado NÃO é derivável do estado atual (precisaria das contagens
 * daquele dia). Então gravamos um SNAPSHOT diário (append-only, 1 por org/kind/
 * dia via upsert) do que os *MeasurementService medem — não é contador mutável
 * (RN-004), é log de fato histórico. Backfill não existe: a série começa a
 * acumular a partir do 1º snapshot (honesto — não inventamos histórico).
 */

export type AbKind = "collection" | "sales_recovery";

export interface AbTrendPoint {
  date: string;
  controlRate: number; controlSent: number;
  calibratedRate: number; calibratedSent: number;
  winner: string | null;
}

function measureFor(kind: AbKind, orgId: string): { variants: any[]; winner: string | null; total: number } {
  if (kind === "collection") {
    const m = CollectionAbMeasurementService.measure(orgId);
    return { variants: m.variants, winner: m.winner, total: m.totalActions };
  }
  const m = SalesRecoveryAbMeasurementService.measure(orgId);
  return { variants: m.variants, winner: m.winner, total: m.totalTickets };
}

export class AbTrendService {
  static todayIso(): string { return new Date().toISOString().slice(0, 10); }

  /** Grava (upsert) o snapshot de um dia pra uma org/kind. Skip se sem dados. */
  static capture(orgId: string, kind: AbKind, day?: string): { captured: boolean } {
    const m = measureFor(kind, orgId);
    if (m.total === 0) return { captured: false };
    const c = m.variants.find((v: any) => v.variant === "control");
    const cal = m.variants.find((v: any) => v.variant === "calibrated");
    const on = day || this.todayIso();
    db.prepare(`
      INSERT INTO ab_trend_snapshots (id, organization_id, kind, captured_on, control_rate, control_sent, calibrated_rate, calibrated_sent, winner)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(organization_id, kind, captured_on) DO UPDATE SET
        control_rate = excluded.control_rate, control_sent = excluded.control_sent,
        calibrated_rate = excluded.calibrated_rate, calibrated_sent = excluded.calibrated_sent,
        winner = excluded.winner
    `).run(randomUUID(), orgId, kind, on,
      c?.recoveryRatePct ?? 0, c?.sent ?? 0, cal?.recoveryRatePct ?? 0, cal?.sent ?? 0, m.winner ?? null);
    return { captured: true };
  }

  /** Snapshot de hoje pra todas as orgs com dado de A/B (dois kinds). Best-effort. */
  static captureAll(): { collection: number; sales_recovery: number } {
    let collection = 0, sales_recovery = 0;
    for (const o of db.prepare(`SELECT DISTINCT organization_id AS orgId FROM collection_followup_attempts`).all() as any[]) {
      try { if (this.capture(String(o.orgId), "collection").captured) collection++; } catch (e) { console.error("[AbTrend] capture collection falhou", o.orgId, e); }
    }
    for (const o of db.prepare(`SELECT DISTINCT organization_id AS orgId FROM sales_recovery_touches`).all() as any[]) {
      try { if (this.capture(String(o.orgId), "sales_recovery").captured) sales_recovery++; } catch (e) { console.error("[AbTrend] capture recovery falhou", o.orgId, e); }
    }
    return { collection, sales_recovery };
  }

  /** Série dos últimos N dias (só dias com snapshot; o front alinha o eixo). */
  static series(orgId: string, kind: AbKind, opts?: { days?: number }): { kind: AbKind; days: number; points: AbTrendPoint[] } {
    const days = Math.max(7, Math.min(180, Math.floor(opts?.days ?? 30)));
    const rows = db.prepare(`
      SELECT captured_on AS date, control_rate AS controlRate, control_sent AS controlSent,
             calibrated_rate AS calibratedRate, calibrated_sent AS calibratedSent, winner
        FROM ab_trend_snapshots
       WHERE organization_id = ? AND kind = ? AND captured_on >= date('now', ?)
       ORDER BY captured_on ASC
    `).all(orgId, kind, `-${days} days`) as any[];
    const points: AbTrendPoint[] = rows.map((r) => ({
      date: String(r.date),
      controlRate: Number(r.controlRate || 0), controlSent: Number(r.controlSent || 0),
      calibratedRate: Number(r.calibratedRate || 0), calibratedSent: Number(r.calibratedSent || 0),
      winner: r.winner || null,
    }));
    return { kind, days, points };
  }
}

export default AbTrendService;
