/**
 * ProfessionalScheduleConfigService — ADR-180 F2: serviços ofertados + janelas de
 * disponibilidade do profissional POR CLÍNICA (Agenda Federada).
 *
 * A identidade é global (F1); AQUI a clínica configura, sobre um VÍNCULO
 * (relationship), o que o profissional oferta nela (serviços + duração) e QUANDO ele
 * trabalha nela (janelas semanais + buffer). É a config que o Availability Engine (F3)
 * consome para provar horários livres — nunca inventa vaga (RN-PN-4).
 *
 * Guardrails: isolamento por org (RN-PN-2 — orgId 1º arg; toda query filtra
 * organization_id e confere que o vínculo é da org); só configura vínculo NÃO revogado;
 * valida o serviço no catálogo da org (products_services) — não inventa serviço;
 * janelas validadas (dia 0..6, 0 ≤ start < end ≤ 1440, buffer ≥ 0). Determinístico.
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicProfessionalRelationshipService } from "./ClinicProfessionalRelationshipService.js";

export interface OfferingInput { serviceId?: string; durationMin?: number | null; active?: boolean; }
export interface Offering {
  id: string; relationshipId: string; serviceId: string; serviceName: string | null;
  durationMin: number | null;              // efetiva (override → catálogo)
  durationSource: "override" | "catalog" | "unknown";
  active: boolean;
}
export interface WindowInput { dayOfWeek?: number; start?: string | number; end?: string | number; bufferMin?: number; }
export interface AvailabilityWindow {
  id: string; relationshipId: string; dayOfWeek: number;
  startMinute: number; endMinute: number; start: string; end: string; bufferMin: number; active: boolean;
}

const DAY_MS = 24 * 60;

function toMinutes(v: string | number | undefined): number {
  if (typeof v === "number") return Math.round(v);
  const s = String(v ?? "").trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}
function toHHMM(min: number): string {
  const h = Math.floor(min / 60), m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export class ProfessionalScheduleConfigService {
  /** Confere que o vínculo é da org e não está revogado; devolve-o ou lança. */
  private static requireLiveRel(orgId: string, relationshipId: string) {
    const rel = ClinicProfessionalRelationshipService.get(orgId, relationshipId);
    if (!rel) throw new Error("relationship_not_found");           // isolamento (RN-PN-2)
    if (rel.status === "revoked") throw new Error("relationship_revoked");
    return rel;
  }

  // ── Serviços ofertados ───────────────────────────────────────────────────────
  private static mapOffering(r: any): Offering {
    const svc = db.prepare(`SELECT name, duration_minutes FROM products_services WHERE id = ? AND organization_id = ?`).get(r.service_id, r.organization_id) as any;
    const override = r.duration_min == null ? null : Number(r.duration_min);
    const catalog = svc && svc.duration_minutes != null ? Number(svc.duration_minutes) : null;
    const durationMin = override != null ? override : catalog;
    return {
      id: r.id, relationshipId: r.relationship_id, serviceId: r.service_id,
      serviceName: svc ? svc.name : null,
      durationMin, durationSource: override != null ? "override" : (catalog != null ? "catalog" : "unknown"),
      active: !!r.active,
    };
  }

  /** Adiciona (ou atualiza) um serviço ofertado no vínculo. Valida serviço no catálogo. */
  static setOffering(orgId: string, relationshipId: string, input: OfferingInput, actorId?: string): Offering {
    this.requireLiveRel(orgId, relationshipId);
    const serviceId = String(input.serviceId || "").trim();
    if (!serviceId) throw new Error("service_id_required");
    const svc = db.prepare(`SELECT id FROM products_services WHERE id = ? AND organization_id = ? AND type = 'service'`).get(serviceId, orgId) as any;
    if (!svc) throw new Error("service_not_found");                // não inventa serviço
    let durationMin: number | null = null;
    if (input.durationMin != null) {
      durationMin = Math.round(Number(input.durationMin));
      if (!(durationMin > 0)) throw new Error("duration_invalid");
    }
    const active = input.active === false ? 0 : 1;
    const existing = db.prepare(`SELECT id FROM clinic_professional_offerings WHERE organization_id = ? AND relationship_id = ? AND service_id = ?`).get(orgId, relationshipId, serviceId) as any;
    if (existing) {
      db.prepare(`UPDATE clinic_professional_offerings SET duration_min = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(durationMin, active, existing.id);
      try { logAuthEvent(orgId, actorId || "system", existing.id, "PROF_OFFERING_UPDATE", { serviceId }); } catch { /* noop */ }
      return this.getOffering(orgId, existing.id)!;
    }
    const id = randomUUID();
    db.prepare(`INSERT INTO clinic_professional_offerings (id, organization_id, relationship_id, service_id, duration_min, active) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, orgId, relationshipId, serviceId, durationMin, active);
    try { logAuthEvent(orgId, actorId || "system", id, "PROF_OFFERING_ADD", { serviceId }); } catch { /* noop */ }
    return this.getOffering(orgId, id)!;
  }

  static getOffering(orgId: string, offeringId: string): Offering | null {
    const r = db.prepare(`SELECT * FROM clinic_professional_offerings WHERE organization_id = ? AND id = ?`).get(orgId, String(offeringId || "")) as any;
    return r ? this.mapOffering(r) : null;
  }

  static listOfferings(orgId: string, relationshipId: string, opts?: { includeInactive?: boolean }): Offering[] {
    this.requireLiveRel(orgId, relationshipId);
    let sql = `SELECT * FROM clinic_professional_offerings WHERE organization_id = ? AND relationship_id = ?`;
    if (!opts?.includeInactive) sql += ` AND active = 1`;
    sql += ` ORDER BY created_at`;
    const rows = db.prepare(sql).all(orgId, relationshipId) as any[];
    return rows.map((r) => this.mapOffering(r));
  }

  static removeOffering(orgId: string, offeringId: string, actorId?: string): { removed: boolean } {
    const r = db.prepare(`SELECT id FROM clinic_professional_offerings WHERE organization_id = ? AND id = ?`).get(orgId, String(offeringId || "")) as any;
    if (!r) return { removed: false };                             // isolamento: outra org não apaga
    db.prepare(`DELETE FROM clinic_professional_offerings WHERE organization_id = ? AND id = ?`).run(orgId, offeringId);
    try { logAuthEvent(orgId, actorId || "system", offeringId, "PROF_OFFERING_REMOVE", {}); } catch { /* noop */ }
    return { removed: true };
  }

  // ── Janelas de disponibilidade ───────────────────────────────────────────────
  private static mapWindow(r: any): AvailabilityWindow {
    return {
      id: r.id, relationshipId: r.relationship_id, dayOfWeek: r.day_of_week,
      startMinute: r.start_minute, endMinute: r.end_minute,
      start: toHHMM(r.start_minute), end: toHHMM(r.end_minute),
      bufferMin: r.buffer_min ?? 0, active: !!r.active,
    };
  }

  /**
   * Substitui TODAS as janelas do vínculo pela lista dada (replace-all — mais simples
   * e determinístico que editar incrementalmente). Valida cada janela.
   */
  static setWindows(orgId: string, relationshipId: string, windows: WindowInput[], actorId?: string): AvailabilityWindow[] {
    this.requireLiveRel(orgId, relationshipId);
    const rows: Array<{ id: string; day: number; start: number; end: number; buffer: number }> = [];
    for (const w of Array.isArray(windows) ? windows : []) {
      const day = Number(w.dayOfWeek);
      if (!Number.isInteger(day) || day < 0 || day > 6) throw new Error("day_of_week_invalid");
      const start = toMinutes(w.start), end = toMinutes(w.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("window_time_invalid");
      if (start < 0 || end > DAY_MS || start >= end) throw new Error("window_range_invalid");
      const buffer = w.bufferMin == null ? 0 : Math.round(Number(w.bufferMin));
      if (!(buffer >= 0)) throw new Error("buffer_invalid");
      rows.push({ id: randomUUID(), day, start, end, buffer });
    }
    const tx = db.transaction(() => {
      db.prepare(`DELETE FROM clinic_professional_windows WHERE organization_id = ? AND relationship_id = ?`).run(orgId, relationshipId);
      const ins = db.prepare(`INSERT INTO clinic_professional_windows (id, organization_id, relationship_id, day_of_week, start_minute, end_minute, buffer_min, active) VALUES (?, ?, ?, ?, ?, ?, ?, 1)`);
      for (const r of rows) ins.run(r.id, orgId, relationshipId, r.day, r.start, r.end, r.buffer);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", relationshipId, "PROF_WINDOWS_SET", { count: rows.length }); } catch { /* noop */ }
    return this.listWindows(orgId, relationshipId);
  }

  static listWindows(orgId: string, relationshipId: string): AvailabilityWindow[] {
    this.requireLiveRel(orgId, relationshipId);
    const rows = db.prepare(`SELECT * FROM clinic_professional_windows WHERE organization_id = ? AND relationship_id = ? ORDER BY day_of_week, start_minute`).all(orgId, relationshipId) as any[];
    return rows.map((r) => this.mapWindow(r));
  }
}

export default ProfessionalScheduleConfigService;
