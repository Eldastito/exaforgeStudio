import db from "./db.js";
import { v4 as uuidv4 } from "uuid";

export type ReservationUnit = "night" | "hour" | "slot" | "day";

// Motor de reservas por período. O recurso reservável é um products_services
// (type 'reservation') com `capacity` (unidades simultâneas) e `reservation_unit`.
// A disponibilidade é calculada por SOBREPOSIÇÃO de período contra a capacidade.
export class ReservationService {
  /** Recursos reserváveis ativos da organização. */
  static listResources(orgId: string): any[] {
    return db.prepare(
      `SELECT id, name, description, price, capacity, reservation_unit
         FROM products_services
        WHERE organization_id = ? AND type = 'reservation' AND active = 1
        ORDER BY name ASC`
    ).all(orgId) as any[];
  }

  /** Cria um recurso reservável (products_services type 'reservation'). Fica
   *  sob o módulo de reservas — não exige o módulo Catálogo habilitado. */
  static createResource(orgId: string, p: { name: string; price?: number; capacity?: number; reservationUnit?: string }): { id: string } {
    const id = uuidv4();
    const unit = ["night", "hour", "slot", "day"].includes(String(p.reservationUnit)) ? p.reservationUnit : "night";
    db.prepare(
      `INSERT INTO products_services (id, organization_id, type, name, price, active, capacity, reservation_unit)
       VALUES (?, ?, 'reservation', ?, ?, 1, ?, ?)`
    ).run(id, orgId, String(p.name).trim(), Number(p.price || 0), Number(p.capacity) > 0 ? Number(p.capacity) : 1, unit);
    return { id };
  }

  static getResource(orgId: string, resourceId: string): any | null {
    return (db.prepare(
      `SELECT id, name, description, price, capacity, reservation_unit
         FROM products_services
        WHERE id = ? AND organization_id = ? AND type = 'reservation'`
    ).get(resourceId, orgId) as any) || null;
  }

  /** Nº de períodos cobrados entre start e end conforme a unidade do recurso. */
  static periods(startAt: string, endAt: string, unit: ReservationUnit): number {
    const s = new Date(startAt).getTime();
    const e = new Date(endAt).getTime();
    if (!(e > s)) return 0;
    const ms = e - s;
    if (unit === "hour") return Math.ceil(ms / 3_600_000);
    if (unit === "night" || unit === "day") return Math.max(1, Math.ceil(ms / 86_400_000));
    return 1; // slot/turno: 1 período
  }

  /**
   * Disponibilidade de um recurso num período. Conta as reservas que se
   * SOBREPÕEM (start < endPedido e end > startPedido) e ainda contam como
   * ocupação (pending/confirmed), comparando com a capacidade.
   * Regra: check-out no mesmo instante do check-in NÃO conflita.
   */
  static availability(orgId: string, resourceId: string, startAt: string, endAt: string, units = 1): {
    ok: boolean; capacity: number; ocupadas: number; livres: number; bookable: boolean; reason?: string;
  } {
    const r = this.getResource(orgId, resourceId);
    if (!r) return { ok: false, capacity: 0, ocupadas: 0, livres: 0, bookable: false, reason: "resource_not_found" };
    const s = new Date(startAt), e = new Date(endAt);
    if (isNaN(s.getTime()) || isNaN(e.getTime()) || e <= s) {
      return { ok: false, capacity: r.capacity || 1, ocupadas: 0, livres: 0, bookable: false, reason: "invalid_period" };
    }
    const row = db.prepare(
      `SELECT COALESCE(SUM(units),0) AS ocupadas
         FROM reservations
        WHERE organization_id = ? AND resource_id = ?
          AND status IN ('pending','confirmed')
          AND start_at < ? AND end_at > ?`
    ).get(orgId, resourceId, endAt, startAt) as any;
    let capacity = Number(r.capacity || 1);
    // Conector externo (PMS/OTA): se há override de disponibilidade nas datas do
    // período, o TETO de unidades vendáveis passa a ser o menor valor informado.
    try {
      const days = this.daysInRange(startAt, endAt);
      if (days.length) {
        const ph = days.map(() => '?').join(',');
        const ov = db.prepare(
          `SELECT date, available_units FROM resource_availability
            WHERE organization_id = ? AND resource_id = ? AND available_units IS NOT NULL AND date IN (${ph})`
        ).all(orgId, resourceId, ...days) as any[];
        if (ov.length) {
          const map = new Map(ov.map(o => [o.date, Number(o.available_units)]));
          let minCap = capacity;
          for (const d of days) minCap = Math.min(minCap, map.has(d) ? (map.get(d) as number) : capacity);
          capacity = Math.max(0, minCap);
        }
      }
    } catch (e) { /* sem override: mantém capacidade interna */ }
    const ocupadas = Number(row?.ocupadas || 0);
    const livres = Math.max(0, capacity - ocupadas);
    return { ok: true, capacity, ocupadas, livres, bookable: livres >= units };
  }

