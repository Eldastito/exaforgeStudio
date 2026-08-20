/**
 * ProfessionalAvailabilityService — ADR-180 F3: Availability Engine + Hold atômico
 * (Agenda Federada).
 *
 * Prova quais horários do profissional estão REALMENTE livres numa clínica, a partir
 * da config da F2 (janelas semanais + serviços ofertados), e reserva a vaga com um
 * HOLD temporário atômico antes de confirmar (RN-PN-4: nunca inventa vaga; RN-PN-5:
 * confirmação ≠ agendamento). É a peça que quebra a dependência do contato manual: o
 * ZapFlow oferece só o que o expediente do profissional comporta.
 *
 * Guardrails: isolamento por org (RN-PN-2 — orgId 1º arg, vínculo conferido da org);
 * só oferta/reserva sobre vínculo ACEITO (pending não agenda); a vaga só vira reserva
 * após guarda ATÔMICA (SELECT COUNT dentro da transação antes do INSERT — padrão
 * AC-012), então duas reservas na mesma vaga → só uma vence; holds expiram por TTL e
 * holds expirados NÃO bloqueiam. Determinístico (nowISO/token injetáveis p/ testar).
 */
import { randomUUID } from "crypto";
import db from "./db.js";
import { logAuthEvent } from "./auditLog.js";
import { ClinicProfessionalRelationshipService } from "./ClinicProfessionalRelationshipService.js";
import { ProfessionalScheduleConfigService } from "./ProfessionalScheduleConfigService.js";

export interface Slot { start: string; end: string; startMinute: number; durationMin: number; }
export interface Hold {
  id: string; relationshipId: string; professionalId: string; serviceId: string | null;
  start: string; end: string; status: string; holdToken: string; expiresAt: string | null;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
/** ISO UTC "YYYY-MM-DDTHH:MM:00.000Z" a partir de data + minuto-do-dia. */
function isoAt(dateISO: string, minute: number): string {
  const h = Math.floor(minute / 60), m = minute % 60;
  return `${dateISO}T${pad(h)}:${pad(m)}:00.000Z`;
}
function toMs(iso: string): number { return new Date(iso).getTime(); }
/** day-of-week 0=Dom..6=Sáb, em UTC, a partir de "YYYY-MM-DD". */
function dowOf(dateISO: string): number { return new Date(`${dateISO}T00:00:00.000Z`).getUTCDay(); }

export class ProfessionalAvailabilityService {
  private static requireAcceptedRel(orgId: string, relationshipId: string) {
    const rel = ClinicProfessionalRelationshipService.get(orgId, relationshipId);
    if (!rel) throw new Error("relationship_not_found");            // isolamento (RN-PN-2)
    if (rel.status !== "accepted") throw new Error("relationship_not_accepted"); // pending/revoked não agenda
    return rel;
  }

  /** Duração efetiva do serviço no vínculo (offering); erro se desconhecida. */
  private static durationFor(orgId: string, relationshipId: string, serviceId?: string, fallbackMin?: number): number {
    if (serviceId) {
      const off = ProfessionalScheduleConfigService.listOfferings(orgId, relationshipId).find((o) => o.serviceId === serviceId);
      if (!off) throw new Error("service_not_offered");
      if (off.durationMin == null || !(off.durationMin > 0)) throw new Error("service_duration_unknown"); // não inventa duração
      return off.durationMin;
    }
    if (fallbackMin != null && fallbackMin > 0) return Math.round(fallbackMin);
    throw new Error("service_id_or_duration_required");
  }

  /**
   * Vagas livres do profissional NESTA clínica no dia dado. Gera candidatas das janelas
   * (duração + buffer, back-to-back), subtrai holds vivos/confirmados e appointments do
   * vínculo, e descarta o passado (< nowISO). Nunca inventa (RN-PN-4).
   */
  static availableSlots(
    orgId: string, relationshipId: string, dateISO: string,
    opts?: { serviceId?: string; slotMinutes?: number; nowISO?: string; externalBusy?: Array<{ start: number; end: number }> },
  ): Slot[] {
    this.requireAcceptedRel(orgId, relationshipId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateISO || ""))) throw new Error("date_invalid");
    const duration = this.durationFor(orgId, relationshipId, opts?.serviceId, opts?.slotMinutes);
    const dow = dowOf(dateISO);
    const windows = ProfessionalScheduleConfigService.listWindows(orgId, relationshipId).filter((w) => w.active && w.dayOfWeek === dow);
    if (!windows.length) return [];

