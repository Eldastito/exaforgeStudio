/**
 * BeautyReceptionService (ADR-169 F34 / BEAUTY-035) — Painel da Recepção.
 *
 * A recepção do salão precisa, DE FORMA SIMPLES E RÁPIDA, de quatro coisas
 * (pedido do dono):
 *   1) buscar um cliente ANTES de cadastrar (saber se já existe — evita
 *      duplicar);
 *   2) buscar um PROFISSIONAL e ver os clientes agendados dele + se tem
 *      horário vago;
 *   3) ver TODOS os clientes agendados pro dia e, em TEMPO REAL, quem está
 *      sendo atendido e por quem;
 *   4) saber quais profissionais estão trabalhando no dia.
 *
 * Tudo isso é COMPOSIÇÃO do que já existe (§42 — nenhuma tabela nova): a
 * agenda canônica `appointments` (com `status`, `professional_id`,
 * `professional_name_snapshot`, `scheduled_start/end`), o roster
 * `clinic_professionals` (que a Beauty reusa desde a F4) e os `contacts`
 * (clientes). Read-mostly; a única escrita é `setStatus` (recepção move o
 * atendimento pelo funil: aguardando → em atendimento → finalizado), que
 * só toca o `status` de um appointment da PRÓPRIA org.
 *
 * "Trabalhando no dia" NÃO tem modelo de turno/ponto neste sistema — então é
 * DERIVADO honestamente: profissional ATIVO com ≥1 agendamento hoje (fora
 * cancelado/no_show) está "trabalhando"; os demais ativos aparecem como
 * disponíveis (sem agenda hoje). Não inventamos presença.
 *
 * Guardrails:
 *  - RN-BS-07 (isolamento cross-tenant duro): TODA query filtra
 *    `organization_id`.
 *  - RN-BS-08 (dinheiro role-gated): este painel NÃO devolve valores
 *    monetários — só nome do cliente, serviço, profissional, horário e
 *    status. A rota role-gateia se algum dia expuser R$.
 *  - Horário em America/Sao_Paulo (mesma convenção do AppointmentService).
 */
import db from "./db.js";
import { AppointmentService } from "./AppointmentService.js";

// Status canônico do appointment → rótulo pt-BR + estágio do funil da recepção.
// (a coluna `appointments.status` já usa pending/confirmed/in_progress/
// completed/cancelled/no_show — não inventamos vocabulário novo.)
const STATUS_LABEL: Record<string, string> = {
  pending: "Agendado",
  confirmed: "Confirmado",
  in_progress: "Em atendimento",
  completed: "Finalizado",
  cancelled: "Cancelado",
  no_show: "Não compareceu",
};

// Transições que a recepção pode fazer pelo painel (o resto é da agenda/fluxo).
const RECEPTION_STATUSES = new Set(["confirmed", "in_progress", "completed", "no_show", "pending"]);

export interface ReceptionAppointment {
  id: string;
  startTime: string | null;   // "HH:MM" local
  endTime: string | null;
  startMs: number | null;
  clientId: string | null;
  clientName: string;
  serviceName: string | null;
  professionalId: string | null;
  professionalName: string | null;
  status: string;
  statusLabel: string;
}

export interface ReceptionProfessional {
  id: string;
  name: string;
  specialty: string | null;
  color: string | null;
  working: boolean;           // tem ≥1 agendamento hoje
  bookedToday: number;        // qtd de agendamentos hoje (fora cancelado/no_show)
  serving: ReceptionAppointment | null; // atendimento em curso agora
}

export class BeautyReceptionService {
  // ── Q1: buscar cliente antes de cadastrar (dedupe) ──────────────────────
  /**
   * Busca contatos por nome OU telefone (LIKE, case-insensitive). Devolve no
   * máx. `limit`. Sem `q` → devolve os mais recentes (pra a recepção ver a
   * base). Marca `hasProfile` se já tem ficha capilar (F25).
   */
  static searchClients(orgId: string, q: string, limit = 15): Array<{ id: string; name: string; phone: string | null; hasProfile: boolean }> {
    const lim = Math.max(1, Math.min(50, limit));
    const term = String(q || "").trim();
    let rows: any[];
    if (term) {
      const like = `%${term.replace(/[%_]/g, (m) => "\\" + m)}%`;
      rows = db.prepare(
        `SELECT c.id, c.name, c.identifier,
                (SELECT 1 FROM beauty_client_profiles p WHERE p.organization_id = c.organization_id AND p.contact_id = c.id) AS has_profile
           FROM contacts c
          WHERE c.organization_id = ?
            AND (c.name LIKE ? ESCAPE '\\' OR c.identifier LIKE ? ESCAPE '\\')
          ORDER BY COALESCE(c.name, c.identifier) COLLATE NOCASE ASC
          LIMIT ?`,
      ).all(orgId, like, like, lim) as any[];
    } else {
      rows = db.prepare(
        `SELECT c.id, c.name, c.identifier,
                (SELECT 1 FROM beauty_client_profiles p WHERE p.organization_id = c.organization_id AND p.contact_id = c.id) AS has_profile
           FROM contacts c
          WHERE c.organization_id = ?
          ORDER BY c.created_at DESC
          LIMIT ?`,
      ).all(orgId, lim) as any[];
    }
    return rows.map((r) => ({ id: r.id, name: r.name || "Sem nome", phone: r.identifier || null, hasProfile: !!r.has_profile }));
  }