  /** Dias (YYYY-MM-DD, fuso America/Sao_Paulo) cobertos por uma estadia. Para
   *  diárias, vai do check-in até a véspera do check-out; day-use = só o dia. */
  static daysInRange(startAt: string, endAt: string): string[] {
    const s = new Date(startAt).getTime();
    const e = new Date(endAt).getTime();
    if (!(e > s)) return [];
    const local = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
    const sd = local(s), ed = local(e);
    if (sd === ed) return [sd];
    const out: string[] = [];
    // Âncora ao meio-dia UTC para imunizar contra horário de verão ao incrementar.
    let cur = new Date(`${sd}T12:00:00Z`);
    const stop = new Date(`${ed}T12:00:00Z`);
    while (cur.getTime() < stop.getTime()) {
      out.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return out.length ? out : [sd];
  }

  /** Total da reserva considerando preços por data (override do conector) quando
   *  existirem; senão usa o preço-base do recurso × períodos. */
  static ratedTotal(orgId: string, resource: any, startAt: string, endAt: string, units: number): number {
    const unit = (resource.reservation_unit || "night") as ReservationUnit;
    const base = Number(resource.price || 0);
    if (unit === "night" || unit === "day") {
      const days = this.daysInRange(startAt, endAt);
      if (!days.length) return 0;
      const ph = days.map(() => '?').join(',');
      let pmap = new Map<string, number>();
      try {
        const rows = db.prepare(
          `SELECT date, price_override FROM resource_availability
            WHERE organization_id = ? AND resource_id = ? AND price_override IS NOT NULL AND date IN (${ph})`
        ).all(orgId, resource.id, ...days) as any[];
        pmap = new Map(rows.map(r => [r.date, Number(r.price_override)]));
      } catch (e) { /* sem override de preço */ }
      let sum = 0;
      for (const d of days) sum += pmap.has(d) ? (pmap.get(d) as number) : base;
      return Math.round(sum * units * 100) / 100;
    }
    const periods = this.periods(startAt, endAt, unit);
    return Math.round(base * periods * units * 100) / 100;
  }

  /**
   * Importa/atualiza recursos reserváveis em lote (planilha). Casa por NOME
   * (case-insensitive). Cria o que não existe, atualiza preço/capacidade/unidade
   * do que já existe. Idempotente.
   */
  static importResources(orgId: string, rows: { name: string; price?: number; capacity?: number; unit?: string }[]): { created: number; updated: number; skipped: number } {
    const report = { created: 0, updated: 0, skipped: 0 };
    const valid = (u: any) => ["night", "hour", "slot", "day"].includes(String(u)) ? String(u) : "night";
    for (const r of rows || []) {
      const name = String(r?.name || "").trim();
      if (!name) { report.skipped++; continue; }
      const existing = db.prepare(
        `SELECT id FROM products_services WHERE organization_id = ? AND type = 'reservation' AND lower(name) = lower(?)`
      ).get(orgId, name) as any;
      const price = Number(r.price);
      const cap = Number(r.capacity);
      if (existing) {
        db.prepare(
          `UPDATE products_services SET price = ?, capacity = ?, reservation_unit = ?, active = 1 WHERE id = ?`
        ).run(isFinite(price) ? price : 0, isFinite(cap) && cap > 0 ? cap : 1, valid(r.unit), existing.id);
        report.updated++;
      } else {
        this.createResource(orgId, { name, price: isFinite(price) ? price : 0, capacity: isFinite(cap) ? cap : 1, reservationUnit: valid(r.unit) });
        report.created++;
      }
    }
    return report;
  }

  /** Aplica override de disponibilidade/preço por data (vindo do conector). */
  static setAvailability(orgId: string, rows: { resource: string; date: string; available?: number | null; price?: number | null }[], source = 'webhook'): { applied: number; unknownResources: string[] } {
    const unknown = new Set<string>();
    let applied = 0;
    const ins = db.prepare(`
      INSERT INTO resource_availability (id, organization_id, resource_id, date, available_units, price_override, source, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(organization_id, resource_id, date) DO UPDATE SET
        available_units = COALESCE(excluded.available_units, resource_availability.available_units),
        price_override = COALESCE(excluded.price_override, resource_availability.price_override),
        source = excluded.source, updated_at = CURRENT_TIMESTAMP
    `);
    for (const r of rows || []) {
      const date = String(r?.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      // Resolve o recurso por id OU por nome.
      let res = this.getResource(orgId, String(r.resource || ""));
      if (!res) {
        res = db.prepare(`SELECT id FROM products_services WHERE organization_id = ? AND type = 'reservation' AND lower(name) = lower(?)`).get(orgId, String(r.resource || "")) as any;
      }
      if (!res) { unknown.add(String(r.resource || "")); continue; }
      const avail = r.available != null && isFinite(Number(r.available)) ? Math.max(0, parseInt(String(r.available), 10)) : null;
      const price = r.price != null && isFinite(Number(r.price)) ? Math.max(0, Number(r.price)) : null;
      if (avail == null && price == null) continue;
      ins.run(uuidv4(), orgId, res.id, date, avail, price, source);
      applied++;
    }
    return { applied, unknownResources: [...unknown] };
  }

  /**
   * Cria uma reserva validando a disponibilidade de forma ATÔMICA (transação),
   * evitando corrida que gere overbooking. Calcula total = preço × períodos × unid.
   */
  static create(orgId: string, p: {
    resourceId: string; contactId?: string; ticketId?: string;
    startAt: string; endAt: string; units?: number; guests?: number;
    notes?: string; createdBy?: string; depositAmount?: number;
    adults?: number; children?: number; pets?: number; specialRequests?: string; budget?: number;
  }): { id: string } {
    const units = Math.max(1, Number(p.units || 1));
    const tx = db.transaction(() => {
      const r = this.getResource(orgId, p.resourceId);
      if (!r) throw new Error("resource_not_found");
      const av = this.availability(orgId, p.resourceId, p.startAt, p.endAt, units);
      if (!av.ok) throw new Error(av.reason || "invalid_period");
      if (!av.bookable) throw new Error("no_availability");

      // Total respeitando preços por data do conector externo (PMS/OTA), quando houver.
      const total = this.ratedTotal(orgId, r, p.startAt, p.endAt, units);
      // Sinal: % configurado pela org (0 = sem sinal). depositAmount explícito tem prioridade.
      let deposit = Number(p.depositAmount || 0);
      if (!deposit) {
        const o = db.prepare("SELECT reservation_deposit_percent FROM organization_settings WHERE organization_id = ?").get(orgId) as any;
        const pct = Math.min(100, Math.max(0, Number(o?.reservation_deposit_percent || 0)));
        if (pct > 0) deposit = Math.round(total * pct) / 100;
      }
      // Hospedagem: se não vier "guests", deriva de adultos+crianças.
      const adults = p.adults != null ? Math.max(0, Number(p.adults)) : null;
      const children = p.children != null ? Math.max(0, Number(p.children)) : null;
      const guests = p.guests ?? ((adults != null || children != null) ? (adults || 0) + (children || 0) : null);
      const id = uuidv4();
      db.prepare(
        `INSERT INTO reservations
           (id, organization_id, resource_id, contact_id, ticket_id, start_at, end_at,
            units, guests, adults, children, pets, special_requests, budget,
            status, total_amount, deposit_amount, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(
        id, orgId, p.resourceId, p.contactId || null, p.ticketId || null, p.startAt, p.endAt,
        units, guests, adults, children, p.pets ? 1 : 0, p.specialRequests || null, p.budget ?? null,
        total, deposit, p.createdBy || "owner"
      );
      return id;
    });
    return { id: tx() };
  }

  /** Casa um recurso por nome (aproximado) — usado pela IA. */
  static matchResource(orgId: string, name: string): any | null {
    const norm = (s: string) => (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    const tn = norm(name);
    if (!tn) return null;
    const list = this.listResources(orgId);
    for (const r of list) { if (norm(r.name) === tn) return r; }
    for (const r of list) { const rn = norm(r.name); if (rn && (tn.includes(rn) || rn.includes(tn))) return r; }
    return null;
  }

  /** Marca uma reserva como paga e confirmada (webhook de pagamento). */
  static markPaid(orgId: string, reservationId: string): boolean {
    const r = db.prepare("SELECT id, payment_status FROM reservations WHERE id = ? AND organization_id = ?").get(reservationId, orgId) as any;
    if (!r) return false;
    db.prepare("UPDATE reservations SET payment_status = 'paid', status = 'confirmed' WHERE id = ? AND organization_id = ?").run(reservationId, orgId);
    return true;
  }

  static updateStatus(orgId: string, id: string, status: string): void {
    const allowed = ["pending", "confirmed", "cancelled", "completed", "no_show"];
    if (!allowed.includes(status)) throw new Error("invalid_status");
    db.prepare("UPDATE reservations SET status = ? WHERE id = ? AND organization_id = ?").run(status, id, orgId);
  }

  /** Lista reservas (com nome do recurso e do contato) para a aba Reservas. */
  static list(orgId: string, filters: { status?: string; resourceId?: string } = {}): any[] {
    const where: string[] = ["r.organization_id = ?"];
    const args: any[] = [orgId];
    if (filters.status) { where.push("r.status = ?"); args.push(filters.status); }
    if (filters.resourceId) { where.push("r.resource_id = ?"); args.push(filters.resourceId); }
    return db.prepare(
      `SELECT r.*, p.name AS resource_name, p.reservation_unit, c.name AS contact_name
         FROM reservations r
         LEFT JOIN products_services p ON p.id = r.resource_id
         LEFT JOIN contacts c ON c.id = r.contact_id
        WHERE ${where.join(" AND ")}
        ORDER BY r.start_at DESC
        LIMIT 500`
    ).all(...args) as any[];
  }
}