    // F6.2 — o busy do Google do profissional (buscado async pelo caller) entra como 3ª
    // fonte, além de holds e appointments: nunca OFERECE vaga em cima de compromisso do
    // Google. Sem conexão → externalBusy vazio → 0-regressão.
    // F5.1 — se a oferta EXIGE sala, a ocupação da sala (por qualquer atendimento da org)
    // é a 4ª fonte: não oferece vaga sem a sala livre.
    const busy = [
      ...this.busyIntervals(orgId, relationshipId, dateISO, opts?.nowISO),
      ...(Array.isArray(opts?.externalBusy) ? opts!.externalBusy! : []),
      ...this.requiredRoomBusy(orgId, relationshipId, dateISO, opts?.serviceId),
      ...this.crossClinicBusy(orgId, relationshipId, dateISO),        // F5.2 — deslocamento
    ];
    const nowMs = opts?.nowISO ? toMs(opts.nowISO) : Date.now();
    const out: Slot[] = [];
    for (const w of windows) {
      let t = w.startMinute;
      while (t + duration <= w.endMinute) {
        const startISO = isoAt(dateISO, t), endISO = isoAt(dateISO, t + duration);
        const s = toMs(startISO), e = toMs(endISO);
        const overlaps = busy.some((b) => e > b.start && s < b.end);
        if (!overlaps && s >= nowMs) out.push({ start: startISO, end: endISO, startMinute: t, durationMin: duration });
        t += duration + (w.bufferMin || 0);
      }
    }
    return out;
  }

  /** Intervalos ocupados do vínculo no dia: holds vivos/confirmados + appointments. */
  private static busyIntervals(orgId: string, relationshipId: string, dateISO: string, nowISO?: string): Array<{ start: number; end: number }> {
    const nowIso = nowISO || new Date().toISOString();
    const dayStart = `${dateISO}T00:00:00.000Z`, dayEnd = `${dateISO}T23:59:59.999Z`;
    const holds = db.prepare(`
      SELECT scheduled_start, scheduled_end FROM clinic_slot_holds
      WHERE organization_id = ? AND relationship_id = ?
        AND scheduled_start <= ? AND scheduled_end >= ?
        AND (status = 'confirmed' OR (status = 'active' AND (expires_at IS NULL OR expires_at > ?)))
    `).all(orgId, relationshipId, dayEnd, dayStart, nowIso) as any[];
    const appts = db.prepare(`
      SELECT scheduled_start, scheduled_end FROM appointments
      WHERE organization_id = ? AND network_relationship_id = ?
        AND status NOT IN ('cancelled','no_show')
        AND scheduled_start <= ? AND scheduled_start >= ?
    `).all(orgId, relationshipId, dayEnd, dayStart) as any[];
    const out: Array<{ start: number; end: number }> = [];
    for (const r of [...holds, ...appts]) {
      const s = toMs(r.scheduled_start); const e = r.scheduled_end ? toMs(r.scheduled_end) : s;
      if (Number.isFinite(s) && Number.isFinite(e)) out.push({ start: s, end: e });
    }
    return out;
  }

  /** Sala EXIGIDA pela oferta (serviço×vínculo), ou null. */
  static requiredRoomFor(orgId: string, relationshipId: string, serviceId?: string): string | null {
    if (!serviceId) return null;
    const off = ProfessionalScheduleConfigService.listOfferings(orgId, relationshipId).find((o) => o.serviceId === serviceId);
    return off?.requiredRoomId ?? null;
  }

  /**
   * F5.1 — intervalos em que a SALA EXIGIDA pela oferta está ocupada no dia (por QUALQUER
   * atendimento da org — federado ou local). Conservador (bloqueia se há sobreposição);
   * a capacidade real de sala compartilhada é reforçada no commit (confirmBooking). Vazio
   * se a oferta não exige sala (0-regressão).
   */
  private static requiredRoomBusy(orgId: string, relationshipId: string, dateISO: string, serviceId?: string): Array<{ start: number; end: number }> {
    const roomId = this.requiredRoomFor(orgId, relationshipId, serviceId);
    if (!roomId) return [];
    const dayStart = `${dateISO}T00:00:00.000Z`, dayEnd = `${dateISO}T23:59:59.999Z`;
    const rows = db.prepare(`
      SELECT scheduled_start, scheduled_end FROM appointments
      WHERE organization_id = ? AND room_id = ? AND status NOT IN ('cancelled','no_show')
        AND scheduled_start <= ? AND scheduled_start >= ?
    `).all(orgId, roomId, dayEnd, dayStart) as any[];
    const out: Array<{ start: number; end: number }> = [];
    for (const r of rows) {
      const s = toMs(r.scheduled_start); const e = r.scheduled_end ? toMs(r.scheduled_end) : s;
      if (Number.isFinite(s) && Number.isFinite(e)) out.push({ start: s, end: e });
    }
    return out;
  }

  /**
   * F5.2 — deslocamento entre clínicas. O profissional é GLOBAL; seus atendimentos
   * federados em OUTRAS clínicas o impedem de estar AQUI no mesmo horário. Se o vínculo
   * tem `travelBufferMin` configurado (opt-in; null = desligado, 0-regressão), devolve os
   * blocos de tempo desses atendimentos EXPANDIDOS pela margem de deslocamento de cada
   * lado. PRIVACIDADE (exceção mínima à RN-PN-2): só o intervalo {start,end} é lido —
   * nunca a clínica de origem nem detalhes do atendimento.
   */
  private static crossClinicBusy(orgId: string, relationshipId: string, dateISO: string): Array<{ start: number; end: number }> {
    const rel = ClinicProfessionalRelationshipService.get(orgId, relationshipId);
    if (!rel || rel.travelBufferMin == null) return [];              // feature off → 0-regressão
    const bufferMs = Math.max(0, Number(rel.travelBufferMin)) * 60000;
    const dayStart = toMs(`${dateISO}T00:00:00.000Z`), dayEnd = toMs(`${dateISO}T23:59:59.999Z`);
    const rows = db.prepare(`
      SELECT a.scheduled_start, a.scheduled_end
      FROM appointments a
      JOIN clinic_professional_relationships r ON r.id = a.network_relationship_id
      WHERE r.professional_id = ? AND a.organization_id != ?
        AND a.status NOT IN ('cancelled','no_show')
        AND a.scheduled_start <= ? AND a.scheduled_start >= ?
    `).all(rel.professionalId, orgId, new Date(dayEnd + bufferMs).toISOString(), new Date(dayStart - bufferMs).toISOString()) as any[];
    const out: Array<{ start: number; end: number }> = [];
    for (const r of rows) {
      const s = toMs(r.scheduled_start); const e = r.scheduled_end ? toMs(r.scheduled_end) : s;
      if (Number.isFinite(s) && Number.isFinite(e)) out.push({ start: s - bufferMs, end: e + bufferMs });
    }
    return out;
  }

  private static mapHold(r: any): Hold {
    return {
      id: r.id, relationshipId: r.relationship_id, professionalId: r.professional_id,
      serviceId: r.service_id ?? null, start: r.scheduled_start, end: r.scheduled_end,
      status: r.status, holdToken: r.hold_token, expiresAt: r.expires_at ?? null,
    };
  }

  static getHold(orgId: string, holdId: string): Hold | null {
    const r = db.prepare(`SELECT * FROM clinic_slot_holds WHERE organization_id = ? AND id = ?`).get(orgId, String(holdId || "")) as any;
    return r ? this.mapHold(r) : null;
  }

  /**
   * Segura uma vaga (hold temporário). ATÔMICO: dentro da transação re-checa que a vaga
   * segue livre (nenhum hold vivo/confirmado nem appointment sobrepõe) ANTES de inserir
   * — duas chamadas na mesma vaga: só a 1ª vence, a 2ª lança `slot_taken` (AC-012).
   */
  static hold(
    orgId: string, relationshipId: string,
    input: { serviceId?: string; startISO?: string; slotMinutes?: number; ttlMinutes?: number; nowISO?: string; token?: string },
    actorId?: string,
  ): Hold {
    const rel = this.requireAcceptedRel(orgId, relationshipId);
    const startISO = String(input.startISO || "");
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startISO)) throw new Error("start_invalid");
    const duration = this.durationFor(orgId, relationshipId, input.serviceId, input.slotMinutes);
    const startMs = toMs(startISO);
    if (!Number.isFinite(startMs)) throw new Error("start_invalid");
    const endMs = startMs + duration * 60000;
    const endISO = new Date(endMs).toISOString();

    // A vaga precisa cair dentro de uma janela ativa do dia (RN-PN-4: não inventa vaga).
    const dateISO = startISO.slice(0, 10);
    const startMinute = new Date(startISO).getUTCHours() * 60 + new Date(startISO).getUTCMinutes();
    const endMinute = startMinute + duration;
    const dow = dowOf(dateISO);
    const inWindow = ProfessionalScheduleConfigService.listWindows(orgId, relationshipId)
      .some((w) => w.active && w.dayOfWeek === dow && startMinute >= w.startMinute && endMinute <= w.endMinute);
    if (!inWindow) throw new Error("outside_working_window");

    const nowIso = input.nowISO || new Date().toISOString();
    const ttl = input.ttlMinutes == null ? 15 : Math.max(1, Math.round(input.ttlMinutes));
    const expiresAt = new Date(toMs(nowIso) + ttl * 60000).toISOString();
    const id = randomUUID();
    const token = input.token || randomUUID();

    const tx = db.transaction(() => {
      // Guarda atômica: conta sobreposições vivas ANTES de inserir.
      const clash = db.prepare(`
        SELECT COUNT(*) AS n FROM clinic_slot_holds
        WHERE organization_id = ? AND relationship_id = ?
          AND scheduled_start < ? AND scheduled_end > ?
          AND (status = 'confirmed' OR (status = 'active' AND (expires_at IS NULL OR expires_at > ?)))
      `).get(orgId, relationshipId, endISO, startISO, nowIso) as any;
      const apptClash = db.prepare(`
        SELECT COUNT(*) AS n FROM appointments
        WHERE organization_id = ? AND network_relationship_id = ?
          AND status NOT IN ('cancelled','no_show')
          AND scheduled_start < ? AND COALESCE(scheduled_end, scheduled_start) > ?
      `).get(orgId, relationshipId, endISO, startISO) as any;
      if ((clash?.n || 0) > 0 || (apptClash?.n || 0) > 0) throw new Error("slot_taken");
      db.prepare(`
        INSERT INTO clinic_slot_holds (id, organization_id, relationship_id, professional_id, service_id, scheduled_start, scheduled_end, status, hold_token, expires_at, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(id, orgId, relationshipId, rel.professionalId, input.serviceId || null, startISO, endISO, token, expiresAt, actorId || null);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", id, "PROF_SLOT_HOLD", { start: startISO }); } catch { /* noop */ }
    return this.getHold(orgId, id)!;
  }

  /**
   * Confirma um hold vivo (active + não expirado) → confirmed (vaga travada durável).
   * ATÔMICO: re-verifica dentro da tx que o hold ainda está active e não expirou.
   * Criar o appointment de fato é da F4 (confirmBooking governado).
   */
  static confirm(orgId: string, holdId: string, opts?: { nowISO?: string }, actorId?: string): Hold {
    const nowIso = opts?.nowISO || new Date().toISOString();
    const tx = db.transaction(() => {
      const r = db.prepare(`SELECT * FROM clinic_slot_holds WHERE organization_id = ? AND id = ?`).get(orgId, String(holdId || "")) as any;
      if (!r) throw new Error("hold_not_found");
      if (r.status === "confirmed") return; // idempotente
      if (r.status !== "active") throw new Error("hold_not_active");
      if (r.expires_at && r.expires_at <= nowIso) throw new Error("hold_expired");
      db.prepare(`UPDATE clinic_slot_holds SET status = 'confirmed', expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, holdId);
    });
    tx();
    try { logAuthEvent(orgId, actorId || "system", holdId, "PROF_SLOT_CONFIRM", {}); } catch { /* noop */ }
    return this.getHold(orgId, holdId)!;
  }

  /** Solta um hold (active/confirmed → released), liberando a vaga. */
  static release(orgId: string, holdId: string, actorId?: string): Hold {
    const r = db.prepare(`SELECT id, status FROM clinic_slot_holds WHERE organization_id = ? AND id = ?`).get(orgId, String(holdId || "")) as any;
    if (!r) throw new Error("hold_not_found");
    if (r.status !== "released") {
      db.prepare(`UPDATE clinic_slot_holds SET status = 'released', expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND id = ?`).run(orgId, holdId);
      try { logAuthEvent(orgId, actorId || "system", holdId, "PROF_SLOT_RELEASE", {}); } catch { /* noop */ }
    }
    return this.getHold(orgId, holdId)!;
  }

  /** Varre holds active vencidos → expired. Best-effort; F4 pluga no Scheduler. */
  static sweepExpired(orgId: string, nowISO?: string): { expired: number } {
    const nowIso = nowISO || new Date().toISOString();
    const res = db.prepare(`UPDATE clinic_slot_holds SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE organization_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).run(orgId, nowIso);
    return { expired: res.changes || 0 };
  }
}

export default ProfessionalAvailabilityService;
