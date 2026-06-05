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
    const capacity = Number(r.capacity || 1);
    const ocupadas = Number(row?.ocupadas || 0);
    const livres = Math.max(0, capacity - ocupadas);
    return { ok: true, capacity, ocupadas, livres, bookable: livres >= units };
  }

  /**
   * Cria uma reserva validando a disponibilidade de forma ATÔMICA (transação),
   * evitando corrida que gere overbooking. Calcula total = preço × períodos × unid.
   */
  static create(orgId: string, p: {
    resourceId: string; contactId?: string; ticketId?: string;
    startAt: string; endAt: string; units?: number; guests?: number;
    notes?: string; createdBy?: string; depositAmount?: number;
  }): { id: string } {
    const units = Math.max(1, Number(p.units || 1));
    const tx = db.transaction(() => {
      const r = this.getResource(orgId, p.resourceId);
      if (!r) throw new Error("resource_not_found");
      const av = this.availability(orgId, p.resourceId, p.startAt, p.endAt, units);
      if (!av.ok) throw new Error(av.reason || "invalid_period");
      if (!av.bookable) throw new Error("no_availability");

      const periods = this.periods(p.startAt, p.endAt, (r.reservation_unit || "night") as ReservationUnit);
      const total = Number(r.price || 0) * periods * units;
      const id = uuidv4();
      db.prepare(
        `INSERT INTO reservations
           (id, organization_id, resource_id, contact_id, ticket_id, start_at, end_at,
            units, guests, status, total_amount, deposit_amount, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`
      ).run(
        id, orgId, p.resourceId, p.contactId || null, p.ticketId || null, p.startAt, p.endAt,
        units, p.guests ?? null, total, Number(p.depositAmount || 0), p.createdBy || "owner"
      );
      return id;
    });
    return { id: tx() };
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
