import db from "./db.js";
import { randomUUID } from "crypto";
import { CollectionAbMeasurementService } from "./CollectionAbMeasurementService.js";
import { SalesRecoveryAbMeasurementService } from "./SalesRecoveryAbMeasurementService.js";
import { ReferralProgramMeasurementService } from "./ReferralProgramMeasurementService.js";

/**
 * AbTrendService — histórico temporal pro gráfico da aba Operações (ADR-155).
 * Cobre 3 kinds: `collection`/`sales_recovery` (A/B control × calibrada, duas
 * linhas) e `referral` (conversão do programa de indicação, uma linha).
 *
 * A taxa CUMULATIVA de um dia passado NÃO é derivável do estado atual (precisaria
 * das contagens daquele dia), então gravamos um SNAPSHOT diário (append-only, 1
 * por org/kind/dia via upsert) do que os *MeasurementService medem — não é
 * contador mutável (RN-004), é log de fato histórico. Sem backfill: a série
 * começa a acumular a partir do 1º snapshot (honesto — não inventamos histórico).
 */

export type AbKind = "collection" | "sales_recovery" | "referral";

export interface AbTrendPoint {
  date: string;
  // A/B (collection | sales_recovery):
  controlRate: number; controlSent: number;
  calibratedRate: number; calibratedSent: number;
  winner: string | null;
  // referral:
  conversionRate: number; referred: number; qualified: number;
}

const UPSERT = `
  INSERT INTO ab_trend_snapshots
    (id, organization_id, kind, captured_on, control_rate, control_sent, calibrated_rate, calibrated_sent, winner, referred, qualified, conversion_rate)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(organization_id, kind, captured_on) DO UPDATE SET
    control_rate = excluded.control_rate, control_sent = excluded.control_sent,
    calibrated_rate = excluded.calibrated_rate, calibrated_sent = excluded.calibrated_sent,
    winner = excluded.winner,
    referred = excluded.referred, qualified = excluded.qualified, conversion_rate = excluded.conversion_rate
`;

export class AbTrendService {
  static todayIso(): string { return new Date().toISOString().slice(0, 10); }

  /** Grava (upsert) o snapshot de um dia pra uma org/kind. Skip se sem dados. */
  static capture(orgId: string, kind: AbKind, day?: string): { captured: boolean } {
    const on = day || this.todayIso();

    if (kind === "referral") {
      const m = ReferralProgramMeasurementService.measure(orgId);
      if (m.codesIssued === 0) return { captured: false };
      db.prepare(UPSERT).run(randomUUID(), orgId, kind, on, 0, 0, 0, 0, null, m.referred, m.qualified, m.conversionRatePct);
      return { captured: true };
    }

    const m = kind === "collection" ? CollectionAbMeasurementService.measure(orgId) : SalesRecoveryAbMeasurementService.measure(orgId);
    const total = kind === "collection" ? (m as any).totalActions : (m as any).totalTickets;
    if (total === 0) return { captured: false };
    const c = m.variants.find((v: any) => v.variant === "control");
    const cal = m.variants.find((v: any) => v.variant === "calibrated");
    db.prepare(UPSERT).run(randomUUID(), orgId, kind, on,
      c?.recoveryRatePct ?? 0, c?.sent ?? 0, cal?.recoveryRatePct ?? 0, cal?.sent ?? 0, m.winner ?? null, 0, 0, 0);
    return { captured: true };
  }

  /** Snapshot de hoje pra todas as orgs com dado (3 kinds). Best-effort. */
  static captureAll(): { collection: number; sales_recovery: number; referral: number } {
    const out = { collection: 0, sales_recovery: 0, referral: 0 };
    const run = (sql: string, kind: AbKind) => {
      for (const o of db.prepare(sql).all() as any[]) {
        try { if (this.capture(String(o.orgId), kind).captured) (out as any)[kind]++; }
        catch (e) { console.error(`[AbTrend] capture ${kind} falhou`, o.orgId, e); }
      }
    };
    run(`SELECT DISTINCT organization_id AS orgId FROM collection_followup_attempts`, "collection");
    run(`SELECT DISTINCT organization_id AS orgId FROM sales_recovery_touches`, "sales_recovery");
    run(`SELECT DISTINCT organization_id AS orgId FROM referral_codes`, "referral");
    return out;
  }

  /** Série dos últimos N dias (só dias com snapshot; o front alinha o eixo). */
  static series(orgId: string, kind: AbKind, opts?: { days?: number }): { kind: AbKind; days: number; points: AbTrendPoint[] } {
    const days = Math.max(7, Math.min(180, Math.floor(opts?.days ?? 30)));
    const rows = db.prepare(`
      SELECT captured_on AS date, control_rate AS controlRate, control_sent AS controlSent,
             calibrated_rate AS calibratedRate, calibrated_sent AS calibratedSent, winner,
             referred, qualified, conversion_rate AS conversionRate
        FROM ab_trend_snapshots
       WHERE organization_id = ? AND kind = ? AND captured_on >= date('now', ?)
       ORDER BY captured_on ASC
    `).all(orgId, kind, `-${days} days`) as any[];
    const points: AbTrendPoint[] = rows.map((r) => ({
      date: String(r.date),
      controlRate: Number(r.controlRate || 0), controlSent: Number(r.controlSent || 0),
      calibratedRate: Number(r.calibratedRate || 0), calibratedSent: Number(r.calibratedSent || 0),
      winner: r.winner || null,
      conversionRate: Number(r.conversionRate || 0), referred: Number(r.referred || 0), qualified: Number(r.qualified || 0),
    }));
    return { kind, days, points };
  }
}

export default AbTrendService;