  // ── Janela do dia (America/Sao_Paulo) em epoch ms ───────────────────────
  /** Início/fim do dia local pra uma data "YYYY-MM-DD" (default: hoje). */
  private static dayRange(dateISO?: string): { startMs: number; endMs: number; dateISO: string } {
    // Usa o "agora" em SP pra achar o dia corrente; a data explícita é opcional.
    const nowSp = new Date(Date.now() - 3 * 3600_000); // BRT = UTC-3 (sem DST desde 2019)
    const y = nowSp.getUTCFullYear(), mo = nowSp.getUTCMonth(), da = nowSp.getUTCDate();
    let base: { y: number; mo: number; da: number };
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateISO || "").trim());
    if (m) base = { y: +m[1], mo: +m[2] - 1, da: +m[3] };
    else base = { y, mo, da };
    // 00:00 local = 03:00 UTC (UTC-3).
    const startMs = Date.UTC(base.y, base.mo, base.da, 3, 0, 0, 0);
    const endMs = startMs + 24 * 3600_000;
    const iso = `${base.y.toString().padStart(4, "0")}-${(base.mo + 1).toString().padStart(2, "0")}-${base.da.toString().padStart(2, "0")}`;
    return { startMs, endMs, dateISO: iso };
  }

  private static hhmm(ms: number | null): string | null {
    if (ms == null) return null;
    const d = new Date(ms - 3 * 3600_000); // exibe em BRT
    return `${d.getUTCHours().toString().padStart(2, "0")}:${d.getUTCMinutes().toString().padStart(2, "0")}`;
  }

  private static rowToAppt(r: any): ReceptionAppointment {
    const startMs = AppointmentService.ms(r.scheduled_start);
    const endMs = AppointmentService.ms(r.scheduled_end);
    return {
      id: r.id,
      startMs,
      startTime: this.hhmm(startMs),
      endTime: this.hhmm(endMs),
      clientId: r.contact_id || null,
      clientName: r.client_name || "Sem nome",
      serviceName: r.title || null,
      professionalId: r.professional_id || null,
      professionalName: r.professional_name_snapshot || r.prof_name || null,
      status: r.status || "pending",
      statusLabel: STATUS_LABEL[r.status] || r.status || "—",
    };
  }

  /** Appointments do dia (todos os status menos cancelled), ordenados por horário. */
  private static appointmentsForDay(orgId: string, startMs: number, endMs: number, professionalId?: string): ReceptionAppointment[] {
    const startIso = new Date(startMs).toISOString();
    const endIso = new Date(endMs).toISOString();
    const rows = db.prepare(
      `SELECT a.id, a.contact_id, a.title, a.scheduled_start, a.scheduled_end, a.status,
              a.professional_id, a.professional_name_snapshot,
              ct.name AS client_name, p.name AS prof_name
         FROM appointments a
         LEFT JOIN contacts ct ON ct.id = a.contact_id AND ct.organization_id = a.organization_id
         LEFT JOIN clinic_professionals p ON p.id = a.professional_id AND p.organization_id = a.organization_id
        WHERE a.organization_id = ?
          AND a.status != 'cancelled'
          AND a.scheduled_start >= ? AND a.scheduled_start < ?
          ${professionalId ? "AND a.professional_id = ?" : ""}
        ORDER BY a.scheduled_start ASC`,
    ).all(...(professionalId ? [orgId, startIso, endIso, professionalId] : [orgId, startIso, endIso])) as any[];
    return rows.map((r) => this.rowToAppt(r));
  }

  // ── Q3 + Q4: painel do dia ──────────────────────────────────────────────
  /**
   * Quadro do dia: a agenda completa + quem está em atendimento AGORA + os
   * profissionais (marcando quem está trabalhando hoje e o que atende agora).
   */
  static dayBoard(orgId: string, dateISO?: string): {
    date: string;
    appointments: ReceptionAppointment[];
    nowServing: ReceptionAppointment[];
    professionals: ReceptionProfessional[];
    counts: { total: number; waiting: number; inProgress: number; done: number; noShow: number };
  } {
    const { startMs, endMs, dateISO: date } = this.dayRange(dateISO);
    const appts = this.appointmentsForDay(orgId, startMs, endMs);
    const nowServing = appts.filter((a) => a.status === "in_progress");

    // Roster ativo + agregação por profissional.
    const pros = db.prepare(
      `SELECT id, name, specialty, color FROM clinic_professionals
        WHERE organization_id = ? AND active = 1 ORDER BY name COLLATE NOCASE ASC`,
    ).all(orgId) as any[];
    const byPro = new Map<string, ReceptionAppointment[]>();
    for (const a of appts) {
      if (!a.professionalId) continue;
      (byPro.get(a.professionalId) || byPro.set(a.professionalId, []).get(a.professionalId)!).push(a);
    }
    const professionals: ReceptionProfessional[] = pros.map((p) => {
      const list = byPro.get(p.id) || [];
      const booked = list.filter((a) => a.status !== "no_show").length;
      return {
        id: p.id, name: p.name, specialty: p.specialty || null, color: p.color || null,
        working: booked > 0,
        bookedToday: booked,
        serving: list.find((a) => a.status === "in_progress") || null,
      };
    });

    const counts = {
      total: appts.length,
      waiting: appts.filter((a) => a.status === "pending" || a.status === "confirmed").length,
      inProgress: nowServing.length,
      done: appts.filter((a) => a.status === "completed").length,
      noShow: appts.filter((a) => a.status === "no_show").length,
    };
    return { date, appointments: appts, nowServing, professionals, counts };
  }

  // ── Q2: buscar profissional → clientes do dia + horários vagos ──────────
  /**
   * Dia de um profissional: os agendamentos dele + os horários VAGOS na
   * agenda do salão (config open/close/slot da org) que ele ainda não ocupou.
   */
  static professionalDay(orgId: string, professionalId: string, dateISO?: string): {
    professional: { id: string; name: string; specialty: string | null } | null;
    appointments: ReceptionAppointment[];
    freeSlots: string[]; // "HH:MM"
  } {
    const prof = db.prepare(
      `SELECT id, name, specialty FROM clinic_professionals WHERE id = ? AND organization_id = ? AND active = 1`,
    ).get(professionalId, orgId) as any;
    if (!prof) return { professional: null, appointments: [], freeSlots: [] };

    const { startMs, endMs } = this.dayRange(dateISO);
    const appts = this.appointmentsForDay(orgId, startMs, endMs, professionalId);

    // Slots livres: varre a grade (openHour..closeHour, passo slotMin) do dia e
    // remove os que colidem com um agendamento vivo do profissional. Só slots
    // futuros quando o dia é HOJE (não oferece horário que já passou).
    const cfg = AppointmentService.config(orgId);
    const busy = appts
      .filter((a) => a.status !== "no_show" && a.startMs != null)
      .map((a) => ({ s: a.startMs as number, e: (a.startMs as number) + (cfg.slotMin * 60000) }));
    const nowMs = Date.now();
    const freeSlots: string[] = [];
    const slotMs = cfg.slotMin * 60000;
    // A grade parte de startMs + openHour (em BRT, ou seja +openHour horas).
    for (let t = startMs + cfg.openHour * 3600_000; t + slotMs <= startMs + cfg.closeHour * 3600_000; t += slotMs) {
      if (t < nowMs) continue; // não oferece passado
      const clash = busy.some((b) => t < b.e && t + slotMs > b.s);
      if (!clash) freeSlots.push(this.hhmm(t)!);
    }
    return {
      professional: { id: prof.id, name: prof.name, specialty: prof.specialty || null },
      appointments: appts,
      freeSlots,
    };
  }

  // ── Escrita: mover o atendimento pelo funil (tempo real) ────────────────
  /**
   * Recepção marca o estágio do atendimento (chegou/confirmado → em
   * atendimento → finalizado). Só transita status permitido, só na própria
   * org, e nunca "ressuscita" cancelado (esse é do fluxo de agenda).
   */
  static setStatus(orgId: string, appointmentId: string, status: string): { ok: true; status: string } | { ok: false; error: string } {
    const s = String(status || "").trim();
    if (!RECEPTION_STATUSES.has(s)) return { ok: false, error: `Status inválido: ${s}` };
    const cur = db.prepare(
      `SELECT status FROM appointments WHERE id = ? AND organization_id = ?`,
    ).get(appointmentId, orgId) as any;
    if (!cur) return { ok: false, error: "Agendamento não encontrado." };
    if (cur.status === "cancelled") return { ok: false, error: "Agendamento cancelado — reabra pela agenda." };
    db.prepare(
      `UPDATE appointments SET status = ? WHERE id = ? AND organization_id = ?`,
    ).run(s, appointmentId, orgId);
    return { ok: true, status: s };
  }
}

export default BeautyReceptionService;
