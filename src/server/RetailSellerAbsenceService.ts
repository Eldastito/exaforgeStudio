/**
 * RetailSellerAbsenceService — férias/afastamento do vendedor (PRD Fase 1, F1.5).
 *
 * Existe só para a ELEGIBILIDADE da meta: um mês coberto por ausência não pode virar "meta não
 * batida" (seria injusto e geraria alerta falso ao gestor sobre uma pessoa). A escala semanal só
 * conhece work/off (férias entra como 'off', indistinguível de folga), então o lançamento é explícito.
 * Lançamento humano (owner/admin na rota); cancelar é UPDATE (nunca DELETE). Ausência é atributo da
 * PESSOA: fundir vendedores (F1.1) soma as ausências das identidades ligadas.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { RetailSellerIdentityService } from "./RetailSellerIdentityService.js";

export type AbsenceType = "ferias" | "afastamento";
const TYPES: AbsenceType[] = ["ferias", "afastamento"];
const isoDay = (v: unknown): string | null => { const s = String(v ?? "").slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const dayMs = (d: string) => Date.parse(`${d}T12:00:00Z`);

export class RetailSellerAbsenceService {
  static add(orgId: string, input: { sellerId: string; type: AbsenceType; startDate: string; endDate: string; note?: string | null }, actorId?: string | null): any {
    if (!db.prepare(`SELECT 1 FROM retail_sellers WHERE organization_id = ? AND id = ?`).get(orgId, String(input.sellerId || ""))) throw new Error("Vendedor não encontrado.");
    if (!TYPES.includes(input.type)) throw new Error(`type inválido (${TYPES.join("|")}).`);
    const start = isoDay(input.startDate), end = isoDay(input.endDate);
    if (!start || !end) throw new Error("Datas inválidas (YYYY-MM-DD).");
    if (end < start) throw new Error("endDate anterior a startDate.");
    if ((dayMs(end) - dayMs(start)) / 86400000 > 400) throw new Error("Período longo demais (máx. ~13 meses).");
    const id = randomUUID();
    db.prepare(`INSERT INTO retail_seller_absences (id, organization_id, seller_id, type, start_date, end_date, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, input.sellerId, input.type, start, end, input.note ? String(input.note).slice(0, 300) : null, actorId || null);
    try { logAuthEvent(orgId, actorId || "system", input.sellerId, "RETAIL_SELLER_ABSENCE_ADDED", { type: input.type, start, end }); } catch { /* noop */ }
    return { id, sellerId: input.sellerId, type: input.type, startDate: start, endDate: end };
  }

  static list(orgId: string, sellerId?: string | null): any[] {
    return db.prepare(
      `SELECT id, seller_id, type, start_date, end_date, note, created_at, cancelled_at FROM retail_seller_absences
        WHERE organization_id = ? ${sellerId ? "AND seller_id = ?" : ""} ORDER BY start_date DESC`
    ).all(...(sellerId ? [orgId, sellerId] : [orgId])) as any[];
  }

  static cancel(orgId: string, id: string, actorId?: string | null): boolean {
    const r = db.prepare(`UPDATE retail_seller_absences SET cancelled_at = CURRENT_TIMESTAMP, cancelled_by = ? WHERE organization_id = ? AND id = ? AND cancelled_at IS NULL`).run(actorId || null, orgId, id);
    if (r.changes > 0) { try { logAuthEvent(orgId, actorId || "system", id, "RETAIL_SELLER_ABSENCE_CANCELLED", {}); } catch { /* noop */ } }
    return r.changes > 0;
  }

  /**
   * Dias do mês cobertos por ausência (união dos períodos, sem contar o mesmo dia 2x) da PESSOA:
   * inclui as identidades fundidas nela. `month` = YYYY-MM.
   */
  static daysAbsentInMonth(orgId: string, sellerId: string, month: string, ctx = RetailSellerIdentityService.context(orgId)): number {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser YYYY-MM");
    const canon = ctx.canonicalSeller(sellerId);
    const ids = new Set<string>([sellerId]);
    if (canon) {
      ids.add(canon.id);
      for (const row of db.prepare(`SELECT id, merged_into_seller_id FROM retail_sellers WHERE organization_id = ? AND merged_into_seller_id IS NOT NULL`).all(orgId) as any[]) {
        if ((ctx.canonicalSeller(row.id) || row).id === canon.id) ids.add(row.id);
      }
    }
    const [y, m] = month.split("-").map(Number);
    const first = `${month}-01`, last = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
    const rows = db.prepare(
      `SELECT start_date, end_date FROM retail_seller_absences WHERE organization_id = ? AND cancelled_at IS NULL AND seller_id IN (${[...ids].map(() => "?").join(",")}) AND end_date >= ? AND start_date <= ?`
    ).all(orgId, ...ids, first, last) as any[];
    const covered = new Set<string>();
    for (const r of rows) {
      let d = r.start_date < first ? first : r.start_date;
      const stop = r.end_date > last ? last : r.end_date;
      for (let t = dayMs(d); t <= dayMs(stop); t += 86400000) covered.add(new Date(t).toISOString().slice(0, 10));
    }
    return covered.size;
  }
}

export default RetailSellerAbsenceService;
